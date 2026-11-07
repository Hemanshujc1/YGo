import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";
import type { DeliveryPhotoStorage } from "../src/adapters/delivery-photos";
import { createLocalClock } from "../src/adapters/clock";
import { createLocalMailer } from "../src/adapters/mailer";
import { buildApp } from "../src/app";
import { bootstrapAdmin } from "../src/bootstrap";
import { customerFailedDeliveries } from "../src/customer-refusals";
import { connectDatabase } from "../src/db";
import { createTestDatabase } from "./test-database";

const rootUrl = inject("databaseUrl");
const secret = "01234567890123456789012345678901";
const admin = { email: "initial-admin@example.com", name: "Asha Kulkarni", phone: "+919876543210" };
const clock = createLocalClock(new Date("2030-01-01T00:00:00.000Z"));
const mailer = createLocalMailer();
let name: string;
let database: ReturnType<typeof connectDatabase>;
let app: ReturnType<typeof buildApp>;
let rateCard: string;
const photos = { downloadUrl: vi.fn(async (key: string) => `https://photos.example.test/${key}?X-Amz-Signature=sig`) } as unknown as DeliveryPhotoStorage & { downloadUrl: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  name = `ygo_proof_exceptions_${randomUUID().replaceAll("-", "")}`;
  const url = await createTestDatabase(name);
  database = connectDatabase(url.href);
  await bootstrapAdmin(database.pool, admin);
  clock.set(new Date("2030-01-01T00:00:00.000Z"));
  mailer.sent.length = 0;
  app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret, deliveryPhotos: photos });
  photos.downloadUrl.mockClear();
  const { rows: [actor] } = await database.pool.query<{ id: string }>("SELECT id FROM accounts WHERE email = $1", [admin.email]);
  const { rows: [card] } = await database.pool.query<{ version: string }>(
    "INSERT INTO rate_card_versions (actor_id, scope_type, reason, published_at) VALUES ($1, 'global', 'test', $2) RETURNING version", [actor?.id, clock.now()]);
  rateCard = String(card?.version);
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

async function signIn(email: string, url = "/v1/admin/auth") {
  expect((await app.inject({ method: "POST", url: `${url}/code`, payload: { email } })).statusCode).toBe(204);
  const code = mailer.sent.findLast((sent) => sent.to === email)?.text.match(/code is (\d{6})/)?.[1] ?? "";
  const verify = await app.inject({ method: "POST", url: `${url}/verify`, payload: { email, code } });
  expect(verify.statusCode).toBe(200);
  return { authorization: `Bearer ${verify.json().accessToken as string}` };
}

const account = async (email: string, accountName: string | null = null) =>
  String((await database.pool.query<{ id: string }>("INSERT INTO accounts (email, name) VALUES ($1, $2) RETURNING id", [email, accountName])).rows[0]?.id);
const manager = async (email: string) => {
  const id = await account(email, "Ravi Patil");
  await database.pool.query("INSERT INTO area_manager_memberships (account_id) VALUES ($1)", [id]);
  return id;
};
const shop = async (areaManagerId: string | null) =>
  String((await database.pool.query<{ id: string }>("INSERT INTO shops (created_at, area_manager_id) VALUES ($1, $2) RETURNING id", [clock.now(), areaManagerId])).rows[0]?.id);

type Seed = { shopId: string; customerId: string; delivererId?: string | null; status?: string; exception?: string | null; failure?: string | null; at?: string; shopName?: string; photo?: { key: string; expiresAt: string } };
/** A closed order written straight to the table: the delivery flow itself is tested with #521 and #56. */
async function order({ shopId, customerId, delivererId = null, status = "delivered", exception = null, failure = null, at = "2030-01-01T00:00:00.000Z", shopName = "Sai General Stores", photo }: Seed) {
  const { rows: [row] } = await database.pool.query<{ id: string }>(
    `INSERT INTO orders (account_id, shop_id, status, placed_at, status_changed_at, shop_name, shop_address, shop_pincode, address_label, address_flat, address_pincode,
        address_point, product_value, delivery_fee, total, rate_card_version, quote, deliverer_id, proof_exception, proof_exception_reason, failed_delivery_reason, delivery_photo_key, delivery_photo_expires_at)
     VALUES ($1, $2, $3, $4, $4, $5, '12 Lane', '411038', 'home', 'Flat 1', '411038', ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography,
        100, 20, 120, $6, '{}'::jsonb, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [customerId, shopId, status, at, shopName, rateCard, delivererId, exception !== null, exception, failure, photo?.key ?? null, photo?.expiresAt ?? null]);
  return String(row?.id);
}

type Row = { orderId: string; reason: string; reviewed: { at: string; by: string | null } | null; shop: { id: string; name: string }; deliverer: { id: string; name: string | null }; recordedAt: string };
const list = async (headers: Record<string, string>, query = "") => app.inject({ method: "GET", url: `/v1/admin/proof-exceptions${query}`, headers });
const review = (headers: Record<string, string>, orderId: string) => app.inject({ method: "POST", url: `/v1/admin/proof-exceptions/${orderId}/review`, headers });

describe("A28 proof exceptions (DLV-4, #60)", () => {
  it("lists proof exceptions newest first with counts per shop and per deliverer, leaving out every other order", async () => {
    const customerId = await account("c@example.com");
    const asha = await account("asha@example.com", "Asha");
    const dev = await account("dev@example.com", "Dev");
    const [sai, kothrud] = [await shop(null), await shop(null)];
    const first = await order({ shopId: sai, customerId, delivererId: asha, exception: "someone_else_receiving", at: "2030-01-01T10:00:00.000Z" });
    const second = await order({ shopId: sai, customerId, delivererId: dev, exception: "customer_phone_unavailable", at: "2030-01-02T10:00:00.000Z" });
    const third = await order({ shopId: kothrud, customerId, delivererId: asha, exception: "other", at: "2030-01-03T10:00:00.000Z", shopName: "Kothrud Mart" });
    await order({ shopId: sai, customerId, delivererId: asha });
    await order({ shopId: sai, customerId, delivererId: asha, status: "delivery_failed", failure: "no_one_at_address" });
    const headers = await signIn(admin.email);
    await review(headers, first);

    const answer = await list(headers);
    expect(answer.statusCode).toBe(200);
    const body = answer.json() as { exceptions: Row[]; nextCursor: string | null; counts: { shops: unknown[]; deliverers: unknown[] } };
    expect(body.exceptions.map((row) => row.orderId)).toEqual([third, second]);
    expect(body.exceptions[0]).toMatchObject({ reason: "other", shop: { id: kothrud, name: "Kothrud Mart" }, deliverer: { id: asha, name: "Asha" }, reviewed: null, recordedAt: "2030-01-03T10:00:00.000Z" });
    expect(body.nextCursor).toBeNull();
    // Counted over every proof exception, so the reviewed one is in the totals and out of `open`.
    expect(body.counts.shops).toEqual([
      { shopId: sai, name: "Sai General Stores", total: 2, open: 1 },
      { shopId: kothrud, name: "Kothrud Mart", total: 1, open: 1 },
    ]);
    expect(body.counts.deliverers).toEqual(expect.arrayContaining([
      { accountId: asha, name: "Asha", total: 2, open: 1 },
      { accountId: dev, name: "Dev", total: 1, open: 1 },
    ]));
    // One row per deliverer, whatever number of shops they delivered for.
    expect(body.counts.deliverers).toHaveLength(2);
  });

  it("shows the Reviewed tab with who reviewed and when", async () => {
    const customerId = await account("c@example.com");
    const delivererId = await account("asha@example.com", "Asha");
    const shopId = await shop(null);
    const id = await order({ shopId, customerId, delivererId, exception: "customer_phone_not_present" });
    const headers = await signIn(admin.email);
    clock.advance(60_000);
    expect((await list(headers, "?status=reviewed")).json().exceptions).toEqual([]);
    expect((await review(headers, id)).statusCode).toBe(200);
    expect((await list(headers)).json().exceptions).toEqual([]);
    const reviewed = (await list(headers, "?status=reviewed")).json().exceptions as Row[];
    expect(reviewed.map((row) => [row.orderId, row.reviewed])).toEqual([[id, { at: "2030-01-01T00:01:00.000Z", by: admin.name }]]);
  });

  it("refuses a caller who is not signed in, a Customer, and a mark on someone else's behalf", async () => {
    expect((await list({})).statusCode).toBe(401);
    expect((await review({}, randomUUID())).statusCode).toBe(401);
    await account("customer@example.com");
    const customer = await signIn("customer@example.com", "/v1/auth");
    expect((await list(customer)).statusCode).toBe(403);
    expect((await review(customer, randomUUID())).statusCode).toBe(403);
  });

  it("gives an Area Manager only their own shops, in the list and in the counts, and refuses a mark on another's with NOT_FOUND", async () => {
    const customerId = await account("c@example.com");
    const delivererId = await account("asha@example.com", "Asha");
    const mine = await manager("ravi@example.com");
    const other = await manager("meera@example.com");
    const [ownShop, otherShop, adminShop] = [await shop(mine), await shop(other), await shop(null)];
    const own = await order({ shopId: ownShop, customerId, delivererId, exception: "other" });
    const theirs = await order({ shopId: otherShop, customerId, delivererId, exception: "other" });
    const adminOwn = await order({ shopId: adminShop, customerId, delivererId, exception: "other" });
    const ravi = await signIn("ravi@example.com");

    const seen = (await list(ravi)).json() as { exceptions: Row[]; counts: { shops: Array<{ shopId: string }>; deliverers: Array<{ accountId: string; total: number }> } };
    expect(seen.exceptions.map((row) => row.orderId)).toEqual([own]);
    expect(seen.counts.shops.map((row) => row.shopId)).toEqual([ownShop]);
    // Asha delivered for three shops, but an Area Manager is counted only her one exception in their own.
    expect(seen.counts.deliverers).toEqual([expect.objectContaining({ accountId: delivererId, total: 1 })]);
    // Asking for another shop narrows nothing open: it finds nothing.
    expect((await list(ravi, `?shopId=${otherShop}`)).json().exceptions).toEqual([]);

    for (const id of [theirs, adminOwn]) {
      expect((await review(ravi, id)).json()).toEqual({ error: { code: "NOT_FOUND" } });
      expect((await database.pool.query("SELECT 1 FROM proof_exception_reviews WHERE order_id = $1", [id])).rowCount).toBe(0);
    }
    expect((await review(ravi, own)).statusCode).toBe(200);
    expect((await review(ravi, own)).json().reviewed.by).toBe("Ravi Patil");
    // Admin sees every shop's (the one Ravi reviewed is now under Reviewed) and may mark any.
    const headers = await signIn(admin.email);
    expect(((await list(headers)).json().exceptions as Row[]).map((row) => row.orderId).sort()).toEqual([theirs, adminOwn].sort());
    expect(((await list(headers, "?status=reviewed")).json().exceptions as Row[]).map((row) => row.orderId)).toEqual([own]);
    expect((await review(headers, theirs)).statusCode).toBe(200);
  });

  it("takes a shop away from an Area Manager's list when Admin reassigns it", async () => {
    const customerId = await account("c@example.com");
    const mine = await manager("ravi@example.com");
    const shopId = await shop(mine);
    const id = await order({ shopId, customerId, delivererId: await account("asha@example.com"), exception: "other" });
    const ravi = await signIn("ravi@example.com");
    expect((await list(ravi)).json().exceptions).toHaveLength(1);
    await database.pool.query("UPDATE shops SET area_manager_id = NULL WHERE id = $1", [shopId]);
    expect((await list(ravi)).json().exceptions).toEqual([]);
    expect((await review(ravi, id)).statusCode).toBe(404);
  });

  it("marks reviewed once: a repeat keeps the first reviewer and time, writes no second row, and answers the same", async () => {
    const customerId = await account("c@example.com");
    const first = await manager("ravi@example.com");
    const shopId = await shop(first);
    const id = await order({ shopId, customerId, delivererId: await account("asha@example.com"), exception: "other" });
    const ravi = await signIn("ravi@example.com");
    const marked = await review(ravi, id);
    clock.advance(60_000);
    // Admin marks it again a minute later.
    const again = await review(await signIn(admin.email), id);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(marked.json());
    expect(marked.json().reviewed).toEqual({ at: "2030-01-01T00:00:00.000Z", by: "Ravi Patil" });
    expect((await database.pool.query("SELECT count(*)::int AS n FROM proof_exception_reviews WHERE order_id = $1", [id])).rows[0]?.n).toBe(1);
  });

  it("settles two marks at once on one row", async () => {
    const customerId = await account("c@example.com");
    const shopId = await shop(null);
    const id = await order({ shopId, customerId, delivererId: await account("asha@example.com"), exception: "other" });
    const headers = await signIn(admin.email);
    const answers = await Promise.all([review(headers, id), review(headers, id), review(headers, id)]);
    expect(answers.map((answer) => answer.statusCode)).toEqual([200, 200, 200]);
    expect(new Set(answers.map((answer) => answer.body)).size).toBe(1);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM proof_exception_reviews")).rows[0]?.n).toBe(1);
  });

  it("answers NOT_FOUND for an order that is no proof exception, or does not exist, and writes nothing", async () => {
    const customerId = await account("c@example.com");
    const shopId = await shop(null);
    const delivererId = await account("asha@example.com");
    const plain = await order({ shopId, customerId, delivererId });
    const failed = await order({ shopId, customerId, delivererId, status: "delivery_failed", failure: "no_one_at_address" });
    const headers = await signIn(admin.email);
    for (const id of [plain, failed, randomUUID()]) expect((await review(headers, id)).json()).toEqual({ error: { code: "NOT_FOUND" } });
    expect((await review(headers, "not-a-uuid")).statusCode).toBe(400);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM proof_exception_reviews")).rows[0]?.n).toBe(0);
  });

  it("pages newest first without a gap or a repeat, even when two deliveries closed at the same moment", async () => {
    const customerId = await account("c@example.com");
    const delivererId = await account("asha@example.com");
    const shopId = await shop(null);
    const ids = [];
    for (const at of ["2030-01-01T09:00:00.000Z", "2030-01-02T09:00:00.000Z", "2030-01-03T09:00:00.000Z", "2030-01-03T09:00:00.000Z", "2030-01-03T09:00:00.000Z"]) {
      ids.push(await order({ shopId, customerId, delivererId, exception: "other", at }));
    }
    const headers = await signIn(admin.email);
    const seen: string[] = [];
    let cursor: string | null = null;
    const pages: number[] = [];
    do {
      const page = (await list(headers, `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).json() as { exceptions: Row[]; nextCursor: string | null };
      pages.push(page.exceptions.length);
      seen.push(...page.exceptions.map((row) => row.orderId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(pages).toEqual([2, 2, 1]);
    expect(new Set(seen).size).toBe(5);
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(seen.slice(-2)).toEqual([ids[1], ids[0]].map(String));
    // A page that ends exactly at the last row has no next page.
    expect((await list(headers, "?limit=5")).json().nextCursor).toBeNull();
    expect((await list(headers, "?limit=4")).json().nextCursor).not.toBeNull();
  });

  it("filters by shop and by deliverer, and keeps the counts to the whole of what the caller may see", async () => {
    const customerId = await account("c@example.com");
    const [asha, dev] = [await account("asha@example.com", "Asha"), await account("dev@example.com", "Dev")];
    const [sai, kothrud] = [await shop(null), await shop(null)];
    const a = await order({ shopId: sai, customerId, delivererId: asha, exception: "other", at: "2030-01-01T10:00:00.000Z" });
    const b = await order({ shopId: sai, customerId, delivererId: dev, exception: "other", at: "2030-01-02T10:00:00.000Z" });
    const c = await order({ shopId: kothrud, customerId, delivererId: asha, exception: "other", at: "2030-01-03T10:00:00.000Z" });
    const headers = await signIn(admin.email);
    const ids = async (query: string) => ((await list(headers, query)).json().exceptions as Row[]).map((row) => row.orderId);
    expect(await ids(`?shopId=${sai}`)).toEqual([b, a]);
    expect(await ids(`?delivererId=${asha}`)).toEqual([c, a]);
    expect(await ids(`?shopId=${sai}&delivererId=${asha}`)).toEqual([a]);
    expect(await ids(`?shopId=${randomUUID()}`)).toEqual([]);
    expect((await list(headers, `?shopId=${sai}`)).json().counts.shops).toHaveLength(2);
  });

  it("refuses a bad status, limit, cursor or filter", async () => {
    const headers = await signIn(admin.email);
    for (const query of ["?status=closed", "?limit=0", "?limit=101", "?limit=x", "?cursor=nonsense", "?shopId=nope", "?delivererId=nope", "?extra=1"]) {
      expect((await list(headers, query)).statusCode, query).toBe(400);
    }
    expect((await list(headers, "?limit=100")).statusCode).toBe(200);
  });
});

describe("Customer failed-delivery and refusal counts (TRU-5, #60)", () => {
  const now = new Date("2030-02-01T12:00:00.000Z");
  const failedAt = async (customerId: string, shopId: string, at: string, failure = "no_one_at_address", status = "delivery_failed") =>
    order({ shopId, customerId, delivererId: null, status, failure: status === "delivery_failed" ? failure : null, at });

  it("counts each failed delivery once, and a refusal is part of it rather than added to it", async () => {
    const customerId = await account("c@example.com");
    const shopId = await shop(null);
    await failedAt(customerId, shopId, "2030-01-30T12:00:00.000Z", "customer_refused");
    await failedAt(customerId, shopId, "2030-01-31T12:00:00.000Z", "no_one_at_address");
    await failedAt(customerId, shopId, "2030-01-31T13:00:00.000Z", "address_not_found");
    await failedAt(customerId, shopId, "2030-01-31T14:00:00.000Z", "other");
    expect(await customerFailedDeliveries(database.pool, customerId, now)).toEqual({ failed: 4, refused: 1 });
  });

  it("counts none of the Customer's other endings, nor another Customer's, nor a delivery that went through, proof exception or not", async () => {
    const customerId = await account("c@example.com");
    const someone = await account("other@example.com");
    const shopId = await shop(null);
    for (const status of ["cancelled_by_customer", "cancelled_by_shop", "rejected_by_shop", "expired", "not_collected", "delivered", "picked_up"]) {
      await failedAt(customerId, shopId, "2030-01-31T12:00:00.000Z", "customer_refused", status);
    }
    await order({ shopId, customerId, delivererId: await account("asha@example.com"), exception: "other", at: "2030-01-31T12:00:00.000Z" });
    await failedAt(someone, shopId, "2030-01-31T12:00:00.000Z", "customer_refused");
    expect(await customerFailedDeliveries(database.pool, customerId, now)).toEqual({ failed: 0, refused: 0 });
    expect(await customerFailedDeliveries(database.pool, someone, now)).toEqual({ failed: 1, refused: 1 });
  });

  it("holds the 30-day window exactly: the 30th day back counts to the millisecond, one millisecond older does not, and a later one does not yet", async () => {
    const customerId = await account("c@example.com");
    const shopId = await shop(null);
    await failedAt(customerId, shopId, "2030-01-02T12:00:00.000Z", "customer_refused");
    await failedAt(customerId, shopId, "2030-01-02T11:59:59.999Z", "customer_refused");
    await failedAt(customerId, shopId, "2030-02-01T12:00:00.000Z");
    await failedAt(customerId, shopId, "2030-02-01T12:00:00.001Z");
    expect(await customerFailedDeliveries(database.pool, customerId, now)).toEqual({ failed: 2, refused: 1 });
    // A day later the refusal has left the window and the two later failures remain.
    expect(await customerFailedDeliveries(database.pool, customerId, new Date("2030-02-02T12:00:00.000Z"))).toEqual({ failed: 2, refused: 0 });
    expect(await customerFailedDeliveries(database.pool, customerId, new Date("2030-03-05T00:00:00.000Z"))).toEqual({ failed: 0, refused: 0 });
  });

  it("is zero for a Customer with no failures and writes nothing", async () => {
    const customerId = await account("c@example.com");
    expect(await customerFailedDeliveries(database.pool, customerId, now)).toEqual({ failed: 0, refused: 0 });
    expect((await database.pool.query("SELECT count(*)::int AS n FROM proof_exception_reviews")).rows[0]?.n).toBe(0);
  });
});

describe("A28 proof photo access (DLV-4, #560)", () => {
  const keep = { key: "delivery-proofs/o/p.jpg", expiresAt: "2030-01-31T00:00:00.000Z" };
  const photo = (headers: Record<string, string>, orderId: string) => app.inject({ method: "GET", url: `/v1/admin/proof-exceptions/${orderId}/photo`, headers });
  const views = async () => (await database.pool.query<{ order_id: string; viewed_by: string; viewed_at: Date }>("SELECT order_id, viewed_by, viewed_at FROM proof_photo_views ORDER BY viewed_at")).rows;

  it("gives Admin a 5-minute private link for the photo and logs who looked at which order and when", async () => {
    const customerId = await account("c@example.com");
    const id = await order({ shopId: await shop(null), customerId, delivererId: await account("asha@example.com"), exception: "other", photo: keep });
    const headers = await signIn(admin.email);
    const answer = await photo(headers, id);
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual({ downloadUrl: `https://photos.example.test/${keep.key}?X-Amz-Signature=sig`, expiresAt: "2030-01-01T00:05:00.000Z" });
    expect(photos.downloadUrl).toHaveBeenCalledWith(keep.key);
    const logged = await views();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ order_id: id, viewed_at: clock.now() });
    expect((await database.pool.query("SELECT email FROM accounts WHERE id = $1", [logged[0]?.viewed_by])).rows[0]?.email).toBe(admin.email);
    // Each link issued is one row.
    expect((await photo(headers, id)).statusCode).toBe(200);
    expect(await views()).toHaveLength(2);
  });

  it("asks storage for a link of five minutes that no cache keeps", async () => {
    const files = { downloadUrl: vi.fn(async () => "https://photos.example.test/x?X-Amz-Signature=s") };
    const { createDeliveryPhotoStorage } = await import("../src/adapters/delivery-photos");
    await createDeliveryPhotoStorage(files as never).downloadUrl("delivery-proofs/o/p.jpg");
    expect(files.downloadUrl).toHaveBeenCalledWith("delivery-proofs/o/p.jpg", { expiresIn: 300, cacheControl: "private, no-store" });
  });

  it("gives an Area Manager their own shop's photo, and NOT_FOUND for another shop's, logging nothing for it", async () => {
    const customerId = await account("c@example.com");
    const delivererId = await account("asha@example.com");
    const mine = await manager("ravi@example.com");
    const other = await manager("meera@example.com");
    const [ownShop, otherShop] = [await shop(mine), await shop(other)];
    const own = await order({ shopId: ownShop, customerId, delivererId, exception: "other", photo: keep });
    const theirs = await order({ shopId: otherShop, customerId, delivererId, exception: "other", photo: keep });
    const ravi = await signIn("ravi@example.com");
    expect((await photo(ravi, own)).statusCode).toBe(200);
    const refused = await photo(ravi, theirs);
    expect(refused.statusCode).toBe(404);
    expect(refused.json().error.code).toBe("NOT_FOUND");
    expect((await views()).map((row) => row.order_id)).toEqual([own]);
  });

  it("refuses anyone who is not Admin or an Area Manager, and an order that is no proof exception", async () => {
    const customerId = await account("c@example.com");
    const shopId = await shop(null);
    const plain = await order({ shopId, customerId, delivererId: await account("asha@example.com"), photo: keep });
    const failed = await order({ shopId, customerId, status: "delivery_failed", failure: "no_one_at_address", photo: keep });
    const headers = await signIn(admin.email);
    expect((await photo(headers, plain)).statusCode).toBe(404);
    expect((await photo(headers, failed)).statusCode).toBe(404);
    expect((await photo({}, plain)).statusCode).toBe(401);
    const shopper = await signIn("c@example.com", "/v1/auth");
    expect([401, 403]).toContain((await photo(shopper, plain)).statusCode);
    expect(await views()).toEqual([]);
    expect(photos.downloadUrl).not.toHaveBeenCalled();
  });

  it("says PHOTO_EXPIRED when the photo is gone, and 503 with no log when storage cannot give a link", async () => {
    const customerId = await account("c@example.com");
    const shopId = await shop(null);
    const gone = await order({ shopId, customerId, delivererId: await account("asha@example.com"), exception: "other" });
    const there = await order({ shopId, customerId, exception: "other", photo: keep });
    const headers = await signIn(admin.email);
    const missing = await photo(headers, gone);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("PHOTO_EXPIRED");
    // Past its 30 days but not yet swept: gone as far as Admin is concerned.
    const stale = await order({ shopId, customerId, exception: "other", photo: { key: keep.key, expiresAt: "2029-12-31T00:00:00.000Z" } });
    expect((await photo(headers, stale)).json().error.code).toBe("PHOTO_EXPIRED");
    expect(photos.downloadUrl).not.toHaveBeenCalled();
    photos.downloadUrl.mockRejectedValueOnce(new Error("storage down"));
    const down = await photo(headers, there);
    expect(down.statusCode).toBe(503);
    expect(down.json().error.code).toBe("UNAVAILABLE");
    expect(await views()).toEqual([]);
  });

  it("puts only the photo's expiry in the list, never its key or a link, and null once it is gone", async () => {
    const customerId = await account("c@example.com");
    const shopId = await shop(null);
    const delivererId = await account("asha@example.com");
    const withPhoto = await order({ shopId, customerId, delivererId, exception: "other", at: "2030-01-02T00:00:00.000Z", photo: keep });
    const without = await order({ shopId, customerId, delivererId, exception: "other", at: "2030-01-01T00:00:00.000Z" });
    const answer = await list(await signIn(admin.email));
    const rows = answer.json().exceptions as Array<{ orderId: string; photo: unknown }>;
    expect(rows.find((row) => row.orderId === withPhoto)?.photo).toEqual({ expiresAt: "2030-01-31T00:00:00.000Z" });
    expect(rows.find((row) => row.orderId === without)?.photo).toBeNull();
    expect(answer.body).not.toContain(keep.key);
    expect(answer.body).not.toContain("photos.example.test");
    expect(photos.downloadUrl).not.toHaveBeenCalled();
  });
});
