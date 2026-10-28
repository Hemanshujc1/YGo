import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { DELIVERED_EXAMPLES, type ExampleLine } from "@ygo/pricing";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import { createLocalClock } from "../src/adapters/clock";
import { createLocalMailer } from "../src/adapters/mailer";
import { buildApp } from "../src/app";
import { bootstrapAdmin } from "../src/bootstrap";
import { connectDatabase } from "../src/db";

const rootUrl = inject("databaseUrl");
const secret = "01234567890123456789012345678901";
const adminEmail = "admin@example.com";
const clock = createLocalClock(new Date("2030-01-01T00:00:00.000Z"));
const mailer = createLocalMailer();
let name: string;
let database: ReturnType<typeof connectDatabase>;
let app: ReturnType<typeof buildApp>;
let headers: { authorization: string };

beforeEach(async () => {
  name = `ygo_pricing_${randomUUID().replaceAll("-", "")}`;
  const root = new pg.Client({ connectionString: rootUrl });
  await root.connect();
  try { await root.query(`CREATE DATABASE ${name}`); } finally { await root.end(); }
  const url = new URL(rootUrl);
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.href });
  try {
    await client.connect();
    await migrate(drizzle({ client }), { migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)) });
  } finally { await client.end(); }
  database = connectDatabase(url.href);
  await bootstrapAdmin(database.pool, { email: adminEmail, name: "Ravi Admin", phone: "+919812345678" });
  clock.set(new Date("2030-01-01T00:00:00.000Z"));
  mailer.sent.length = 0;
  app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret });
  await app.inject({ method: "POST", url: "/v1/admin/auth/code", payload: { email: adminEmail } });
  const code = mailer.sent.findLast((sent) => sent.to === adminEmail)?.text.match(/code is (\d{6})/)?.[1];
  const signed = await app.inject({ method: "POST", url: "/v1/admin/auth/verify", payload: { email: adminEmail, code } });
  headers = { authorization: `Bearer ${signed.json().accessToken as string}` };
});

afterEach(async () => {
  await app.close();
  await database.close();
  const root = new pg.Client({ connectionString: rootUrl });
  try { await root.connect(); await root.query(`DROP DATABASE ${name} WITH (FORCE)`); } finally { await root.end(); }
});

async function newShop(): Promise<string> {
  return String((await database.pool.query("INSERT INTO shops (created_at) VALUES ($1) RETURNING id", [clock.now()])).rows[0]?.id);
}

async function category(label: string): Promise<string> {
  const found = await database.pool.query("SELECT id FROM categories WHERE name = $1", [label]);
  return String((found.rows[0] ?? (await database.pool.query("INSERT INTO categories (name) VALUES ($1) RETURNING id", [label])).rows[0])?.id);
}

/** Lists one product for the line and returns the simulator's basket line for it. */
async function stock(shopId: string, line: ExampleLine): Promise<{ listingId: string; count: number } | { quantityOptionId: string; count: number }> {
  const productId = (await database.pool.query(
    "INSERT INTO master_products (name, category_id, base_unit, classification) VALUES ($1, $2, 'each', 'counted') RETURNING id",
    [`Product ${randomUUID()}`, await category(line.category)])).rows[0]?.id;
  const packId = (await database.pool.query("INSERT INTO packs (product_id, quantity) VALUES ($1, '1') RETURNING id", [productId])).rows[0]?.id;
  const listingPrice = line.quantityOption ? "999.00" : line.unitPrice;
  const listingId = String((await database.pool.query(
    "INSERT INTO shop_listings (shop_id, pack_id, online_price, counter_price, mrp) VALUES ($1, $2, $3, $3, $3) RETURNING id",
    [shopId, packId, listingPrice])).rows[0]?.id);
  if (!line.quantityOption) return { listingId, count: line.count };
  const optionId = String((await database.pool.query(
    "INSERT INTO shop_quantity_price_options (listing_id, quantity, price, name) VALUES ($1, '2', $2, 'Twin pack') RETURNING id",
    [listingId, line.unitPrice])).rows[0]?.id);
  return { quantityOptionId: optionId, count: line.count };
}

function publish(scope: object, values: object) {
  return app.inject({ method: "POST", url: "/v1/admin/rate-cards/publish", headers, payload: { scope, values, reason: "Worked example" } });
}

function simulate(payload: object, auth: Record<string, string> = headers) {
  return app.inject({ method: "POST", url: "/v1/admin/price-simulator", headers: auth, payload });
}

const globalCard = {
  commission: { formula: "percentage", fixedAmount: null, percentage: "10", minimum: null, maximum: null, base: "before_shop_discount" },
  deliveryFee: { amount: "30", split: { platformPercentage: "20", shopPercentage: "80" } },
  deliveredContributionFloor: "15", minimumCart: "100", statementGraceDays: 7,
};

describe("Delivered-route worked examples through the price simulator (#357, Q-6)", () => {
  it.each(DELIVERED_EXAMPLES.map((example) => [example.name, example] as const))("%s", async (_name, example) => {
    const shopId = await newShop();
    for (const card of example.cards) {
      const scope = card.scope.type === "shop" ? { type: "shop", id: shopId }
        : card.scope.type === "category" ? { type: "category", id: await category(card.scope.category) } : card.scope;
      expect((await publish(scope, card.values)).statusCode).toBe(201);
    }
    const lines = [];
    for (const line of example.lines) lines.push(await stock(shopId, line));

    const response = await simulate({ shopId, lines });
    expect(response.statusCode).toBe(200);
    const { now, draft } = response.json();
    expect(draft).toBeNull();
    expect(now).toMatchObject({ status: "priced", ...example.expected });
  });
});

describe("Price simulator (#357)", () => {
  it("shows each line's price, category and commission source, and the order-level sources", async () => {
    const shopId = await newShop();
    const dairy = await category("Dairy");
    await publish({ type: "global" }, globalCard);
    await publish({ type: "category", id: dairy }, { commission: { ...globalCard.commission, percentage: "5" }, minimumCart: "500" });
    const line = await stock(shopId, { category: "Dairy", unitPrice: "120.00", count: 1 });

    const { now } = (await simulate({ shopId, lines: [line] })).json();
    expect(now.rateCardVersion).toBe("2");
    expect(now.lines).toEqual([{
      ...line, quantityOptionId: null, categoryId: dairy, unitPrice: "120.00", count: 1, lineTotal: "120.00", commission: "6.00",
      commissionSource: { type: "category", id: dairy, version: "2" },
    }]);
    expect(now.sources).toEqual({
      deliveryFee: { type: "global", id: null, version: "1" },
      deliveredContributionFloor: { type: "global", id: null, version: "1" },
      minimumCart: { type: "global", id: null, version: "1" },
    });
  });

  it("tries a draft rule as if published next, beside Now, without saving it", async () => {
    const shopId = await newShop();
    await publish({ type: "global" }, globalCard);
    const line = await stock(shopId, { category: "Groceries", unitPrice: "200.00", count: 1 });
    const draft = { scope: { type: "shop", id: shopId }, values: { commission: { ...globalCard.commission, percentage: "2" } } };

    const response = await simulate({ shopId, lines: [line], draft });
    expect(response.statusCode).toBe(200);
    const { now, draft: tried } = response.json();
    expect(now).toMatchObject({ rateCardVersion: "1", commission: "20.00", platformContribution: "26.00", placeable: true });
    expect(tried).toMatchObject({ rateCardVersion: "2", commission: "4.00", platformContribution: "10.00", placeable: false,
      reasons: [{ code: "BELOW_CONTRIBUTION_FLOOR", shortfall: "5.00" }] });
    expect(tried.lines[0].commissionSource).toEqual({ type: "shop", id: shopId, version: "2" });
    // The draft's other fields still inherit from the published global card.
    expect(tried.sources.deliveryFee).toEqual({ type: "global", id: null, version: "1" });
    expect((await database.pool.query("SELECT count(*)::int AS n FROM rate_card_versions")).rows[0]?.n).toBe(1);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM admin_actions WHERE action = 'rate_card.publish'")).rows[0]?.n).toBe(1);
  });

  it("names the missing values when the rate card cannot price a delivered order, and prices a first draft", async () => {
    const shopId = await newShop();
    const line = await stock(shopId, { category: "Groceries", unitPrice: "200.00", count: 1 });
    const { now, draft } = (await simulate({ shopId, lines: [line], draft: { scope: { type: "global" }, values: globalCard } })).json();
    expect(now).toEqual({ status: "incomplete", rateCardVersion: "0", missing: ["commission", "deliveryFee", "deliveredContributionFloor", "minimumCart"] });
    expect(draft).toMatchObject({ status: "priced", rateCardVersion: "1", customerTotal: "230.00" });

    await publish({ type: "global" }, { ...globalCard, smallCartFee: { enabled: true, threshold: "50", amount: "5", cap: null, split: { platformPercentage: "100", shopPercentage: "0" } } });
    expect((await simulate({ shopId, lines: [line] })).json().now).toMatchObject({ status: "priced", smallCartFee: null, customerTotal: "230.00" });
  });

  it("shows a shop keeping less than nothing when its fixed commission exceeds the line", async () => {
    const shopId = await newShop();
    await publish({ type: "global" }, { ...globalCard, commission: { ...globalCard.commission, formula: "fixed", fixedAmount: "12", percentage: null },
      deliveryFee: { amount: "0", split: { platformPercentage: "100", shopPercentage: "0" } } });
    const line = await stock(shopId, { category: "Groceries", unitPrice: "5.00", count: 1 });
    const response = await simulate({ shopId, lines: [line] });
    expect(response.statusCode).toBe(200);
    expect(response.json().now).toMatchObject({ customerTotal: "5.00", shopKeeps: "-7.00", platformContribution: "12.00" });
  });

  it("charges a fixed commission once per line, whatever the count, and once more for each further line", async () => {
    const shopId = await newShop();
    await publish({ type: "global" }, { ...globalCard, commission: { ...globalCard.commission, formula: "fixed", fixedAmount: "12", percentage: null } });
    const lines = [await stock(shopId, { category: "Groceries", unitPrice: "10.00", count: 5 }), await stock(shopId, { category: "Groceries", unitPrice: "20.00", count: 3 })];
    expect((await simulate({ shopId, lines })).json().now).toMatchObject({
      lines: [{ lineTotal: "50.00", commission: "12.00" }, { lineTotal: "60.00", commission: "12.00" }], productValue: "110.00", commission: "24.00",
    });
  });

  it("prices a listing the shop has marked unavailable, and a quantity option of one", async () => {
    const shopId = await newShop();
    await publish({ type: "global" }, globalCard);
    const lines = [await stock(shopId, { category: "Groceries", unitPrice: "70.00", count: 1 }), await stock(shopId, { category: "Groceries", unitPrice: "45.00", count: 2, quantityOption: true })];
    await database.pool.query("UPDATE shop_listings SET available = false WHERE shop_id = $1", [shopId]);
    const response = await simulate({ shopId, lines });
    expect(response.statusCode).toBe(200);
    expect(response.json().now).toMatchObject({ status: "priced", productValue: "160.00", commission: "16.00", customerTotal: "190.00" });
  });

  it("leaves every amount alone for a draft whose category is not in the basket, numbering it as the next version", async () => {
    const shopId = await newShop();
    await publish({ type: "global" }, globalCard);
    const dairy = await category("Dairy");
    const line = await stock(shopId, { category: "Groceries", unitPrice: "200.00", count: 1 });
    const draft = { scope: { type: "category", id: dairy }, values: { commission: { ...globalCard.commission, formula: "fixed", fixedAmount: "50", percentage: null }, minimumCart: "999" } };
    const { now, draft: tried } = (await simulate({ shopId, lines: [line], draft })).json();
    const { rateCardVersion: nowVersion, ...nowAmounts } = now;
    const { rateCardVersion: draftVersion, ...draftAmounts } = tried;
    expect([nowVersion, draftVersion]).toEqual(["1", "2"]);
    expect(draftAmounts).toEqual(nowAmounts);
    expect(tried.lines[0].commissionSource).toEqual({ type: "global", id: null, version: "1" });
  });

  it("falls back to the parent category's commission, below the child's and the shop's, for Now and for drafts", async () => {
    const shopId = await newShop();
    const dairy = await category("Dairy");
    const milk = String((await database.pool.query("INSERT INTO categories (name, parent_id) VALUES ('Milk', $1) RETURNING id", [dairy])).rows[0]?.id);
    const fixed = (amount: string) => ({ ...globalCard.commission, formula: "fixed", fixedAmount: amount, percentage: null });
    await publish({ type: "global" }, globalCard);
    // The parent's minimum cart stays out of order-level values, like any category card's.
    await publish({ type: "category", id: dairy }, { commission: fixed("5"), minimumCart: "999" });
    const line = await stock(shopId, { category: "Milk", unitPrice: "200.00", count: 1 });
    const quote = async (draft?: object) => (await simulate({ shopId, lines: [line], ...(draft ? { draft } : {}) })).json();

    // Parent fallback, in Now and in a draft on the parent.
    let result = await quote({ scope: { type: "category", id: dairy }, values: { commission: fixed("7") } });
    expect(result.now).toMatchObject({ reasons: [{ code: "BELOW_CONTRIBUTION_FLOOR", shortfall: "4.00" }], lines: [{ categoryId: milk, commission: "5.00", commissionSource: { type: "category", id: dairy, version: "2" } }] });
    expect(result.draft.lines[0]).toMatchObject({ commission: "7.00", commissionSource: { type: "category", id: dairy, version: "3" } });

    // The child overrides the parent, and a parent draft cannot reach past it.
    await publish({ type: "category", id: milk }, { commission: fixed("3") });
    result = await quote({ scope: { type: "category", id: dairy }, values: { commission: fixed("9") } });
    expect(result.now.lines[0]).toMatchObject({ commission: "3.00", commissionSource: { type: "category", id: milk, version: "3" } });
    expect(result.draft.lines[0]).toMatchObject({ commission: "3.00", commissionSource: { type: "category", id: milk, version: "3" } });

    // The shop overrides both, and a child draft cannot reach past it.
    await publish({ type: "shop", id: shopId }, { commission: { ...globalCard.commission, percentage: "2" } });
    result = await quote({ scope: { type: "category", id: milk }, values: { commission: fixed("1") } });
    expect(result.now.lines[0]).toMatchObject({ commission: "4.00", commissionSource: { type: "shop", id: shopId, version: "4" } });
    expect(result.draft.lines[0]).toMatchObject({ commission: "4.00", commissionSource: { type: "shop", id: shopId, version: "4" } });
  });

  it("resolves a child category field by field: the child's own fields, then the parent's, then global", async () => {
    const shopId = await newShop();
    const dairy = await category("Dairy");
    const milk = String((await database.pool.query("INSERT INTO categories (name, parent_id) VALUES ('Milk', $1) RETURNING id", [dairy])).rows[0]?.id);
    await publish({ type: "global" }, globalCard);
    await publish({ type: "category", id: dairy }, { commission: { ...globalCard.commission, percentage: "5" }, statementGraceDays: 3 });
    await publish({ type: "category", id: milk }, { commission: { ...globalCard.commission, percentage: "4" } });
    const effective = (categoryId: string) => app.inject({ method: "GET", url: `/v1/admin/rate-cards/effective?shopId=${shopId}&categoryId=${categoryId}`, headers });

    const card = (await effective(milk)).json();
    expect(card.values.commission).toMatchObject({ value: { percentage: "4" }, source: { type: "category", id: milk, version: "3" } });
    expect(card.values.statementGraceDays).toEqual({ value: 3, source: { type: "category", id: dairy, version: "2" } });
    expect(card.values.deliveryFee.source).toEqual({ type: "global", id: null, version: "1" });
    // The parent itself never reads its child's card.
    expect((await effective(dairy)).json().values.commission.source).toEqual({ type: "category", id: dairy, version: "2" });
  });

  it("refuses lines from another shop, unknown shops, bad baskets and callers who are not signed in", async () => {
    const shopId = await newShop();
    const otherShop = await newShop();
    await publish({ type: "global" }, globalCard);
    const mine = await stock(shopId, { category: "Groceries", unitPrice: "200.00", count: 1 });
    const theirs = await stock(otherShop, { category: "Groceries", unitPrice: "10.00", count: 1, quantityOption: true });

    expect((await simulate({ shopId, lines: [mine, theirs] })).statusCode).toBe(404);
    expect((await simulate({ shopId: randomUUID(), lines: [mine] })).statusCode).toBe(404);
    expect((await simulate({ shopId, lines: [{ ...mine, count: 0 }] })).statusCode).toBe(400);
    expect((await simulate({ shopId, lines: [] })).statusCode).toBe(400);
    expect((await simulate({ shopId, lines: [mine], draft: { scope: { type: "global" }, values: { minimumCart: "1.234" } } })).statusCode).toBe(400);
    expect((await simulate({ shopId, lines: [mine] }, {})).statusCode).toBe(401);
    const commission = globalCard.commission;
    expect((await simulate({ shopId, lines: [mine], draft: { scope: { type: "shop", id: otherShop }, values: { commission } } })).statusCode).toBe(404);
    expect((await simulate({ shopId, lines: [mine], draft: { scope: { type: "category", id: randomUUID() }, values: { commission } } })).statusCode).toBe(404);
  });
});
