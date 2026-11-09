import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { createLocalClock } from "../src/adapters/clock";
import { createLocalMailer } from "../src/adapters/mailer";
import { buildApp } from "../src/app";
import { bootstrapAdmin } from "../src/bootstrap";
import { connectDatabase } from "../src/db";
import { notifyShopOwner } from "../src/notifications";
import { createTestDatabase } from "./test-database";

const rootUrl = inject("databaseUrl");
const secret = "01234567890123456789012345678901";
const adminEmail = "admin@example.com";
const clock = createLocalClock(new Date("2030-01-01T00:00:00.000Z"));
const mailer = createLocalMailer();
let name: string;
let database: ReturnType<typeof connectDatabase>;
let app: ReturnType<typeof buildApp>;
let admin: { authorization: string };

beforeEach(async () => {
  name = `ygo_discount_${randomUUID().replaceAll("-", "")}`;
  const url = await createTestDatabase(name);
  database = connectDatabase(url.href);
  await bootstrapAdmin(database.pool, { email: adminEmail, name: "Ravi Admin", phone: "+919812345678" });
  clock.set(new Date("2030-01-01T00:00:00.000Z"));
  mailer.sent.length = 0;
  app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret, shopDiscountsAvailable: true });
  await app.inject({ method: "POST", url: "/v1/admin/auth/code", payload: { email: adminEmail } });
  const code = mailer.sent.findLast((sent) => sent.to === adminEmail)?.text.match(/code is (\d{6})/)?.[1];
  const signed = await app.inject({ method: "POST", url: "/v1/admin/auth/verify", payload: { email: adminEmail, code } });
  admin = { authorization: `Bearer ${signed.json().accessToken as string}` };
});

afterEach(async () => {
  await app.close();
  await database.close();
  const root = new pg.Client({ connectionString: rootUrl });
  try { await root.connect(); await root.query(`DROP DATABASE ${name} WITH (FORCE)`); } finally { await root.end(); }
});

async function signIn(email: string) {
  await app.inject({ method: "POST", url: "/v1/auth/code", payload: { email } });
  const code = mailer.sent.findLast((sent) => sent.to === email)?.text.match(/code is (\d{6})/)?.[1];
  const signed = (await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { email, code } })).json();
  return { id: signed.account.id as string, headers: { authorization: `Bearer ${signed.accessToken as string}` } };
}

/** A Live shop 300 m north of the Customer, in its own Area, with its Owner signed in. */
async function shop(state = "live", email = "owner@example.com") {
  const owner = await signIn(email);
  const shopId = randomUUID();
  await database.pool.query(
    `INSERT INTO shops (id, state, shop_name, address, pincode, location, owner_name, entity_type, pan,
       fssai_number, fssai_expiry, upi_id, service_radius_metres, submitted_at, created_at)
     VALUES ($1, $2, 'Sai General Stores', 'Paud Road', '411045', ST_Project(ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography, 300::float8, 0::float8)::geography,
       'Asha', 'proprietorship', 'ABCDE1234F', '11223344556677', '2099-01-01', 'asha@upi', 2000, now(), now())`, [shopId, state]);
  await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) VALUES ($1, $2, 'owner')", [owner.id, shopId]);
  return { ...owner, shopId };
}

async function staffOf(shopId: string) {
  const staff = await signIn("staff@example.com");
  await database.pool.query("INSERT INTO shop_members (account_id, shop_id, role) VALUES ($1, $2, 'staff')", [staff.id, shopId]);
  return staff;
}

const publish = (scope: object, values: object) =>
  app.inject({ method: "POST", url: "/v1/admin/rate-cards/publish", headers: admin, payload: { scope, values, reason: "Pilot card" } });
const card = {
  // The configured default base (CONTEXT.md, Pricing engine): commission after the shop-funded discount.
  commission: { formula: "percentage", fixedAmount: null, percentage: "10", minimum: null, maximum: null, base: "after_shop_discount" },
  deliveryFee: { amount: "30", split: { platformPercentage: "20", shopPercentage: "80" } },
  deliveredContributionFloor: "15", minimumCart: "100", statementGraceDays: 7,
};
const get = (headers: Record<string, string>) => app.inject({ method: "GET", url: "/v1/me/shop-discount", headers });
const put = (headers: Record<string, string>, body: object) => app.inject({ method: "PUT", url: "/v1/me/shop-discount", headers, payload: body });
const percentage = (value: string, cap: string | null = null, active = true) => ({ form: "percentage", percentage: value, cap, active });
const flat = (amount: string, minimumOrder: string, active = true) => ({ form: "flat", amount, minimumOrder, active });
const rules = async () => (await database.pool.query("SELECT * FROM shop_discounts")).rows;
const versions = async () => (await database.pool.query("SELECT version, status, actor_id FROM shop_discount_versions ORDER BY version")).rows;

describe("The Owner's shop-wide discount (#63, MNY-5)", () => {
  it("starts with no rule, saves one, keeps every version and does not bump an unchanged save", async () => {
    const owner = await shop();
    expect((await get(owner.headers)).json()).toEqual({ rule: null, maximumPercentage: "20", available: true });

    const saved = await put(owner.headers, percentage("10", "20"));
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({
      rule: { id: expect.any(String), version: 1, form: "percentage", percentage: "10", cap: "20", amount: null, minimumOrder: null, status: "active" },
      maximumPercentage: "20", available: true,
    });
    expect((await get(owner.headers)).json()).toEqual(saved.json());
    // The same save again, as a retry, is the same version.
    expect((await put(owner.headers, percentage("10", "20"))).json().rule.version).toBe(1);

    const edited = await put(owner.headers, flat("200", "1000"));
    expect(edited.json().rule).toMatchObject({ version: 2, form: "flat", percentage: null, cap: null, amount: "200", minimumOrder: "1000", status: "active" });
    expect((await put(owner.headers, flat("200", "1000", false))).json().rule).toMatchObject({ version: 3, status: "off" });
    expect(await versions()).toEqual([
      { version: 1, status: "active", actor_id: owner.id }, { version: 2, status: "active", actor_id: owner.id }, { version: 3, status: "off", actor_id: owner.id },
    ]);
    expect(await rules()).toHaveLength(1);
  });

  it("cannot be turned on until customers can see it (#571), but can be saved off", async () => {
    const owner = await shop();
    const gated = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret });
    try {
      const read = await gated.inject({ method: "GET", url: "/v1/me/shop-discount", headers: owner.headers });
      expect(read.json()).toEqual({ rule: null, maximumPercentage: "20", available: false });
      const on = await gated.inject({ method: "PUT", url: "/v1/me/shop-discount", headers: owner.headers, payload: percentage("10") });
      expect(on.statusCode).toBe(409);
      expect(on.json()).toEqual({ error: { code: "DISCOUNT_NOT_AVAILABLE" } });
      expect(await rules()).toHaveLength(0);
      const off = await gated.inject({ method: "PUT", url: "/v1/me/shop-discount", headers: owner.headers, payload: percentage("10", null, false) });
      expect(off.statusCode).toBe(200);
      expect(off.json()).toMatchObject({ rule: { status: "off" }, available: false });
    } finally { await gated.close(); }
  });

  it("never changes or removes a version an order may name", async () => {
    const owner = await shop();
    await put(owner.headers, percentage("10"));
    const refused = [
      "UPDATE shop_discount_versions SET percentage = 1",
      "DELETE FROM shop_discount_versions",
      "TRUNCATE shop_discount_versions CASCADE",
      // Wiping the rule table cascades into its versions, and is refused by the same trigger.
      "TRUNCATE shop_discounts CASCADE",
      // A retried insert that tries to overwrite a version on conflict.
      `INSERT INTO shop_discount_versions (rule_id, version, form, percentage, status, created_at)
         SELECT rule_id, version, form, 1, status, created_at FROM shop_discount_versions
         ON CONFLICT (rule_id, version) DO UPDATE SET percentage = excluded.percentage`,
    ];
    // Named by the versions table's own trigger, not only by the orders trigger a cascade also reaches.
    for (const sql of refused) await expect(database.pool.query(sql), sql).rejects.toThrow(/shop_discount_versions is append-only/);
    // Removing the rule cannot take its history with it, and no key into the history cascades.
    await expect(database.pool.query("DELETE FROM shop_discounts")).rejects.toThrow(/shop_discount_versions_rule_id_shop_discounts_id_fk/);
    expect(await database.pool.query(
      `SELECT confdeltype FROM pg_constraint WHERE conname IN ('shop_discount_versions_rule_id_shop_discounts_id_fk', 'shop_discounts_shop_id_shops_id_fk', 'orders_shop_discount_rule_fk')`,
    ).then(({ rows }) => rows.map((row) => row.confdeltype))).toEqual(["a", "a", "a"]);
    expect(await versions()).toEqual([{ version: 1, status: "active", actor_id: owner.id }]);
  });

  it("refuses a rule whose worst case is over the maximum, naming it, and stores nothing", async () => {
    const owner = await shop();
    const refused = async (body: object) => {
      const response = await put(owner.headers, body);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: { code: "DISCOUNT_ABOVE_MAXIMUM", maximumPercentage: "20" } });
    };
    await refused(percentage("20.0001"));
    // A rupee cap does not lower a percentage's worst case: a small order reaches the full percentage.
    await refused(percentage("21", "5"));
    // A flat amount is held on amount over minimum order: 200 on 900 is 22.2%.
    await refused(flat("200", "900"));
    expect(await rules()).toHaveLength(0);
    // The maximum itself is allowed, on both forms.
    expect((await put(owner.headers, percentage("20"))).statusCode).toBe(200);
    expect((await put(owner.headers, flat("200", "1000"))).statusCode).toBe(200);
  });

  it("holds each shop to its own maximum, from its card, over the default", async () => {
    const owner = await shop();
    await publish({ type: "global" }, { ...card, maximumShopDiscountPercentage: "10" });
    expect((await put(owner.headers, percentage("12"))).json().error.maximumPercentage).toBe("10");
    await publish({ type: "shop", id: owner.shopId }, { maximumShopDiscountPercentage: "25" });
    const allowed = await put(owner.headers, percentage("22"));
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().maximumPercentage).toBe("25");
  });

  it("is the Owner's alone: Staff get 403, an account with no shop 404, and a shop not yet approved 409", async () => {
    const owner = await shop();
    const staff = await staffOf(owner.shopId);
    for (const response of [await get(staff.headers), await put(staff.headers, percentage("10"))]) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: { code: "FORBIDDEN" } });
    }
    const stranger = await signIn("stranger@example.com");
    expect((await get(stranger.headers)).statusCode).toBe(404);
    expect((await put(stranger.headers, percentage("10"))).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/me/shop-discount" })).statusCode).toBe(401);
    const pending = await shop("submitted", "pending@example.com");
    expect((await put(pending.headers, percentage("10"))).statusCode).toBe(409);
    expect(await rules()).toHaveLength(0);
  });

  it("refuses a shape that is neither form", async () => {
    const owner = await shop();
    for (const body of [
      { ...percentage("10"), amount: "5" }, flat("200", "0"), flat("0", "1000"), percentage("0"), percentage("10", "0"), { form: "flat", amount: "200", active: true },
      { form: "bundle", active: true }, { form: "percentage", percentage: "10", cap: null },
    ]) expect((await put(owner.headers, body)).statusCode, JSON.stringify(body)).toBe(400);
  });
});

describe("A lower maximum pauses the discounts it breaks (#63, NOT-6)", () => {
  it("pauses a rule over the new maximum, never reducing it, and tells its Owner once; one under it stays on", async () => {
    const over = await shop("live", "over@example.com");
    const under = await shop("live", "under@example.com");
    const staff = await staffOf(over.shopId);
    await put(over.headers, percentage("18", "30"));
    await put(under.headers, flat("100", "1000"));

    expect((await publish({ type: "global" }, { ...card, maximumShopDiscountPercentage: "15" })).statusCode).toBe(201);
    expect((await get(over.headers)).json()).toEqual({
      rule: { id: expect.any(String), version: 2, form: "percentage", percentage: "18", cap: "30", amount: null, minimumOrder: null, status: "paused" }, maximumPercentage: "15", available: true,
    });
    expect((await get(under.headers)).json().rule).toMatchObject({ version: 1, status: "active" });
    // YGo's pause is a version of its own, with no actor.
    expect(await versions()).toContainEqual({ version: 2, status: "paused", actor_id: null });

    const told = (await database.pool.query("SELECT account_id, kind, title, body FROM notifications WHERE kind = 'shop_discount_paused'")).rows;
    expect(told).toEqual([{ account_id: over.id, kind: "shop_discount_paused", title: "Your shop discount is paused", body: expect.stringContaining("15%") }]);
    expect(told.some((row) => row.account_id === staff.id)).toBe(false);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM push_queue")).rows[0]).toEqual({ n: 1 });

    // Publishing again, or the maximum rising, neither tells again nor turns the rule back on.
    await publish({ type: "global" }, { ...card, maximumShopDiscountPercentage: "15" });
    await publish({ type: "global" }, { ...card, maximumShopDiscountPercentage: "30" });
    expect((await database.pool.query("SELECT count(*)::int AS n FROM notifications WHERE kind = 'shop_discount_paused'")).rows[0]).toEqual({ n: 1 });
    expect((await get(over.headers)).json().rule).toMatchObject({ version: 2, status: "paused", percentage: "18" });
    // The Owner turns it on by saving it, now within the maximum.
    expect((await put(over.headers, percentage("18", "30"))).json().rule).toMatchObject({ version: 3, status: "active" });
  });

  it("pauses on a shop's own lower maximum, and only that shop's rule", async () => {
    const one = await shop("live", "one@example.com");
    const two = await shop("live", "two@example.com");
    await put(one.headers, percentage("15"));
    await put(two.headers, percentage("15"));
    await publish({ type: "shop", id: one.shopId }, { maximumShopDiscountPercentage: "10" });
    expect((await get(one.headers)).json().rule.status).toBe("paused");
    expect((await get(two.headers)).json().rule.status).toBe("active");
  });

  it("tells an Owner once however often the pause is retried", async () => {
    const owner = await shop();
    await put(owner.headers, percentage("10"));
    const send = async () => {
      const client = await database.pool.connect();
      try {
        await notifyShopOwner(client, owner.shopId, "shop_discount_paused", "Paused", "Over the maximum.", clock.now(), "shop_discount_paused:rule:2");
      } finally { client.release(); }
    };
    await send(); await send();
    expect((await database.pool.query("SELECT count(*)::int AS n FROM notifications WHERE kind = 'shop_discount_paused'")).rows[0]).toEqual({ n: 1 });
    expect((await database.pool.query("SELECT count(*)::int AS n FROM push_queue")).rows[0]).toEqual({ n: 1 });
  });

  it("never leaves a rule active over the maximum when an Owner's save and the Admin's publish race", async () => {
    // Each round has its own shop, and only that shop's rule is checked.
    for (let round = 0; round < 6; round++) {
      const owner = await shop("live", `racer${round}@example.com`);
      const maximum = String(19 - round);
      const [saved] = await Promise.all([put(owner.headers, percentage("18")), publish({ type: "global" }, { ...card, maximumShopDiscountPercentage: maximum })]);
      expect([200, 400]).toContain(saved.statusCode);
      const { rows } = await database.pool.query(
        "SELECT status, percentage::numeric AS percentage FROM shop_discounts WHERE shop_id = $1", [owner.shopId]);
      // Saved first, the publish paused it; saved after, the save saw the new maximum and was refused.
      for (const rule of rows) if (rule.status === "active") expect(Number(rule.percentage)).toBeLessThanOrEqual(Number(maximum));
      if (Number(maximum) < 18) expect(rows.every((rule) => rule.status !== "active")).toBe(true);
    }
  });
});

describe("The pricing engine's split of a shop-wide discount (#63, MNY-6)", () => {
  const shares = async (rule: object | null, totals: string[], eligible?: boolean[]) =>
    (await database.pool.query<{ shares: string[] }>("SELECT pricing_shop_discount_shares($1::jsonb, $2::numeric[], $3::boolean[])::text[] AS shares",
      [rule && JSON.stringify(rule), totals, eligible ?? totals.map(() => true)])).rows[0]?.shares;

  it("gives a tie's remainder to the first of the largest lines", async () => {
    // 1.00 off three equal lines: 0.33 each rounded down, and the paisa left over goes to the first.
    expect(await shares({ form: "flat", amount: "1", minimumOrder: "3" }, ["1.00", "1.00", "1.00"])).toEqual(["0.34", "0.33", "0.33"]);
  });

  it("spills a remainder the largest line cannot hold to the next largest, so no part passes its line", async () => {
    // 20% of ten 1-paisa lines is 2 paise: each takes 0 rounded down, and the 2 left over cannot both go on one 1-paisa line.
    const tiny = Array.from({ length: 10 }, () => "0.01");
    expect(await shares({ form: "percentage", percentage: "20", cap: null }, tiny)).toEqual(["0.01", "0.01", ...Array.from({ length: 8 }, () => "0.00")]);
    // The largest takes what it can, then the next largest, ties in line order.
    expect(await shares({ form: "flat", amount: "0.05", minimumOrder: "0.05" }, ["0.01", "0.02", "0.01", "0.02"])).toEqual(["0.01", "0.02", "0.00", "0.02"]);
  });

  it("leaves an ineligible line out of the base and takes nothing off it", async () => {
    // 10% of the eligible 100.00 is 10.00; the bargained 500.00 line is not in the base.
    expect(await shares({ form: "percentage", percentage: "10", cap: null }, ["100.00", "500.00"], [true, false])).toEqual(["10.00", "0.00"]);
    expect(await shares({ form: "percentage", percentage: "10", cap: null }, ["500.00"], [false])).toEqual(["0.00"]);
  });

  it("takes nothing off with no rule or no lines, and never more than the base", async () => {
    expect(await shares(null, ["10.00", "5.00"])).toEqual(["0.00", "0.00"]);
    expect(await shares({ form: "percentage", percentage: "10", cap: null }, [] as string[])).toEqual([]);
    expect(await shares({ form: "flat", amount: "500", minimumOrder: "10" }, ["10.00", "30.00"])).toEqual(["10.00", "30.00"]);
  });

  it("never takes more off a line than its eligible total, on every small basket", async () => {
    // Every basket of one to three lines from tiny, borderline and large paise amounts (four lines from fewer), with the first line eligible or not,
    // under rules that round, cap, hit the minimum or pass the base. Checked in SQL: each part is whole paise, within
    // 0 and its line's eligible total, nothing comes off an ineligible line, and the parts add up to the order's discount.
    const { rows: [result] } = await database.pool.query<{ cases: number; bad: unknown[] | null }>(`
      WITH amounts(paise) AS (VALUES (1), (2), (3), (99), (100), (101), (100000)), few(paise) AS (VALUES (1), (2), (100000)),
      baskets AS (
        SELECT ARRAY[a.paise] AS paise FROM amounts a
        UNION ALL SELECT ARRAY[a.paise, b.paise] FROM amounts a, amounts b
        UNION ALL SELECT ARRAY[a.paise, b.paise, c.paise] FROM amounts a, amounts b, amounts c
        UNION ALL SELECT ARRAY[a.paise, b.paise, c.paise, d.paise] FROM few a, few b, few c, few d),
      rules(rule) AS (VALUES
        ('{"form":"percentage","percentage":"0.01","cap":null}'::jsonb), ('{"form":"percentage","percentage":"19.99","cap":null}'),
        ('{"form":"percentage","percentage":"20","cap":null}'), ('{"form":"percentage","percentage":"33.3333","cap":null}'),
        ('{"form":"percentage","percentage":"66.6667","cap":"0.05"}'), ('{"form":"percentage","percentage":"100","cap":null}'),
        ('{"form":"flat","amount":"0.01","minimumOrder":"0.01"}'), ('{"form":"flat","amount":"0.05","minimumOrder":"0.05"}'),
        ('{"form":"flat","amount":"1","minimumOrder":"1"}'), ('{"form":"flat","amount":"1000","minimumOrder":"0.01"}')),
      cases AS (
        SELECT rule, paise, first, ARRAY(SELECT amount / 100.0 FROM unnest(paise) WITH ORDINALITY AS l(amount, i) ORDER BY i) AS totals,
               ARRAY(SELECT i > 1 OR first FROM generate_subscripts(paise, 1) AS i ORDER BY i) AS eligible
        FROM baskets, rules, (VALUES (true), (false)) AS f(first)),
      split AS (SELECT *, pricing_shop_discount_shares(rule, totals, eligible) AS shares FROM cases),
      checked AS (
        SELECT *,
          (SELECT COALESCE(sum(paise[i]), 0) FROM generate_subscripts(paise, 1) AS i WHERE eligible[i]) AS base,
          (SELECT sum(part) * 100 FROM unnest(shares) AS part) AS taken,
          -- A missing or null part fails: the lengths must match and every comparison must be true, never null.
          array_length(shares, 1) IS NOT DISTINCT FROM array_length(paise, 1)
            AND (SELECT bool_and(COALESCE(shares[i] * 100 = trunc(shares[i] * 100) AND shares[i] >= 0
                           AND shares[i] * 100 <= CASE WHEN eligible[i] THEN paise[i] ELSE 0 END, false))
             FROM generate_subscripts(paise, 1) AS i) AS within
        FROM split),
      expected AS (
        SELECT *, CASE rule->>'form'
          WHEN 'percentage' THEN LEAST(round(base * (rule->>'percentage')::numeric / 100), COALESCE((rule->>'cap')::numeric * 100, base), base)
          ELSE CASE WHEN base >= (rule->>'minimumOrder')::numeric * 100 THEN LEAST((rule->>'amount')::numeric * 100, base) ELSE 0 END
        END AS discount FROM checked)
      SELECT count(*)::int AS cases,
             (jsonb_agg(jsonb_build_object('rule', rule, 'paise', paise, 'eligible', eligible, 'shares', shares)) FILTER (WHERE within IS NOT TRUE OR taken IS DISTINCT FROM discount)) AS bad
      FROM expected`);
    expect(result?.cases).toBe(9_600);
    expect(result?.bad).toBeNull();
  }, 60_000);

  it("always adds up exactly to the order's discount, whatever the paise", async () => {
    let seed = 7;
    const next = (limit: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % limit; };
    for (let run = 0; run < 200; run++) {
      // One run in four is many lines of a few paise, where the remainder can outgrow the largest line.
      const totals = run % 4 === 3
        ? Array.from({ length: 5 + next(20) }, () => `0.0${1 + next(9)}`)
        : Array.from({ length: 1 + next(8) }, () => `${1 + next(900)}.${String(next(100)).padStart(2, "0")}`);
      const rule = run % 2 ? { form: "percentage", percentage: `${1 + next(20)}.${next(100)}`, cap: run % 4 === 1 ? String(1 + next(50)) : null }
        : { form: "flat", amount: String(1 + next(60)), minimumOrder: String(1 + next(300)) };
      const parts = (await shares(rule, totals)) ?? [];
      const paise = (value: string) => Math.round(Number(value) * 100);
      const base = totals.reduce((sum, total) => sum + paise(total), 0);
      const sum = parts.reduce((total, part) => total + paise(part), 0);
      const expected = rule.form === "percentage"
        ? Math.min(Math.round(base * Number((rule as { percentage: string }).percentage) / 100 + 1e-9), (rule as { cap: string | null }).cap ? paise((rule as { cap: string }).cap) : base)
        : base >= paise((rule as { minimumOrder: string }).minimumOrder) ? Math.min(paise((rule as { amount: string }).amount), base) : 0;
      expect(sum).toBe(expected);
      parts.forEach((part, index) => expect(paise(part)).toBeLessThanOrEqual(paise(totals[index] ?? "0")));
    }
  });
});

describe("Placing an order under a shop-wide discount (#63, MNY-6, MNY-7)", () => {
  const customer = async () => {
    const who = await signIn("customer@example.com");
    const area = await database.pool.query<{ id: string }>("INSERT INTO areas (name) VALUES ('Kothrud') RETURNING id");
    await database.pool.query("INSERT INTO area_pincodes (pincode, area_id) VALUES ('411038', $1)", [area.rows[0]?.id]);
    const shopArea = await database.pool.query<{ id: string }>("INSERT INTO areas (name) VALUES ('Paud Road') RETURNING id");
    await database.pool.query("INSERT INTO area_pincodes (pincode, area_id) VALUES ('411045', $1)", [shopArea.rows[0]?.id]);
    const { rows: [home] } = await database.pool.query<{ id: string }>(
      `INSERT INTO saved_addresses (account_id, label, flat, area_line, pincode, point, saved_at)
       VALUES ($1, 'home', 'Flat 4B', 'Kothrud', '411038', ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography, now()) RETURNING id`, [who.id]);
    return { ...who, home: home?.id ?? "" };
  };
  async function listing(shopId: string, price: string) {
    const category = (await database.pool.query<{ id: string }>("SELECT id FROM categories LIMIT 1")).rows[0]?.id;
    const product = (await database.pool.query<{ id: string }>(
      `INSERT INTO master_products (name, category_id, base_unit, classification, published, image_256_key, image_512_key, image_1024_key)
       VALUES ($1, $2, 'each', 'counted', true, 'p/256.webp', 'p/512.webp', 'p/1024.webp') RETURNING id`, [`Item ${randomUUID()}`, category])).rows[0]?.id;
    const pack = (await database.pool.query<{ id: string }>("INSERT INTO packs (product_id, quantity) VALUES ($1, '1') RETURNING id", [product])).rows[0]?.id;
    const id = (await database.pool.query<{ id: string }>(
      "INSERT INTO shop_listings (shop_id, pack_id, online_price, counter_price, mrp) VALUES ($1, $2, $3, $3, $3) RETURNING id", [shopId, pack, price])).rows[0]?.id ?? "";
    await database.pool.query("INSERT INTO stock_movements (listing_id, actor_id, client_id, kind, quantity) VALUES ($1, $2, $3, 'opening', '50')", [id, randomUUID(), randomUUID()]);
    return id;
  }
  const here = "pincode=411038&latitude=18.5&longitude=73.8";
  async function order(shopId: string, who: { headers: Record<string, string>; home: string }, lines: Array<{ listingId: string; count: number }>) {
    const { revision } = (await app.inject({ method: "GET", url: `/v1/carts/${shopId}?${here}`, headers: who.headers })).json() as { revision: number };
    const cart = (await app.inject({ method: "PUT", url: `/v1/carts/${shopId}?${here}`, headers: who.headers, payload: { revision, lines } })).json() as { revision: number; quote: { total: string } };
    return { cart, place: (total = cart.quote.total) => app.inject({ method: "POST", url: `/v1/carts/${shopId}/order`, headers: who.headers, payload: { revision: cart.revision, total, addressId: who.home } }) };
  }

  it("takes the discount off the total, freezes the rule, its version and the line parts, and is unmoved by a later edit", async () => {
    const owner = await shop();
    await publish({ type: "global" }, card);
    const who = await customer();
    const [a, b, c] = [await listing(owner.shopId, "33.33"), await listing(owner.shopId, "33.33"), await listing(owner.shopId, "33.34")];
    const saved = (await put(owner.headers, percentage("5"))).json().rule as { id: string };

    const { cart, place } = await order(owner.shopId, who, [{ listingId: a, count: 1 }, { listingId: b, count: 1 }, { listingId: c, count: 1 }]);
    // Product 100.00 less 5.00 and the 30.00 delivery.
    expect(cart.quote.total).toBe("125.00");
    const placed = await place();
    expect(placed.statusCode).toBe(201);
    const id = placed.json().id as string;
    const frozen = (await database.pool.query(
      "SELECT shop_discount::text AS discount, shop_discount_rule_id AS rule, shop_discount_rule_version AS version, total::text AS total, product_value::text AS product, quote FROM orders WHERE id = $1", [id])).rows[0];
    expect(frozen).toMatchObject({ discount: "5.00", rule: saved.id, version: 1, total: "125.00", product: "100.00" });
    expect(frozen.quote.shopDiscount).toEqual({ amount: "5.00", ruleId: saved.id, ruleVersion: 1 });
    // Commission is per line on what each line keeps after its part: 10% of 31.67, 31.67 and 31.66.
    expect(frozen.quote.commission).toBe("9.51");
    expect(frozen.quote.lines.map((line: { commission: string }) => line.commission)).toEqual(["3.17", "3.17", "3.17"]);
    const parts = (await database.pool.query<{ part: string }>("SELECT shop_discount::text AS part FROM order_lines WHERE order_id = $1 ORDER BY position", [id])).rows.map((row) => row.part);
    expect(parts).toEqual(["1.66", "1.66", "1.68"]);
    // The order's amount is the sum of its lines' parts, to the paisa.
    expect((await database.pool.query("SELECT (o.shop_discount = (SELECT sum(shop_discount) FROM order_lines WHERE order_id = o.id)) AS same FROM orders o WHERE id = $1", [id])).rows[0]).toEqual({ same: true });

    // Editing, pausing or switching off the rule later never changes the placed order.
    await put(owner.headers, percentage("10"));
    await publish({ type: "global" }, { ...card, maximumShopDiscountPercentage: "5" });
    await put(owner.headers, percentage("5", null, false));
    expect((await database.pool.query("SELECT shop_discount::text AS discount, shop_discount_rule_version AS version, total::text AS total FROM orders WHERE id = $1", [id])).rows[0])
      .toEqual({ discount: "5.00", version: 1, total: "125.00" });
    expect((await database.pool.query("SELECT form, percentage::text AS percentage, status FROM shop_discount_versions WHERE rule_id = $1 AND version = 1", [saved.id])).rows[0])
      .toEqual({ form: "percentage", percentage: "5.0000", status: "active" });
    // Nor can anything write over the frozen amounts.
    for (const sql of ["UPDATE orders SET shop_discount = 0, shop_discount_rule_id = NULL, shop_discount_rule_version = NULL", "UPDATE order_lines SET shop_discount = 0"]) {
      await expect(database.pool.query(sql), sql).rejects.toThrow(/frozen|append-only/);
    }
  });

  it("refuses to place at a total made under a rule that has since been paused, quoting the cart again", async () => {
    const owner = await shop();
    await publish({ type: "global" }, card);
    const who = await customer();
    const item = await listing(owner.shopId, "200");
    await put(owner.headers, percentage("10"));
    const { cart, place } = await order(owner.shopId, who, [{ listingId: item, count: 1 }]);
    expect(cart.quote.total).toBe("210.00");
    await publish({ type: "global" }, { ...card, maximumShopDiscountPercentage: "5" });
    const refused = await place();
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("CART_CHANGED");
    expect(refused.json().error.cart.quote.total).toBe("230.00");
    expect((await database.pool.query("SELECT count(*)::int AS n FROM orders")).rows[0]).toEqual({ n: 0 });
  });

  it("applies no rule while discounts are not available, even one left active in the database (#571)", async () => {
    const owner = await shop();
    await publish({ type: "global" }, card);
    const who = await customer();
    const item = await listing(owner.shopId, "200");
    expect((await put(owner.headers, percentage("10"))).json().rule.status).toBe("active");
    const open = app;
    app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret });
    try {
      const { cart, place } = await order(owner.shopId, who, [{ listingId: item, count: 1 }]);
      expect(cart.quote.total).toBe("230.00");
      expect((await place()).statusCode).toBe(201);
    } finally { await app.close(); app = open; }
    expect((await database.pool.query("SELECT shop_discount::text AS discount, shop_discount_rule_id AS rule, total::text AS total FROM orders")).rows[0])
      .toEqual({ discount: "0.00", rule: null, total: "230.00" });
  });

  it("places with no discount, recording none, while the rule is off or paused", async () => {
    const owner = await shop();
    await publish({ type: "global" }, card);
    const who = await customer();
    const item = await listing(owner.shopId, "200");
    await put(owner.headers, percentage("10", null, false));
    const { place } = await order(owner.shopId, who, [{ listingId: item, count: 1 }]);
    const placed = await place();
    expect(placed.statusCode).toBe(201);
    expect((await database.pool.query("SELECT shop_discount::text AS discount, shop_discount_rule_id AS rule, total::text AS total FROM orders")).rows[0])
      .toEqual({ discount: "0.00", rule: null, total: "230.00" });
  });
});
