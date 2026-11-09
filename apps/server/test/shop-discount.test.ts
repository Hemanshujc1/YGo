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
    // under rules that round, cap, hit the minimum or pass the base. Each invariant is checked on its own in SQL, so a failure names it:
    // - whole: every part is whole paise and not negative, one part per line (a missing or null part fails, never passes as null);
    // - ineligible: a line that is not eligible gets nothing;
    // - line: no part passes its line's eligible total;
    // - total: the parts add up to the intended discount, worked out here in rupees from the rule's own words (MNY-6), not from the engine's paise;
    // - aggregate: the order's discount never passes the eligible value.
    const { rows: [result] } = await database.pool.query<{ cases: number; uneven: number; ineligible: number; bad: Array<{ broken: string[] }> | null }>(`
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
      valued AS (
        SELECT *,
          (SELECT COALESCE(sum(totals[i]), 0) FROM generate_subscripts(totals, 1) AS i WHERE eligible[i]) AS eligible_rupees,
          (SELECT sum(part) FROM unnest(shares) AS part) AS taken
        FROM split),
      intended AS (
        -- Percentage: that share of eligible value, rounded to the paisa, no more than the cap. Flat: the amount once eligible value reaches the
        -- minimum order. Never more than eligible value.
        SELECT *, LEAST(eligible_rupees, CASE rule->>'form'
          WHEN 'percentage' THEN LEAST(round(eligible_rupees * (rule->>'percentage')::numeric / 100, 2), COALESCE((rule->>'cap')::numeric, eligible_rupees))
          ELSE CASE WHEN eligible_rupees >= (rule->>'minimumOrder')::numeric THEN (rule->>'amount')::numeric ELSE 0 END
        END) AS discount FROM valued),
      checked AS (
        SELECT *, array_remove(ARRAY[
          CASE WHEN array_length(shares, 1) IS NOT DISTINCT FROM array_length(totals, 1)
                AND (SELECT bool_and(COALESCE(shares[i] = round(shares[i], 2) AND shares[i] >= 0, false)) FROM generate_subscripts(totals, 1) AS i)
               THEN NULL ELSE 'whole' END,
          CASE WHEN (SELECT bool_and(COALESCE(shares[i] = 0, false)) FROM generate_subscripts(totals, 1) AS i WHERE NOT eligible[i]) IS NOT FALSE
               THEN NULL ELSE 'ineligible' END,
          CASE WHEN (SELECT bool_and(COALESCE(shares[i] <= totals[i], false)) FROM generate_subscripts(totals, 1) AS i) IS NOT FALSE
               THEN NULL ELSE 'line' END,
          CASE WHEN taken IS NOT DISTINCT FROM discount THEN NULL ELSE 'total' END,
          CASE WHEN COALESCE(taken <= eligible_rupees, false) THEN NULL ELSE 'aggregate' END
        ], NULL) AS broken FROM intended)
      SELECT count(*)::int AS cases,
             -- How many cases reach the rounding and spill paths, and have an ineligible line, so the sweep is known to cover them.
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM generate_subscripts(totals, 1) AS i
               WHERE eligible_rupees > 0 AND shares[i] * eligible_rupees <> discount * totals[i] AND eligible[i]))::int AS uneven,
             count(*) FILTER (WHERE NOT (SELECT bool_and(e) FROM unnest(eligible) AS e))::int AS ineligible,
             (jsonb_agg(jsonb_build_object('broken', broken, 'rule', rule, 'paise', paise, 'eligible', eligible, 'shares', shares, 'discount', discount))
               FILTER (WHERE cardinality(broken) > 0)) AS bad
      FROM checked`);
    expect(result?.cases).toBe(9_600);
    expect(result?.uneven).toBeGreaterThan(1_000);
    expect(result?.ineligible).toBe(4_800);
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

  describe("what the Customer sees of it (#571, CRT-5)", () => {
    const cents = (amount: string) => Math.round(Number(amount) * 100);
    /** Items less the discount plus the fees is the total, to the paisa, as the Customer reads the rows. */
    const reconciles = (view: { productValue: string; shopDiscount: { amount: string } | null; deliveryFee?: string; smallCartFee?: string | null; total: string }, delivery = "30.00") =>
      cents(view.productValue) - cents(view.shopDiscount?.amount ?? "0") + cents(view.deliveryFee ?? delivery) + cents(view.smallCartFee ?? "0") === cents(view.total);
    const orderOf = async (who: { headers: Record<string, string> }, id: string) => (await app.inject({ method: "GET", url: `/v1/orders/${id}`, headers: who.headers })).json();
    const receiptOf = async (who: { headers: Record<string, string> }, id: string) => (await app.inject({ method: "GET", url: `/v1/orders/${id}/receipt`, headers: who.headers })).json();
    const basket = async (owner: { shopId: string }) => [{ listingId: await listing(owner.shopId, "33.33"), count: 1 }, { listingId: await listing(owner.shopId, "33.33"), count: 1 }, { listingId: await listing(owner.shopId, "33.34"), count: 1 }];

    it("shows the discount and its offer on the cart, the order and the receipt, each adding up to its total, and keeps the offer after the rule is edited", async () => {
      const owner = await shop();
      await publish({ type: "global" }, card);
      const who = await customer();
      await put(owner.headers, percentage("5", "50.00"));
      const { cart, place } = await order(owner.shopId, who, await basket(owner));
      const offer = { form: "percentage", percentage: "5", cap: "50" };
      const quote = (cart as unknown as { quote: { productValue: string; shopDiscount: { amount: string; offer: unknown }; deliveryFee: string; smallCartFee: string | null; total: string } }).quote;
      expect(quote).toMatchObject({ productValue: "100.00", shopDiscount: { amount: "5.00", offer }, total: "125.00" });
      expect(reconciles({ ...quote, deliveryFee: "30.00" })).toBe(true);

      const id = (await place()).json().id as string;
      const placed = await orderOf(who, id);
      expect(placed).toMatchObject({ productValue: "100.00", shopDiscount: { amount: "5.00", offer }, total: "125.00" });
      expect(reconciles(placed)).toBe(true);

      // The Owner edits the rule twice; the order and the receipt still name the offer that priced them, and the cart names the new one.
      await put(owner.headers, flat("200", "1000"));
      await put(owner.headers, percentage("10", "20"));
      await database.pool.query("UPDATE orders SET status = 'delivered' WHERE id = $1", [id]);
      expect((await orderOf(who, id)).shopDiscount).toEqual({ amount: "5.00", offer });
      const receipt = await receiptOf(who, id);
      expect(receipt).toMatchObject({ productValue: "100.00", shopDiscount: { amount: "5.00", offer }, total: "125.00" });
      expect(reconciles(receipt)).toBe(true);
      const later = await order(owner.shopId, who, await basket(owner));
      expect((later.cart as unknown as { quote: { shopDiscount: { offer: unknown } } }).quote.shopDiscount.offer).toEqual({ form: "percentage", percentage: "10", cap: "20" });

      // A flat offer carries its amount and minimum order, without trailing zeros.
      await put(owner.headers, flat("200", "1000"));
      const rich = await order(owner.shopId, who, [{ listingId: await listing(owner.shopId, "999.50"), count: 2 }]);
      expect(rich.cart.quote).toMatchObject({ shopDiscount: { amount: "200.00", offer: { form: "flat", amount: "200", minimumOrder: "1000" } } });
    });

    it("returns no discount when none applied: no rule, a rule off, a flat rule under its minimum, or discounts not available", async () => {
      const owner = await shop();
      await publish({ type: "global" }, card);
      const who = await customer();
      const item = await listing(owner.shopId, "200");
      const lines = [{ listingId: item, count: 1 }];
      const cartOf = async () => ((await order(owner.shopId, who, lines)).cart as unknown as { quote: { shopDiscount: unknown } }).quote.shopDiscount;
      const first = await order(owner.shopId, who, lines);
      expect(first.cart.quote).toMatchObject({ shopDiscount: null, total: "230.00" });
      const id = (await first.place()).json().id as string;
      expect((await orderOf(who, id)).shopDiscount).toBeNull();
      await database.pool.query("UPDATE orders SET status = 'delivered' WHERE id = $1", [id]);
      expect((await receiptOf(who, id)).shopDiscount).toBeNull();

      await put(owner.headers, percentage("10", null, false));
      expect(await cartOf()).toBeNull();
      await put(owner.headers, flat("200", "1000"));
      expect(await cartOf()).toBeNull();

      // A rule left active, with the gate off: nothing on the cart, the order or the receipt.
      await put(owner.headers, percentage("10"));
      expect(await cartOf()).not.toBeNull();
      const open = app;
      app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret });
      try {
        expect(await cartOf()).toBeNull();
        const gated = await order(owner.shopId, who, lines);
        const gatedId = (await gated.place()).json().id as string;
        expect((await orderOf(who, gatedId)).shopDiscount).toBeNull();
        await database.pool.query("UPDATE orders SET status = 'delivered' WHERE id = $1", [gatedId]);
        expect((await receiptOf(who, gatedId)).shopDiscount).toBeNull();
      } finally { await app.close(); app = open; }
    });

    it("keeps an order's frozen discount and offer when the gate is turned off later, while new quotes and orders get none", async () => {
      const owner = await shop();
      await publish({ type: "global" }, card);
      const who = await customer();
      await put(owner.headers, percentage("5", "50.00"));
      const { cart, place } = await order(owner.shopId, who, await basket(owner));
      expect((cart as unknown as { quote: { total: string } }).quote.total).toBe("125.00");
      const id = (await place()).json().id as string;
      await database.pool.query("UPDATE orders SET status = 'delivered' WHERE id = $1", [id]);
      const offer = { form: "percentage", percentage: "5", cap: "50" };
      const before = { order: await orderOf(who, id), receipt: await receiptOf(who, id) };
      expect(before.order.shopDiscount).toEqual({ amount: "5.00", offer });
      expect(before.receipt.shopDiscount).toEqual({ amount: "5.00", offer });

      // The gate goes off with the rule still active in the database: the same server code, `shopDiscountsAvailable` left at its default.
      const open = app;
      app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret });
      try {
        expect((await database.pool.query("SELECT status FROM shop_discounts")).rows[0]).toEqual({ status: "active" });
        // History is not erased: the order and its receipt are exactly as they were, and each adds up.
        const order1 = await orderOf(who, id);
        const receipt1 = await receiptOf(who, id);
        expect(order1).toEqual(before.order);
        expect(receipt1).toEqual(before.receipt);
        expect(order1.shopDiscount).toEqual({ amount: "5.00", offer });
        expect(receipt1.shopDiscount).toEqual({ amount: "5.00", offer });
        expect(reconciles(order1)).toBe(true);
        expect(reconciles(receipt1)).toBe(true);
        expect([order1.total, receipt1.total]).toEqual(["125.00", "125.00"]);

        // New quotes and new orders get none.
        const fresh = await order(owner.shopId, who, await basket(owner));
        const quote = (fresh.cart as unknown as { quote: { productValue: string; shopDiscount: unknown; deliveryFee: string; smallCartFee: string | null; total: string } }).quote;
        expect(quote).toMatchObject({ productValue: "100.00", shopDiscount: null, total: "130.00" });
        expect(reconciles({ ...quote, shopDiscount: null })).toBe(true);
        const freshId = (await fresh.place()).json().id as string;
        const placed = await orderOf(who, freshId);
        expect(placed).toMatchObject({ shopDiscount: null, productValue: "100.00", total: "130.00" });
        expect(reconciles(placed)).toBe(true);
        expect((await database.pool.query("SELECT shop_discount::text AS discount, shop_discount_rule_id AS rule FROM orders WHERE id = $1", [freshId])).rows[0]).toEqual({ discount: "0.00", rule: null });
        await database.pool.query("UPDATE orders SET status = 'delivered' WHERE id = $1", [freshId]);
        expect((await receiptOf(who, freshId)).shopDiscount).toBeNull();
        // The historical order is still untouched after the new one.
        expect(await orderOf(who, id)).toEqual(before.order);
      } finally { await app.close(); app = open; }
    });
  });

  describe("a partial acceptance re-applies it and the revision carries its own (#572, ORD-3, ORD-4)", () => {
    const cents = (amount: string) => Math.round(Number(amount) * 100);
    type View = { status: string; productValue: string; shopDiscount: { amount: string; offer: Record<string, string | null> } | null; deliveryFee: string; smallCartFee: string | null; total: string;
      lines: Array<{ lineTotal: string }>; proposal: { shopDiscount: { amount: string; offer: unknown } | null; lostShopDiscount: unknown; total: string } | null };
    const reconciles = (view: { productValue: string; shopDiscount: { amount: string } | null; deliveryFee: string; smallCartFee?: string | null; total: string }) =>
      cents(view.productValue) - cents(view.shopDiscount?.amount ?? "0") + cents(view.deliveryFee) + cents(view.smallCartFee ?? "0") === cents(view.total);
    const orderOf = async (who: { headers: Record<string, string> }, id: string) => (await app.inject({ method: "GET", url: `/v1/orders/${id}`, headers: who.headers })).json() as View;
    const receiptOf = async (who: { headers: Record<string, string> }, id: string) => (await app.inject({ method: "GET", url: `/v1/orders/${id}/receipt`, headers: who.headers })).json() as View;
    const revisions = async (id: string) => (await database.pool.query<{ revision: number; discount: string; rule: string | null; version: number | null; commission: string; product: string; total: string; lines: string }>(
      `SELECT r.revision, r.shop_discount::text AS discount, r.shop_discount_rule_id AS rule, r.shop_discount_rule_version AS version, r.commission::text AS commission,
         r.product_value::text AS product, r.total::text AS total,
         (SELECT COALESCE(sum(l.shop_discount), 0)::text FROM order_revision_lines l WHERE l.revision_id = r.id) AS lines
       FROM order_revisions r WHERE r.order_id = $1 ORDER BY r.revision`, [id])).rows;

    /** A placed, accepted order of the given lines at the shop's price, under whatever rule the Owner has saved. */
    async function accepted(owner: { shopId: string; headers: Record<string, string> }, prices: string[]) {
      const who = await customer();
      // "100x2" is two of a ₹100 item.
      const listings = await Promise.all(prices.map((price) => listing(owner.shopId, price.split("x")[0] ?? "")));
      const { place } = await order(owner.shopId, who, listings.map((listingId, index) => ({ listingId, count: Number(prices[index]?.split("x")[1] ?? 1) })));
      const id = (await place()).json().id as string;
      expect((await app.inject({ method: "POST", url: `/v1/me/shop-orders/${id}/accept`, headers: owner.headers })).statusCode).toBe(200);
      return { who, id, listings };
    }
    /** A bare id removes the line; `[id, count]` keeps that many. */
    const remove = (changes: Array<string | [string, number]>) => ({ lines: changes.map((change) => ({ listingId: typeof change === "string" ? change : change[0], count: typeof change === "string" ? 0 : change[1], reason: "out_of_stock" })) });
    const propose = async (owner: { headers: Record<string, string> }, id: string, listingIds: Array<string | [string, number]>) => {
      const sent = await app.inject({ method: "POST", url: `/v1/me/shop-orders/${id}/partial-accept`, headers: owner.headers, payload: remove(listingIds) });
      expect(sent.json()).not.toHaveProperty("error");
      return sent;
    };
    const confirm = (who: { headers: Record<string, string> }, id: string) => app.inject({ method: "POST", url: `/v1/orders/${id}/confirm-total`, headers: who.headers });
    const cardWith = (base: string) => ({ ...card, commission: { ...card.commission, base } });

    it("recomputes a percentage on the revised base and re-applies its cap, through two revisions, with the order view, receipt and S05 preview agreeing", async () => {
      const owner = await shop();
      await publish({ type: "global" }, card);
      await put(owner.headers, percentage("10", "25"));
      const { who, id, listings } = await accepted(owner, ["200", "100x2"]);
      const line = listings[1] ?? "";
      const offer = { form: "percentage", percentage: "10", cap: "25" };
      expect(await orderOf(who, id)).toMatchObject({ shopDiscount: { amount: "25.00", offer }, total: "405.00" });

      // The S05 preview shows the discount the proposal will carry, before it is sent.
      const preview = await app.inject({ method: "POST", url: `/v1/me/shop-orders/${id}/partial-accept/preview`, headers: owner.headers, payload: remove([[line, 1]]) });
      expect(preview.json()).toEqual({ productValue: "300.00", shopDiscount: { amount: "25.00", offer }, deliveryFee: "30.00", smallCartFee: null, total: "305.00", originalTotal: "405.00" });

      // First revision: 300 under the 10% is 30, held by the 25 cap.
      const sent = await propose(owner, id, [[line, 1]]);
      expect(sent.json().proposal).toMatchObject({ productValue: "300.00", shopDiscount: { amount: "25.00", offer }, lostShopDiscount: null, total: "305.00" });
      expect((await confirm(who, id)).statusCode).toBe(200);
      const first = await orderOf(who, id);
      expect(first).toMatchObject({ productValue: "300.00", shopDiscount: { amount: "25.00", offer }, total: "305.00" });
      expect(reconciles(first)).toBe(true);

      // The Owner edits the rule meanwhile; the second revision still prices from the frozen version: 200 under the 10% is 20, under the cap.
      await put(owner.headers, flat("5", "10"));
      await propose(owner, id, [line]);
      expect((await confirm(who, id)).statusCode).toBe(200);
      const second = await orderOf(who, id);
      expect(second).toMatchObject({ productValue: "200.00", shopDiscount: { amount: "20.00", offer }, total: "210.00" });
      expect(second.lines).toHaveLength(1);
      expect(reconciles(second)).toBe(true);

      const order1 = (await database.pool.query<{ rule: string; version: number }>("SELECT shop_discount_rule_id AS rule, shop_discount_rule_version AS version FROM orders WHERE id = $1", [id])).rows[0];
      expect(await revisions(id)).toMatchObject([
        { revision: 1, discount: "25.00", lines: "25.00", total: "305.00", rule: order1?.rule, version: order1?.version },
        { revision: 2, discount: "20.00", lines: "20.00", total: "210.00", rule: order1?.rule, version: order1?.version },
      ]);

      // The receipt reads the confirmed revision's lines, discount and total.
      await database.pool.query("UPDATE orders SET status = 'delivered' WHERE id = $1", [id]);
      const receipt = await receiptOf(who, id);
      expect(receipt).toMatchObject({ productValue: "200.00", shopDiscount: { amount: "20.00", offer }, total: "210.00" });
      expect(receipt.lines).toHaveLength(1);
      expect(reconciles(receipt)).toBe(true);
    });

    it("drops a flat discount to zero when the revised base is under its minimum, keeps the rule on the revision and tells the Customer why", async () => {
      const owner = await shop();
      await publish({ type: "global" }, card);
      await put(owner.headers, flat("50", "300"));
      const { who, id, listings } = await accepted(owner, ["200", "100"]);
      const offer = { form: "flat", amount: "50", minimumOrder: "300" };
      expect(await orderOf(who, id)).toMatchObject({ shopDiscount: { amount: "50.00", offer }, total: "280.00" });

      const sent = await propose(owner, id, [listings[1] ?? ""]);
      expect(sent.json().proposal).toMatchObject({ productValue: "200.00", shopDiscount: null, lostShopDiscount: offer, total: "230.00" });
      expect((await confirm(who, id)).statusCode).toBe(200);
      const revised = await orderOf(who, id);
      expect(revised).toMatchObject({ productValue: "200.00", shopDiscount: null, total: "230.00" });
      expect(reconciles(revised)).toBe(true);

      // The rule id and version stay on the revision with an amount of 0 (not null), so what priced it is never lost.
      const order1 = (await database.pool.query<{ rule: string; version: number }>("SELECT shop_discount_rule_id AS rule, shop_discount_rule_version AS version FROM orders WHERE id = $1", [id])).rows[0];
      expect(await revisions(id)).toMatchObject([{ discount: "0.00", lines: "0.00", rule: order1?.rule, version: order1?.version }]);
    });

    it("keeps a flat discount while the revised base still meets the minimum, tested before the discount like placement", async () => {
      const owner = await shop();
      await publish({ type: "global" }, card);
      await put(owner.headers, flat("50", "300"));
      const { who, id, listings } = await accepted(owner, ["200", "100", "100"]);
      await propose(owner, id, [listings[2] ?? ""]);
      await confirm(who, id);
      const revised = await orderOf(who, id);
      expect(revised).toMatchObject({ productValue: "300.00", shopDiscount: { amount: "50.00" }, total: "280.00" });
      expect(reconciles(revised)).toBe(true);
    });

    it("prices from the frozen rule version, never the shop's current rule, and is unmoved when it is turned off or edited", async () => {
      const owner = await shop();
      await publish({ type: "global" }, card);
      await put(owner.headers, percentage("10"));
      const { who, id, listings } = await accepted(owner, ["200", "100"]);
      await put(owner.headers, percentage("50"));
      await put(owner.headers, percentage("10", null, false));
      await propose(owner, id, [listings[1] ?? ""]);
      await confirm(who, id);
      expect(await orderOf(who, id)).toMatchObject({ productValue: "200.00", shopDiscount: { amount: "20.00", offer: { form: "percentage", percentage: "10", cap: null } }, total: "210.00" });
    });

    it("keeps the frozen rule when the gate is turned off after placement, while the flag stays the code's only switch", async () => {
      const owner = await shop();
      await publish({ type: "global" }, card);
      await put(owner.headers, percentage("10"));
      const { who, id, listings } = await accepted(owner, ["200", "100"]);
      const open = app;
      app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret });
      try {
        expect((await propose(owner, id, [listings[1] ?? ""])).statusCode).toBe(200);
        expect((await confirm(who, id)).statusCode).toBe(200);
        const revised = await orderOf(who, id);
        expect(revised).toMatchObject({ productValue: "200.00", shopDiscount: { amount: "20.00" }, total: "210.00" });
        expect(reconciles(revised)).toBe(true);
      } finally { await app.close(); app = open; }
    });

    it.each([["after_shop_discount", "18.00"], ["before_shop_discount", "20.00"]])("commissions on the order's own rate-card base, %s", async (base, commission) => {
      const owner = await shop();
      await publish({ type: "global" }, cardWith(base));
      await put(owner.headers, percentage("10"));
      const { who, id, listings } = await accepted(owner, ["200", "100"]);
      await publish({ type: "global" }, cardWith(base === "after_shop_discount" ? "before_shop_discount" : "after_shop_discount"));
      await propose(owner, id, [listings[1] ?? ""]);
      await confirm(who, id);
      // 200 of items and a 20 discount; the commission is 10% of 180 or of 200, by the base the order was placed under.
      expect(await revisions(id)).toMatchObject([{ product: "200.00", discount: "20.00", commission, total: "210.00" }]);
    });

    it("prices a revision's commission from the rate card frozen at placement, ignoring a shop or category override published afterwards", async () => {
      const owner = await shop();
      await publish({ type: "global" }, cardWith("after_shop_discount"));
      await put(owner.headers, percentage("10"));
      const { who, id, listings } = await accepted(owner, ["200", "100"]);
      const categoryId = (await database.pool.query<{ id: string }>("SELECT id FROM categories LIMIT 1")).rows[0]?.id ?? "";
      // After placement: a shop override (different formula, base) and a category override (different percentage).
      expect((await publish({ type: "shop", id: owner.shopId }, { commission: { formula: "fixed", fixedAmount: "99", percentage: null, minimum: null, maximum: null, base: "before_shop_discount" } })).statusCode).toBe(201);
      expect((await publish({ type: "category", id: categoryId }, { commission: { formula: "percentage", fixedAmount: null, percentage: "50", minimum: null, maximum: null, base: "before_shop_discount" } })).statusCode).toBe(201);
      await propose(owner, id, [listings[1] ?? ""]);
      await confirm(who, id);
      // Still 10% of the 180 left after the 20 discount, as the order was placed.
      expect(await revisions(id)).toMatchObject([{ product: "200.00", discount: "20.00", commission: "18.00", total: "210.00" }]);
    });

    it("splits the discount in whole paise across the kept lines and always adds up", async () => {
      const owner = await shop();
      await publish({ type: "global" }, card);
      await put(owner.headers, percentage("5"));
      const { who, id, listings } = await accepted(owner, ["33.33", "33.33", "33.34"]);
      await propose(owner, id, [listings[0] ?? ""]);
      await confirm(who, id);
      // 66.67 at 5% is 3.3335, rounded half up to 3.33; the 1 paisa left over goes to the largest line.
      expect(await revisions(id)).toMatchObject([{ product: "66.67", discount: "3.33", lines: "3.33", total: "93.34" }]);
      expect((await database.pool.query<{ share: string }>(
        "SELECT shop_discount::text AS share FROM order_revision_lines WHERE revision_id = (SELECT id FROM order_revisions WHERE order_id = $1) AND count > 0 ORDER BY position", [id])).rows.map((row) => row.share)).toEqual(["1.66", "1.67"]);
    });

    it("gives a revision of an order that had no discount none, and no rule", async () => {
      const owner = await shop();
      await publish({ type: "global" }, card);
      const { who, id, listings } = await accepted(owner, ["200", "100"]);
      await propose(owner, id, [listings[1] ?? ""]);
      await confirm(who, id);
      expect(await orderOf(who, id)).toMatchObject({ productValue: "200.00", shopDiscount: null, total: "230.00" });
      expect(await revisions(id)).toMatchObject([{ discount: "0.00", rule: null, version: null, total: "230.00" }]);
    });

    it("lets a second partial acceptance follow one that removed a line entirely (#579)", async () => {
      const owner = await shop();
      await publish({ type: "global" }, card);
      await put(owner.headers, percentage("10"));
      const { who, id, listings } = await accepted(owner, ["200", "100x2"]);
      await propose(owner, id, [listings[0] ?? ""]);
      expect((await confirm(who, id)).statusCode).toBe(200);
      // The removed line is gone; the next proposal reduces what is left, and a revision cannot bring the removed line back.
      const back = await app.inject({ method: "POST", url: `/v1/me/shop-orders/${id}/partial-accept/preview`, headers: owner.headers, payload: remove([listings[0] ?? ""]) });
      expect(back.statusCode).toBe(400);
      const again = await app.inject({ method: "POST", url: `/v1/me/shop-orders/${id}/partial-accept`, headers: owner.headers, payload: remove([[listings[1] ?? "", 1]]) });
      expect(again.statusCode).toBe(200);
      expect(again.json().proposal).toMatchObject({ productValue: "100.00", shopDiscount: { amount: "10.00" } });
      expect(again.json().proposal.lines).toHaveLength(1);
    });

    it("refuses at the database a revision that does not add up, and never lets a confirmed one change", async () => {
      const owner = await shop();
      await publish({ type: "global" }, card);
      await put(owner.headers, percentage("10"));
      const { who, id, listings } = await accepted(owner, ["200", "100"]);
      const { rows: [placed] } = await database.pool.query<{ rule: string; version: number }>("SELECT shop_discount_rule_id AS rule, shop_discount_rule_version AS version FROM orders WHERE id = $1", [id]);
      const insert = (discount: string, total: string, rule: string | null, version: number | null) => database.pool.query(
        `INSERT INTO order_revisions (order_id, revision, status, source_status, actor_role, product_value, delivery_fee, total, commission, platform_contribution,
           quote, below_floor_exception, confirm_by_at, created_at, shop_discount, shop_discount_rule_id, shop_discount_rule_version)
         VALUES ($1, 9, 'proposed', 'accepted', 'owner', 100, 30, $2, 10, 20, '{}'::jsonb, false, now() + interval '5 min', now(), $3, $4, $5)`, [id, total, discount, rule, version]);
      // A total that does not reconcile to the paisa, a discount over the product value, a discount with no rule, and one that is not the sum of its lines.
      await expect(insert("10", "121.00", placed?.rule ?? null, placed?.version ?? null)).rejects.toThrow(/order_revisions_total_reconciles/);
      await expect(insert("101", "29.00", placed?.rule ?? null, placed?.version ?? null)).rejects.toThrow(/order_revisions_shop_discount_valid/);
      await expect(insert("10", "120.00", null, null)).rejects.toThrow(/order_revisions_shop_discount_valid/);
      await expect(insert("10", "120.00", placed?.rule ?? null, placed?.version ?? null)).rejects.toThrow(/does not add up/);
      // A product value that is not the sum of its lines' totals (here, no lines at all).
      await expect(insert("0", "130.00", null, null)).rejects.toThrow(/does not add up/);
      // A line's discount can never exceed the line's total.
      const { rows: [proposed] } = await database.pool.query<{ id: string }>("SELECT id FROM order_revisions WHERE order_id = $1", [id]);
      expect(proposed).toBeUndefined();
      await propose(owner, id, [listings[1] ?? ""]);
      const { rows: [rev] } = await database.pool.query<{ id: string }>("SELECT id FROM order_revisions WHERE order_id = $1", [id]);
      await expect(database.pool.query(
        `INSERT INTO order_revision_lines (revision_id, position, listing_id, name, base_unit, pack_quantity, original_count, count, unit_price, line_total, commission, shop_discount, stock_quantity)
         VALUES ($1, 99, $2, 'Item', 'each', 1, 1, 1, 10, 10, 1, 10.01, 1)`, [rev?.id, listings[0]])).rejects.toThrow(/order_revision_lines_shop_discount_valid/);

      // Once sent, a revision's figures and discount cannot change, confirmed or not.
      await confirm(who, id);
      await expect(database.pool.query("UPDATE order_revisions SET shop_discount = 0 WHERE id = $1", [rev?.id])).rejects.toThrow(/append-only/);
      await expect(database.pool.query("UPDATE order_revision_lines SET shop_discount = 0 WHERE revision_id = $1", [rev?.id])).rejects.toThrow();
    });
  });
});
