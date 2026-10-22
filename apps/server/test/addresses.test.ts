import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { createLocalClock } from "../src/adapters/clock";
import { createLocalMailer } from "../src/adapters/mailer";
import { buildApp } from "../src/app";
import { connectDatabase } from "../src/db";

const rootUrl = inject("databaseUrl");
const secret = "01234567890123456789012345678901";
const clock = createLocalClock(new Date("2030-01-01T00:00:00.000Z"));
const mailer = createLocalMailer();
let name: string;
let database: ReturnType<typeof connectDatabase>;
let app: ReturnType<typeof buildApp>;

beforeEach(async () => {
  name = `ygo_addresses_${randomUUID().replaceAll("-", "")}`;
  const root = new pg.Client({ connectionString: rootUrl });
  await root.connect();
  try { await root.query(`CREATE DATABASE ${name}`); } finally { await root.end(); }
  const url = new URL(rootUrl);
  url.pathname = `/${name}`;
  const migrationClient = new pg.Client({ connectionString: url.href });
  try {
    await migrationClient.connect();
    await migrate(drizzle({ client: migrationClient }), {
      migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
    });
  } finally { await migrationClient.end(); }
  database = connectDatabase(url.href);
  clock.set(new Date("2030-01-01T00:00:00.000Z"));
  mailer.sent.length = 0;
  app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret });
});

afterEach(async () => {
  await app.close();
  await database.close();
  const root = new pg.Client({ connectionString: rootUrl });
  try {
    await root.connect();
    await root.query(`DROP DATABASE ${name} WITH (FORCE)`);
  } finally { await root.end(); }
});

/** Signs a Customer in; answers their account id and request headers. */
async function customer(email: string) {
  await app.inject({ method: "POST", url: "/v1/auth/code", payload: { email } });
  const code = mailer.sent.findLast((sent) => sent.to === email)?.text.match(/code is (\d{6})/)?.[1] ?? "";
  const signed = (await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { email, code } })).json();
  clock.advance(1_000);
  return { id: signed.account.id as string, headers: { authorization: `Bearer ${signed.accessToken as string}` } };
}

const home = {
  label: "home",
  flat: "Flat 4B, Sai Heights",
  areaLine: "Baner Road, Baner",
  pincode: "411045",
  point: { latitude: 18.559, longitude: 73.7868 },
};
type Body = Omit<typeof home, "label" | "point" | "areaLine"> & {
  label: string;
  areaLine: string | null;
  point: { latitude: number; longitude: number } | null;
};

describe("saved addresses", () => {
  const save = (headers: Record<string, string>, body: Body) => {
    clock.advance(1_000);
    return app.inject({ method: "POST", url: "/v1/me/addresses", headers, payload: body });
  };
  const list = async (headers: Record<string, string>) =>
    (await app.inject({ method: "GET", url: "/v1/me/addresses", headers })).json().addresses as (Body & { id: string })[];
  const remove = (headers: Record<string, string>, id: string) =>
    app.inject({ method: "DELETE", url: `/v1/me/addresses/${id}`, headers });

  it("refuses signed-out callers", async () => {
    const id = randomUUID();
    for (const request of [
      { method: "GET" as const, url: "/v1/me/addresses" },
      { method: "POST" as const, url: "/v1/me/addresses", payload: home },
      { method: "DELETE" as const, url: `/v1/me/addresses/${id}` },
    ]) expect((await app.inject(request)).statusCode).toBe(401);
  });

  it("saves, lists newest first and removes", async () => {
    const { headers } = await customer("asha@example.com");
    expect(await list(headers)).toEqual([]);
    const first = await save(headers, { ...home, flat: " Flat 4B, Sai Heights ", pincode: "411 045" });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual({ ...home, id: expect.any(String) });
    const pinless = await save(headers, { ...home, label: "other", areaLine: null, point: null });
    expect(pinless.json()).toEqual({ ...home, label: "other", areaLine: null, point: null, id: expect.any(String) });
    expect(await list(headers)).toEqual([pinless.json(), first.json()]);

    expect((await remove(headers, first.json().id)).statusCode).toBe(204);
    expect(await list(headers)).toEqual([pinless.json()]);
    expect((await remove(headers, first.json().id)).json()).toEqual({ error: { code: "NOT_FOUND" } });
  });

  it("refuses a pin outside India, a missing flat and a bad pincode", async () => {
    const { headers } = await customer("asha@example.com");
    const refused = await save(headers, { ...home, flat: " ", pincode: "011045", point: { latitude: 0, longitude: 0 } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.fields).toEqual(["flat", "pincode", "point.latitude", "point.longitude"]);
    expect(await list(headers)).toEqual([]);
  });

  it("replaces Home with a new Home and Work with a new Work, and keeps every Other", async () => {
    const { headers } = await customer("asha@example.com");
    await save(headers, home);
    const work = (await save(headers, { ...home, label: "work", flat: "Office 12" })).json();
    const others = [(await save(headers, { ...home, label: "other", flat: "Gym" })).json(), (await save(headers, { ...home, label: "other", flat: "Gym" })).json()];
    const newHome = (await save(headers, { ...home, flat: "Flat 9A" })).json();
    expect(await list(headers)).toEqual([newHome, ...others.reverse(), work]);
  });

  it("keeps at most 10, though a new Home still replaces the old one", async () => {
    const { headers } = await customer("asha@example.com");
    expect((await save(headers, home)).statusCode).toBe(201);
    for (let n = 1; n < 10; n += 1) expect((await save(headers, { ...home, label: "other", flat: `Flat ${n}` })).statusCode).toBe(201);
    expect((await save(headers, { ...home, label: "other" })).json()).toEqual({ error: { code: "ADDRESS_LIMIT_REACHED" } });
    expect((await save(headers, { ...home, label: "work" })).statusCode).toBe(409);
    expect((await save(headers, { ...home, flat: "Flat 9A" })).statusCode).toBe(201);
    expect(await list(headers)).toHaveLength(10);
  });

  it("lets only one of several saves at once take the last place", async () => {
    const { headers } = await customer("asha@example.com");
    for (let n = 0; n < 9; n += 1) await save(headers, { ...home, label: "other", flat: `Flat ${n}` });
    // Hold back every insert until all five saves are waiting, so they overlap.
    const blocker = await database.pool.connect();
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE saved_addresses IN SHARE MODE");
    const pending = Promise.all(Array.from({ length: 5 }, () => save(headers, { ...home, label: "other" })));
    // Outside the blocker's transaction, which would see one fixed snapshot of the activity.
    const waiting = () => database.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
    );
    for (let tries = 0; ((await waiting()).rows[0]?.n ?? 0) < 5; tries += 1) {
      if (tries === 100) throw new Error("the five saves never all waited on the lock");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await blocker.query("COMMIT");
    blocker.release();
    const racing = await pending;
    expect(racing.map((result) => result.statusCode).sort()).toEqual([201, 409, 409, 409, 409]);
    expect(await list(headers)).toHaveLength(10);
  });

  it("keeps each account's addresses to itself and deletes them with the account", async () => {
    const asha = await customer("asha@example.com");
    const ravi = await customer("ravi@example.com");
    const saved = (await save(asha.headers, home)).json();
    await save(ravi.headers, home);
    expect(await list(ravi.headers)).toEqual([expect.objectContaining({ label: "home" })]);
    expect((await list(ravi.headers))[0]?.id).not.toBe(saved.id);
    expect((await remove(ravi.headers, saved.id)).statusCode).toBe(404);
    expect(await list(asha.headers)).toEqual([saved]);

    await database.pool.query("DELETE FROM accounts WHERE id = $1", [asha.id]);
    expect((await database.pool.query("SELECT 1 FROM saved_addresses WHERE account_id = $1", [asha.id])).rowCount).toBe(0);
  });
});
