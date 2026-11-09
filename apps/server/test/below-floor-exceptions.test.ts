import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import type { BelowFloorException, BelowFloorExceptionsResponse } from "@ygo/contracts";
import { createLocalClock } from "../src/adapters/clock";
import { createLocalMailer } from "../src/adapters/mailer";
import { buildApp } from "../src/app";
import { bootstrapAdmin } from "../src/bootstrap";
import { connectDatabase } from "../src/db";
import { createTestDatabase } from "./test-database";

const rootUrl = inject("databaseUrl");
const secret = "01234567890123456789012345678901";
const admin = { email: "admin@example.com", name: "Asha Kulkarni", phone: "+919876543210" };
const clock = createLocalClock(new Date("2030-01-01T00:00:00.000Z"));
const mailer = createLocalMailer();
let name: string;
let database: ReturnType<typeof connectDatabase>;
let app: ReturnType<typeof buildApp>;
let rateCard: string;

beforeEach(async () => {
  name = `ygo_below_floor_${randomUUID().replaceAll("-", "")}`;
  const url = await createTestDatabase(name);
  database = connectDatabase(url.href);
  await bootstrapAdmin(database.pool, admin);
  clock.set(new Date("2030-01-01T00:00:00.000Z"));
  mailer.sent.length = 0;
  app = buildApp({ checkDatabase: database.ping, database, mailer, clock, authTokenSecret: secret });
  const { rows: [actor] } = await database.pool.query<{ id: string }>("SELECT id FROM accounts WHERE email = $1", [admin.email]);
  const { rows: [card] } = await database.pool.query<{ version: string }>(
    "INSERT INTO rate_card_versions (actor_id, scope_type, reason, published_at) VALUES ($1, 'global', 'test', $2) RETURNING version",
    [actor?.id, clock.now()],
  );
  rateCard = String(card?.version);
});

afterEach(async () => {
  await app.close();
  await database.close();
  const root = new pg.Client({ connectionString: rootUrl });
  try {
    await root.connect();
    await root.query(`DROP DATABASE ${name} WITH (FORCE)`);
  } finally {
    await root.end();
  }
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

const manager = async (email: string, managerName = "Ravi Patil") => {
  const id = await account(email, managerName);
  await database.pool.query("INSERT INTO area_manager_memberships (account_id) VALUES ($1)", [id]);
  return id;
};

const shop = async (shopName: string, areaManagerId: string | null) =>
  String((await database.pool.query<{ id: string }>(
    "INSERT INTO shops (shop_name, created_at, area_manager_id) VALUES ($1, $2, $3) RETURNING id",
    [shopName, clock.now(), areaManagerId],
  )).rows[0]?.id);

type OrderSeed = {
  shopId: string;
  shopName: string;
  customerId: string;
  placedAt?: string;
  total?: string;
};

async function createOrder({ shopId, shopName, customerId, placedAt = "2030-01-01T00:00:00.000Z", total = "150.00" }: OrderSeed) {
  const { rows: [row] } = await database.pool.query<{ id: string; number: number }>(
    `INSERT INTO orders (account_id, shop_id, status, placed_at, status_changed_at, shop_name, shop_address, shop_pincode,
        address_label, address_flat, address_pincode, address_point, product_value, delivery_fee, total, rate_card_version, quote)
     VALUES ($1, $2, 'accepted', $3, $3, $4, '12 Lane', '411038', 'home', 'Flat 1', '411038',
        ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography, 130, 20, $5, $6, '{}'::jsonb)
     RETURNING id, number`,
    [customerId, shopId, placedAt, shopName, total, rateCard],
  );
  return { id: String(row?.id), number: row?.number as number };
}

type RevisionSeed = {
  orderId: string;
  actorId: string;
  revision?: number;
  status?: "proposed" | "confirmed" | "declined" | "expired" | "cancelled_negative_contribution";
  belowFloorException?: boolean;
  shortfall?: string | null;
  total?: string;
  platformContribution?: string;
  createdAt?: string;
  confirmedAt?: string | null;
};

async function createRevision({
  orderId,
  actorId,
  revision = 1,
  status = "confirmed",
  belowFloorException = true,
  shortfall = "10.00",
  total = "100.00",
  platformContribution = "15.00",
  createdAt = "2030-01-01T00:05:00.000Z",
  confirmedAt: seedConfirmedAt,
}: RevisionSeed) {
  const confirmByAt = new Date(new Date(createdAt).getTime() + 5 * 60 * 1000).toISOString();
  const confirmedAt = status === "confirmed"
    ? (seedConfirmedAt ?? new Date(new Date(createdAt).getTime() + 60 * 1000).toISOString())
    : null;
  const { rows: [row] } = await database.pool.query<{ id: string }>(
    `INSERT INTO order_revisions (
       order_id, revision, actor_id, actor_role, status, source_status, product_value, delivery_fee, total,
       commission, platform_contribution, quote, below_floor_exception, below_floor_shortfall,
       confirm_by_at, created_at, confirmed_at
     ) VALUES (
       $1, $2, $3, 'owner', $4, 'accepted', 80, 20, $5,
       10, $6, '{}'::jsonb, $7, $8,
       $9, $10, $11
     ) RETURNING id`,
    [orderId, revision, actorId, status, total, platformContribution, belowFloorException, shortfall, confirmByAt, createdAt, confirmedAt],
  );
  return String(row?.id);
}

const list = (headers: Record<string, string>, query = "") =>
  app.inject({ method: "GET", url: `/v1/admin/orders/below-floor-exceptions${query}`, headers });

const review = (headers: Record<string, string>, revisionId: string) =>
  app.inject({ method: "POST", url: `/v1/admin/orders/below-floor-exceptions/${revisionId}/review`, headers });

describe("A30 Below contribution floor exceptions queue (MNY-4, ADM-7, #529)", () => {
  it("only includes confirmed revisions with below_floor_exception = true (excludes proposed, declined, expired, negative contribution)", async () => {
    const customerId = await account("cust1@example.com");
    const ownerId = await account("owner1@example.com");
    const shopId = await shop("Sai Mart", null);
    const ord = await createOrder({ shopId, shopName: "Sai Mart", customerId });

    // 1. Proposed below-floor revision -> excluded
    await createRevision({ orderId: ord.id, actorId: ownerId, revision: 1, status: "proposed", belowFloorException: true, shortfall: "8.00" });

    // 2. Declined below-floor revision -> excluded
    await createRevision({ orderId: ord.id, actorId: ownerId, revision: 2, status: "declined", belowFloorException: true, shortfall: "8.00" });

    // 3. Expired below-floor revision -> excluded
    await createRevision({ orderId: ord.id, actorId: ownerId, revision: 3, status: "expired", belowFloorException: true, shortfall: "8.00" });

    // 4. Cancelled negative contribution revision -> excluded (not below-floor anyway)
    await createRevision({ orderId: ord.id, actorId: ownerId, revision: 4, status: "cancelled_negative_contribution", belowFloorException: false, shortfall: null });

    // 5. Confirmed without below-floor exception -> excluded
    await createRevision({ orderId: ord.id, actorId: ownerId, revision: 5, status: "confirmed", belowFloorException: false, shortfall: null });

    // 6. Confirmed with below-floor exception -> INCLUDED
    const revConfirmed = await createRevision({ orderId: ord.id, actorId: ownerId, revision: 6, status: "confirmed", belowFloorException: true, shortfall: "8.00" });

    const headers = await signIn(admin.email);
    const res = await list(headers);
    expect(res.statusCode).toBe(200);
    const body = res.json() as BelowFloorExceptionsResponse;

    expect(body.exceptions).toHaveLength(1);
    expect(body.exceptions[0]?.revisionId).toBe(revConfirmed);
    expect(body.exceptions[0]?.shortfall).toBe("8.00");
    expect(body.exceptions[0]?.reviewed).toBeNull();
    expect(body.counts.total).toBe(1);
    expect(body.counts.open).toBe(1);
  });

  it("admin sees all shops; area manager sees and reviews only shops assigned to them", async () => {
    const customerId = await account("cust2@example.com");
    const ownerId = await account("owner2@example.com");
    const amA = await manager("am_a@example.com", "Manager A");
    const amB = await manager("am_b@example.com", "Manager B");

    const shopA = await shop("Shop A", amA);
    const shopB = await shop("Shop B", amB);
    const shopUnassigned = await shop("Shop Unassigned", null);

    const ordA = await createOrder({ shopId: shopA, shopName: "Shop A", customerId });
    const ordB = await createOrder({ shopId: shopB, shopName: "Shop B", customerId });
    const ordU = await createOrder({ shopId: shopUnassigned, shopName: "Shop Unassigned", customerId });

    const revA = await createRevision({ orderId: ordA.id, actorId: ownerId, revision: 1 });
    const revB = await createRevision({ orderId: ordB.id, actorId: ownerId, revision: 1 });
    const revU = await createRevision({ orderId: ordU.id, actorId: ownerId, revision: 1 });

    const adminHeaders = await signIn(admin.email);
    const amAHeaders = await signIn("am_a@example.com");
    const amBHeaders = await signIn("am_b@example.com");

    // Admin sees all 3 shops
    const adminRes = await list(adminHeaders);
    expect(adminRes.statusCode).toBe(200);
    const adminBody = adminRes.json() as BelowFloorExceptionsResponse;
    expect(adminBody.exceptions.map((e) => e.revisionId).sort()).toEqual([revA, revB, revU].sort());
    expect(adminBody.counts.total).toBe(3);
    expect(adminBody.counts.open).toBe(3);

    // Admin can filter by areaManagerId
    const adminFilteredAM = await list(adminHeaders, `?areaManagerId=${amA}`);
    expect(adminFilteredAM.statusCode).toBe(200);
    const adminFilteredBody = adminFilteredAM.json() as BelowFloorExceptionsResponse;
    expect(adminFilteredBody.exceptions.map((e) => e.revisionId)).toEqual([revA]);

    // Admin can filter by shopId
    const adminFilteredShop = await list(adminHeaders, `?shopId=${shopB}`);
    expect(adminFilteredShop.statusCode).toBe(200);
    expect((adminFilteredShop.json() as BelowFloorExceptionsResponse).exceptions.map((e) => e.revisionId)).toEqual([revB]);

    // Area Manager A sees only Shop A
    const amARes = await list(amAHeaders);
    expect(amARes.statusCode).toBe(200);
    const amABody = amARes.json() as BelowFloorExceptionsResponse;
    expect(amABody.exceptions.map((e) => e.revisionId)).toEqual([revA]);
    expect(amABody.counts.total).toBe(1);
    expect(amABody.counts.open).toBe(1);

    // Area Manager B sees only Shop B
    const amBRes = await list(amBHeaders);
    expect(amBRes.statusCode).toBe(200);
    expect((amBRes.json() as BelowFloorExceptionsResponse).exceptions.map((e) => e.revisionId)).toEqual([revB]);

    // Area Manager A cannot widen scope by providing another areaManagerId
    const amAWiden = await list(amAHeaders, `?areaManagerId=${amB}`);
    expect(amAWiden.statusCode).toBe(200);
    expect((amAWiden.json() as BelowFloorExceptionsResponse).exceptions.map((e) => e.revisionId)).toEqual([revA]);

    // Area Manager A cannot review Shop B's revision -> 404
    const amAReviewB = await review(amAHeaders, revB);
    expect(amAReviewB.statusCode).toBe(404);

    // Area Manager A can review Shop A's revision -> 200
    const amAReviewA = await review(amAHeaders, revA);
    expect(amAReviewA.statusCode).toBe(200);
    const reviewedA = amAReviewA.json() as BelowFloorException;
    expect(reviewedA.reviewed?.by).toBe("Manager A");
    expect(reviewedA.reviewed?.at).toBeTruthy();
  });

  it("review is idempotent: second mark retains original reviewer and timestamp", async () => {
    const customerId = await account("cust3@example.com");
    const ownerId = await account("owner3@example.com");
    const shopId = await shop("Idempotent Shop", null);
    const ord = await createOrder({ shopId, shopName: "Idempotent Shop", customerId });
    const revId = await createRevision({ orderId: ord.id, actorId: ownerId });

    clock.set(new Date("2030-01-01T12:00:00.000Z"));
    const adminHeaders = await signIn(admin.email);

    // First review
    const res1 = await review(adminHeaders, revId);
    expect(res1.statusCode).toBe(200);
    const body1 = res1.json() as BelowFloorException;
    expect(body1.reviewed).toEqual({
      at: "2030-01-01T12:00:00.000Z",
      by: admin.name,
    });

    // Advance clock by 1 minute (within token lifetime) and sign in as another manager
    clock.advance(60_000);
    const managerId = await manager("second_mgr@example.com", "Second Manager");
    await database.pool.query("UPDATE shops SET area_manager_id = $1 WHERE id = $2", [managerId, shopId]);
    const mgrHeaders = await signIn("second_mgr@example.com");

    // Second review
    const res2 = await review(mgrHeaders, revId);
    expect(res2.statusCode).toBe(200);
    const body2 = res2.json() as BelowFloorException;
    // Original reviewer and time remain intact!
    expect(body2.reviewed).toEqual({
      at: "2030-01-01T12:00:00.000Z",
      by: admin.name,
    });
  });

  it("review returns 404 for non-existent, non-confirmed, or non-below-floor revisions", async () => {
    const customerId = await account("cust4@example.com");
    const ownerId = await account("owner4@example.com");
    const shopId = await shop("Test 404 Shop", null);
    const ord = await createOrder({ shopId, shopName: "Test 404 Shop", customerId });

    // Proposed revision
    const revProposed = await createRevision({ orderId: ord.id, actorId: ownerId, revision: 1, status: "proposed", belowFloorException: true, shortfall: "5.00" });

    // Not below floor
    const revNormal = await createRevision({ orderId: ord.id, actorId: ownerId, revision: 2, status: "confirmed", belowFloorException: false, shortfall: null });

    const adminHeaders = await signIn(admin.email);

    // Non-existent revision
    expect((await review(adminHeaders, randomUUID())).statusCode).toBe(404);

    // Proposed revision cannot be reviewed
    expect((await review(adminHeaders, revProposed)).statusCode).toBe(404);

    // Normal revision cannot be reviewed
    expect((await review(adminHeaders, revNormal)).statusCode).toBe(404);
  });

  it("paginates with stable cursor ordering and no duplicates across pages", async () => {
    const customerId = await account("cust5@example.com");
    const ownerId = await account("owner5@example.com");
    const shopId = await shop("Paging Shop", null);
    const ord = await createOrder({ shopId, shopName: "Paging Shop", customerId });

    // Create 3 revisions
    const rev1 = await createRevision({ orderId: ord.id, actorId: ownerId, revision: 1, createdAt: "2030-01-01T10:00:00.000000Z" });
    const rev2 = await createRevision({ orderId: ord.id, actorId: ownerId, revision: 2, createdAt: "2030-01-01T11:00:00.000000Z" });
    const rev3 = await createRevision({ orderId: ord.id, actorId: ownerId, revision: 3, createdAt: "2030-01-01T12:00:00.000000Z" });

    const adminHeaders = await signIn(admin.email);

    // Page 1 with limit 2 (newest first: rev3, rev2)
    const page1 = await list(adminHeaders, "?limit=2");
    expect(page1.statusCode).toBe(200);
    const body1 = page1.json() as BelowFloorExceptionsResponse;
    expect(body1.exceptions.map((e) => e.revisionId)).toEqual([rev3, rev2]);
    expect(body1.nextCursor).toBeTruthy();

    // Page 2 with cursor (rev1)
    const page2 = await list(adminHeaders, `?limit=2&cursor=${encodeURIComponent(body1.nextCursor as string)}`);
    expect(page2.statusCode).toBe(200);
    const body2 = page2.json() as BelowFloorExceptionsResponse;
    expect(body2.exceptions.map((e) => e.revisionId)).toEqual([rev1]);
    expect(body2.nextCursor).toBeNull();
  });

  it("counts are independent of cursor and filters (reflect caller's full scope)", async () => {
    const customerId = await account("cust6@example.com");
    const ownerId = await account("owner6@example.com");
    const shop1 = await shop("Shop 1", null);
    const shop2 = await shop("Shop 2", null);

    const ord1 = await createOrder({ shopId: shop1, shopName: "Shop 1", customerId });
    const ord2 = await createOrder({ shopId: shop2, shopName: "Shop 2", customerId });

    const rev1 = await createRevision({ orderId: ord1.id, actorId: ownerId, revision: 1, createdAt: "2030-01-01T10:00:00.000Z" });
    await createRevision({ orderId: ord2.id, actorId: ownerId, revision: 1, createdAt: "2030-01-01T11:00:00.000Z" });

    const adminHeaders = await signIn(admin.email);

    // Mark rev1 reviewed
    await review(adminHeaders, rev1);

    // 1. Filtered by status=reviewed
    const reviewedQuery = await list(adminHeaders, "?status=reviewed");
    expect(reviewedQuery.statusCode).toBe(200);
    const rBody = reviewedQuery.json() as BelowFloorExceptionsResponse;
    expect(rBody.exceptions).toHaveLength(1);
    // Counts still reflect all 2 (1 open, 2 total)
    expect(rBody.counts.total).toBe(2);
    expect(rBody.counts.open).toBe(1);

    // 2. Filtered by shopId=shop1
    const shopQuery = await list(adminHeaders, `?shopId=${shop1}`);
    expect(shopQuery.statusCode).toBe(200);
    const sBody = shopQuery.json() as BelowFloorExceptionsResponse;
    // Counts still reflect full scope (2 total, 1 open)
    expect(sBody.counts.total).toBe(2);
    expect(sBody.counts.open).toBe(1);
  });

  it("order with two below-floor revisions shows as two rows with separate review state", async () => {
    const customerId = await account("cust7@example.com");
    const ownerId = await account("owner7@example.com");
    const shopId = await shop("Multi Revision Shop", null);
    const ord = await createOrder({ shopId, shopName: "Multi Revision Shop", customerId, total: "200.00" });

    // First partial accept: reduced to ₹150, shortfall ₹8.00
    const rev1 = await createRevision({
      orderId: ord.id,
      actorId: ownerId,
      revision: 1,
      total: "150.00",
      shortfall: "8.00",
      createdAt: "2030-01-01T10:00:00.000Z",
    });

    // Second partial accept: reduced to ₹100, shortfall ₹14.00
    const rev2 = await createRevision({
      orderId: ord.id,
      actorId: ownerId,
      revision: 2,
      total: "100.00",
      shortfall: "14.00",
      createdAt: "2030-01-01T12:00:00.000Z",
    });

    const adminHeaders = await signIn(admin.email);

    // Review only revision 1
    const rev1Res = await review(adminHeaders, rev1);
    expect(rev1Res.statusCode).toBe(200);

    // Query open exceptions: revision 2 is open, revision 1 is not
    const openRes = await list(adminHeaders, "?status=open");
    const openBody = openRes.json() as BelowFloorExceptionsResponse;
    expect(openBody.exceptions).toHaveLength(1);
    expect(openBody.exceptions[0]?.revisionId).toBe(rev2);
    expect(openBody.exceptions[0]?.originalTotal).toBe("150.00"); // prior revision total
    expect(openBody.exceptions[0]?.revisedTotal).toBe("100.00");
    expect(openBody.exceptions[0]?.shortfall).toBe("14.00");
    expect(openBody.exceptions[0]?.reviewed).toBeNull();

    // Query reviewed exceptions: revision 1 is reviewed
    const reviewedRes = await list(adminHeaders, "?status=reviewed");
    const reviewedBody = reviewedRes.json() as BelowFloorExceptionsResponse;
    expect(reviewedBody.exceptions).toHaveLength(1);
    expect(reviewedBody.exceptions[0]?.revisionId).toBe(rev1);
    expect(reviewedBody.exceptions[0]?.originalTotal).toBe("200.00"); // order total
    expect(reviewedBody.exceptions[0]?.revisedTotal).toBe("150.00");
    expect(reviewedBody.exceptions[0]?.shortfall).toBe("8.00");
    expect(reviewedBody.exceptions[0]?.reviewed?.by).toBe(admin.name);
  });
});
