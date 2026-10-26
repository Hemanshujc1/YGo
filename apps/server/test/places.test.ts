import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { createLocalClock } from "../src/adapters/clock";
import { createLocalMailer } from "../src/adapters/mailer";
import { createGooglePlaceFinder, type PlaceFinder } from "../src/adapters/place-finder";
import { buildApp } from "../src/app";
import { connectDatabase } from "../src/db";

const session = "00000000-0000-4000-8000-000000000401";
const baner = { id: "ChIJ-baner_1", title: "Baner Road", detail: "Baner, Pune, Maharashtra" };
const point = { latitude: 18.559, longitude: 73.7868 };

describe("Google place finder", () => {
  /** A fetch that records each call and answers with the given status and body. */
  function fakeFetch(status: number, body: unknown) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
    return { calls, fetcher };
  }
  const prediction = (placeId: string, main: string, secondary?: string) => ({
    placePrediction: { placeId, structuredFormat: { mainText: { text: main }, ...(secondary && { secondaryText: { text: secondary } }) } },
  });

  it("searches India only with the session, and keeps 5 matches with a usable, unrepeated id and a name", async () => {
    const { calls, fetcher } = fakeFetch(200, {
      suggestions: [
        prediction(baner.id, baner.title, baner.detail),
        prediction("bad/id", "Bad"),
        { placePrediction: { placeId: "ChIJ-noname" } },
        prediction("ChIJ-2", "Baner Gaon"),
        prediction(baner.id, "Baner Road again"),
        ...["3", "4", "5", "6"].map((n) => prediction(`ChIJ-${n}`, `Place ${n}`, "Pune")),
      ],
    });
    const matches = await createGooglePlaceFinder("key-1", fetcher).search("Baner", session);
    expect(matches).toEqual([
      baner,
      { id: "ChIJ-2", title: "Baner Gaon", detail: "" },
      { id: "ChIJ-3", title: "Place 3", detail: "Pune" },
      { id: "ChIJ-4", title: "Place 4", detail: "Pune" },
      { id: "ChIJ-5", title: "Place 5", detail: "Pune" },
    ]);
    const [call] = calls;
    expect(call?.url).toBe("https://places.googleapis.com/v1/places:autocomplete");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.headers).toMatchObject({ "Content-Type": "application/json", "X-Goog-Api-Key": "key-1" });
    expect(JSON.parse(String(call?.init.body))).toEqual({ input: "Baner", sessionToken: session, includedRegionCodes: ["in"], languageCode: "en" });
  });

  it("answers no matches when Google has none", async () => {
    expect(await createGooglePlaceFinder("key-1", fakeFetch(200, {}).fetcher).search("zzz", session)).toEqual([]);
  });

  it("asks only for the location, with the session that ends the search", async () => {
    const { calls, fetcher } = fakeFetch(200, { location: point });
    expect(await createGooglePlaceFinder("key-1", fetcher).point(baner.id, session)).toEqual(point);
    expect(calls[0]?.url).toBe(`https://places.googleapis.com/v1/places/${baner.id}?sessionToken=${session}`);
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.headers).toEqual({ "X-Goog-Api-Key": "key-1", "X-Goog-FieldMask": "location" });
  });

  it("answers null for a place Google no longer knows, and rejects when Google fails or refuses the call", async () => {
    expect(await createGooglePlaceFinder("key-1", fakeFetch(404, {}).fetcher).point(baner.id, session)).toBeNull();
    expect(await createGooglePlaceFinder("key-1", fakeFetch(200, {}).fetcher).point(baner.id, session)).toBeNull();
    await expect(createGooglePlaceFinder("key-1", fakeFetch(400, {}).fetcher).point(baner.id, session)).rejects.toThrow("400");
    await expect(createGooglePlaceFinder("key-1", fakeFetch(500, {}).fetcher).point(baner.id, session)).rejects.toThrow("500");
    await expect(createGooglePlaceFinder("key-1", fakeFetch(403, {}).fetcher).search("Baner", session)).rejects.toThrow("403");
  });
});

const rootUrl = inject("databaseUrl");
const secret = "01234567890123456789012345678901";
const clock = createLocalClock(new Date("2030-01-01T00:00:00.000Z"));
const mailer = createLocalMailer();
let name: string;
let database: ReturnType<typeof connectDatabase>;
let app: ReturnType<typeof buildApp>;

/** A stand-in for Google that records what it was asked. */
const asked: string[] = [];
let answer: { matches: (typeof baner)[]; point: typeof point | null; fails: boolean };
const places: PlaceFinder = {
  async search(text, given) {
    asked.push(`search ${text} ${given}`);
    if (answer.fails) throw new Error("Places search answered 500");
    return answer.matches;
  },
  async point(id, given) {
    asked.push(`point ${id} ${given}`);
    if (answer.fails) throw new Error("Places point answered 500");
    return answer.point;
  },
};

beforeEach(async () => {
  name = `ygo_places_${randomUUID().replaceAll("-", "")}`;
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
  asked.length = 0;
  answer = { matches: [baner], point, fails: false };
  app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret, places });
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

/** Signs a Customer in on the phone; answers their request headers. */
async function customer(email: string) {
  await app.inject({ method: "POST", url: "/v1/auth/code", payload: { email } });
  const code = mailer.sent.findLast((sent) => sent.to === email)?.text.match(/code is (\d{6})/)?.[1] ?? "";
  const signed = (await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { email, code } })).json();
  clock.advance(1_000);
  return { authorization: `Bearer ${signed.accessToken as string}` };
}

const search = (headers: Record<string, string>, text = "Baner") =>
  app.inject({ method: "GET", url: `/v1/places?${new URLSearchParams({ text, session })}`, headers });
const pick = (headers: Record<string, string>, id = baner.id) =>
  app.inject({ method: "GET", url: `/v1/places/point?${new URLSearchParams({ id, session })}`, headers });

describe("place search", () => {
  it("refuses signed-out callers", async () => {
    expect((await search({})).statusCode).toBe(401);
    expect((await pick({})).statusCode).toBe(401);
    expect(asked).toEqual([]);
  });

  it("searches with the trimmed text and the session, and answers a picked place's point", async () => {
    const headers = await customer("asha@example.com");
    const found = await search(headers, "  Baner  ");
    expect(found.statusCode).toBe(200);
    expect(found.json()).toEqual({ matches: [baner] });
    const picked = await pick(headers, "Ei" + "x".repeat(150));
    expect(picked.statusCode).toBe(200);
    expect(picked.json()).toEqual({ point });
    expect(asked).toEqual([`search Baner ${session}`, `point Ei${"x".repeat(150)} ${session}`]);
  });

  it("refuses a bad text, session or id before asking Google", async () => {
    const headers = await customer("asha@example.com");
    expect((await search(headers, "Baner\u0000")).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/v1/places?text=Baner&session=s1", headers })).statusCode).toBe(400);
    expect((await pick(headers, "a/b")).statusCode).toBe(400);
    expect(asked).toEqual([]);
  });

  it("answers NOT_FOUND for a place Google lost or one outside India", async () => {
    const headers = await customer("asha@example.com");
    answer.point = null;
    expect((await pick(headers)).json()).toEqual({ error: { code: "NOT_FOUND" } });
    answer.point = { latitude: 51.5, longitude: -0.12 };
    expect((await pick(headers)).statusCode).toBe(404);
  });

  it("answers UNAVAILABLE when Google fails, or when no key is set", async () => {
    const headers = await customer("asha@example.com");
    answer.fails = true;
    expect((await search(headers)).json()).toEqual({ error: { code: "UNAVAILABLE" } });
    expect((await pick(headers)).statusCode).toBe(503);

    await app.close();
    app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret });
    const signedIn = await customer("ravi@example.com");
    expect((await search(signedIn)).statusCode).toBe(503);
    expect((await pick(signedIn)).statusCode).toBe(503);
  });

  it("allows 30 searches and 30 picks an hour per account, each counted on its own", async () => {
    const asha = await customer("asha@example.com");
    for (let n = 0; n < 30; n++) expect((await search(asha)).statusCode).toBe(200);
    expect((await search(asha)).json()).toEqual({ error: { code: "TOO_MANY_REQUESTS" } });
    expect((await pick(asha)).statusCode).toBe(200);
    expect((await search(await customer("ravi@example.com"))).statusCode).toBe(200);

    for (let n = 1; n < 30; n++) expect((await pick(asha)).statusCode).toBe(200);
    expect((await pick(asha)).statusCode).toBe(429);

    // An hour on, the access token has expired too, so Asha signs in again.
    clock.advance(60 * 60 * 1000);
    const later = await customer("asha@example.com");
    expect((await search(later)).statusCode).toBe(200);
    expect((await pick(later)).statusCode).toBe(200);
  });
});
