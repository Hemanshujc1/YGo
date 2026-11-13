import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import {
  AssignDelivererBody, type ShopDiscountOffer, CancelOrderBody, CompleteDeliveryBody, CompletePickupBody, DeliveryPhotoUpload, DeliveryPhotoUploadBody, ErrorEnvelope, FailDeliveryBody, OrderParams, type OrderStatus, PartialAcceptOrderBody, PartialAcceptPreviewResponse, ProofExceptionBody, RejectOrderBody, ShopOrderResponse, type ShopOrderSummary, SetStaffCanDeliverBody, SetStaffCanDeliverResponse,
  ShopDeliverersResponse, ShopOrdersResponse, ShopStaffResponse, type ShortLine, STOCK_HOLDING_ORDER_STATUSES, TERMINAL_ORDER_STATUSES,
} from "@ygo/contracts";
import { fromPaise, toPaise } from "@ygo/pricing";
import type { Clock } from "../adapters/clock";
import type { DeliveryPhotoStorage } from "../adapters/delivery-photos";
import { withTransaction } from "../db";
import { checkHandoverCode, createHandoverCode, type HandoverCodeState, recordDeliverySale } from "../delivery";
import { couponCategoryEligibility } from "../coupons";
import { deliveryActions } from "../delivery-actions";
import { stockOf } from "../listings";
import { cancelRules, queueNotification } from "../notifications";
import { moveOrder } from "../orders";
import { orderTiming } from "../order-timing";
import { deriveKeys, mobileSignedIn } from "../tokens";
import { offerSql } from "./cart";
import { answerExpired, frozenOrder } from "./orders";
import { resolveRateCard } from "./rate-cards";

/** Until when the shop can answer, while the order still waits for it. The window runs from when the order last became `placed` (placed_at is frozen, so a confirmed changed total restarts it through status_changed_at, #581). */
const expiresAt = (status: OrderStatus, enteredAt: Date) => status === "placed" ? new Date(enteredAt.getTime() + orderTiming.expireSeconds * 1000).toISOString() : null;

/** Unexpired photo uploads one order may hold at once; retakes after a failed try fit, a flood does not. */
const DELIVERY_PHOTO_OPEN_UPLOADS_MAX = 5;

/** S05: one order of the shop the account is Owner or Staff of, whether or not the shop is Live now (owner's answer 13 on #425). */
async function shopOrderView(client: Pool | PoolClient, orderId: string, accountId: string, now: Date, failureWaitSeconds: number): Promise<ShopOrderResponse | undefined> {
  const { rows: [row] } = await client.query<Omit<ShopOrderResponse, "placedAt" | "expiresAt" | "now" | "deliveryFailureReadyAt"> & { placedAt: Date; statusChangedAt: Date; deliveryFailureReadyAt: Date | null }>(
    `SELECT o.id, o.number, o.status, o.placed_at AS "placedAt", o.status_changed_at AS "statusChangedAt", ${frozenOrder("o", true)}, o.deliverer_id AS "delivererId",
        json_build_object('name', a.name, 'phone', CASE WHEN o.deliverer_id = $2 THEN a.phone END) AS customer,
        CASE WHEN o.deliverer_id = $2 THEN s.upi_id END AS "shopUpiId", (o.delivery_photo_key IS NOT NULL) AS "deliveryPhotoAvailable",
        CASE WHEN o.deliverer_id = $2 AND o.delivery_call_attempt_at IS NOT NULL THEN o.delivery_call_attempt_at + make_interval(secs => $3) END AS "deliveryFailureReadyAt"
      FROM orders o JOIN shops s ON s.id = o.shop_id JOIN shop_members m ON m.shop_id = o.shop_id
      JOIN accounts a ON a.id = o.account_id
      WHERE o.id = $1 AND m.account_id = $2`, [orderId, accountId, failureWaitSeconds]);
  if (!row) return row;
  // The latest offline delivery the server did not accept stays on the order while it is still Arrived (#616).
  const { rows: [issue] } = row.status === "arrived" ? await client.query<{ action: string; code: string; at: Date; clockSuspect: boolean }>(
    'SELECT action, code, created_at AS at, clock_suspect AS "clockSuspect" FROM offline_delivery_issues WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1', [orderId]) : { rows: [] };
  const { statusChangedAt, ...shown } = row;
  return { ...shown, offlineDeliveryIssue: issue ? { ...issue, at: issue.at.toISOString() } : null, placedAt: row.placedAt.toISOString(), expiresAt: expiresAt(row.status, statusChangedAt), now: now.toISOString(), deliveryFailureReadyAt: row.deliveryFailureReadyAt?.toISOString() ?? null };
}

export function registerShopOrderRoutes(app: FastifyInstance, { pool, clock, secret, photos, failureWaitSeconds, photoSaveTimeoutMs = 60_000 }: { pool: Pool; clock: Clock; secret: string; photos?: DeliveryPhotoStorage; failureWaitSeconds: number; photoSaveTimeoutMs?: number }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const errors = { 400: ErrorEnvelope, 401: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope, 429: ErrorEnvelope, 503: ErrorEnvelope };
  const refusalStatus = { NOT_FOUND: 404, UNAVAILABLE: 503, DELIVERY_PHOTO_INVALID: 400, HANDOVER_CODE_WRONG: 400, HANDOVER_CODE_LOCKED: 429 } as const;
  const sendRefusal = (reply: FastifyReply, code: string) =>
    reply.code(refusalStatus[code as keyof typeof refusalStatus] ?? 409).send({ error: { code } });
  const actions = deliveryActions({ secret, photos, failureWaitSeconds, photoSaveTimeoutMs });

  // S04: the shop's orders in three groups (owner's answers 5 and 8 on #425).
  app.get("/v1/me/shop-orders", { schema: { response: { 200: ShopOrdersResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { rows: [member] } = await pool.query<{ shopId: string; canDeliver: boolean }>('SELECT shop_id AS "shopId", (role = \'owner\' OR can_deliver) AS "canDeliver" FROM shop_members WHERE account_id = $1', [who.accountId]);
    if (!member) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    const now = clock.now();
    type Row = Omit<ShopOrderSummary, "placedAt" | "expiresAt"> & { placedAt: Date; statusChangedAt: Date };
    // A placed order past its time is in no group until #57 moves it to Expired, so no Accept shows that can't work.
    const { rows } = await pool.query<Row>(
        `SELECT o.id, o.number, o.status, o.deliverer_id AS "delivererId", o.placed_at AS "placedAt", o.status_changed_at AS "statusChangedAt",
            COALESCE(
              (SELECT r.total::text FROM order_revisions r WHERE r.order_id = o.id AND r.status = 'confirmed' ORDER BY r.revision DESC LIMIT 1),
              o.total::text
            ) AS total,
            CASE WHEN EXISTS (SELECT 1 FROM order_revisions r WHERE r.order_id = o.id AND r.status = 'confirmed') THEN
              (SELECT count(*)::int FROM order_revision_lines rl
               WHERE rl.revision_id = (SELECT r.id FROM order_revisions r WHERE r.order_id = o.id AND r.status = 'confirmed' ORDER BY r.revision DESC LIMIT 1)
                 AND rl.count > 0)
            ELSE
              (SELECT count(*)::int FROM order_lines l WHERE l.order_id = o.id)
            END AS "itemCount",
            o.fulfilment,
            CASE WHEN o.fulfilment = 'delivery' THEN json_build_object('flat', o.address_flat, 'areaLine', o.address_area_line) END AS address,
            CASE WHEN o.status = 'awaiting_customer_confirm' THEN (
              SELECT to_char(p.confirm_by_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              FROM order_revisions p WHERE p.order_id = o.id AND p.status = 'proposed' ORDER BY p.revision DESC LIMIT 1
            ) END AS "confirmByAt",
            EXISTS (SELECT 1 FROM order_cancel_requests c WHERE c.order_id = o.id AND c.status = 'asked') AS "cancelAsked",
            (o.status = 'arrived' AND EXISTS (SELECT 1 FROM offline_delivery_issues i WHERE i.order_id = o.id)) AS "offlineDeliveryIssue"
          FROM orders o
          WHERE o.shop_id = $1 AND (
            (o.status = 'placed' AND NOT ${answerExpired("o", "$2")})
            OR o.status = ANY($3::text[])
            OR (o.status = ANY($4::text[]) AND (o.status_changed_at AT TIME ZONE 'Asia/Kolkata')::date = ($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::date))
          ORDER BY CASE WHEN o.status = ANY($4::text[]) THEN -extract(epoch FROM o.status_changed_at) ELSE extract(epoch FROM o.placed_at) END`,
        [member.shopId, now, STOCK_HOLDING_ORDER_STATUSES, TERMINAL_ORDER_STATUSES]);
    const summary = ({ statusChangedAt, ...row }: Row): ShopOrderSummary => ({
      ...row,
      placedAt: row.placedAt.toISOString(),
      expiresAt: expiresAt(row.status, statusChangedAt),
      confirmByAt: row.confirmByAt ?? null,
    });
    return {
      now: now.toISOString(),
      canDeliver: member.canDeliver,
      offlineDeliveryIssueCount: rows.filter((row) => row.offlineDeliveryIssue).length,
      new: rows.filter((row) => row.status === "placed").map(summary),
      accepted: rows.filter((row) => STOCK_HOLDING_ORDER_STATUSES.includes(row.status)).map(summary),
      doneToday: rows.filter((row) => TERMINAL_ORDER_STATUSES.includes(row.status)).map(summary),
      myDeliveries: rows.filter((row) => row.delivererId === who.accountId && ["ready", "out_for_delivery", "arrived"].includes(row.status)).map(summary),
    };
  });

  app.get("/v1/me/shop-deliverers", { schema: { response: { 200: ShopDeliverersResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { rows: [member] } = await pool.query<{ shopId: string }>("SELECT shop_id AS \"shopId\" FROM shop_members WHERE account_id = $1", [who.accountId]);
    if (!member) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    const { rows } = await pool.query<ShopDeliverersResponse["deliverers"][number]>(
      `SELECT m.account_id AS "accountId", a.name, m.role, (m.role = 'owner' OR m.can_deliver) AS "canDeliver"
       FROM shop_members m JOIN accounts a ON a.id = m.account_id
       WHERE m.shop_id = $1 AND (m.role = 'owner' OR m.can_deliver) ORDER BY m.role DESC, lower(a.name)`, [member.shopId]);
    return { deliverers: rows };
  });

  app.get("/v1/me/shop-orders/:id", { schema: { params: OrderParams, response: { 200: ShopOrderResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const order = await shopOrderView(pool, (request.params as OrderParams).id, who.accountId, clock.now(), failureWaitSeconds);
    return order ?? reply.code(404).send({ error: { code: "NOT_FOUND" } });
  });

  /**
   * Accept or Reject on S05, in one transaction: the order is locked first, then (for Accept) its listings
   * in id order, so two Accepts for the last stock take turns and the second sees the first's hold.
   */
  const answer = (to: "accepted" | "rejected_by_shop") => async (request: FastifyRequest, reply: FastifyReply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as OrderParams;
    const reason = to === "rejected_by_shop" ? (request.body as RejectOrderBody).reason : null;
    type Outcome = { code: "NOT_FOUND" | "ORDER_STATUS_CHANGED" | "ORDER_EXPIRED" } | { code: "NOT_ENOUGH_STOCK"; shortLines: ShortLine[] } | { now: Date };
    const outcome = await withTransaction(pool, async (client): Promise<Outcome> => {
      const { rows: [order] } = await client.query<{ id: string; status: OrderStatus; answerFrom: Date; role: "owner" | "staff" }>(
        `SELECT o.id, o.status, o.status_changed_at AS "answerFrom", m.role FROM orders o JOIN shop_members m ON m.shop_id = o.shop_id
         WHERE o.id = $1 AND m.account_id = $2 FOR UPDATE OF o`, [id, who.accountId]);
      if (!order) return { code: "NOT_FOUND" };
      if (order.status !== "placed") return { code: "ORDER_STATUS_CHANGED" };
      // Read after the lock, so a wait on it can't stamp an earlier time.
      const now = clock.now();
      if (now.getTime() >= order.answerFrom.getTime() + orderTiming.expireSeconds * 1000) return { code: "ORDER_EXPIRED" };
      if (to === "accepted") {
        // A listing switched off or repriced since placement doesn't block Accept: the order keeps its price (answer 14).
        // NO KEY UPDATE queues behind placement's FOR SHARE and other Accepts, but not behind cart saves' key checks.
        await client.query("SELECT 1 FROM shop_listings WHERE id IN (SELECT listing_id FROM order_lines WHERE order_id = $1) ORDER BY id FOR NO KEY UPDATE", [id]);
        const { rows: shortLines } = await client.query<ShortLine>(
          `SELECT l.name, l.brand, l.base_unit AS "baseUnit", trim_scale(l.pack_quantity)::text AS quantity, l.count,
              trim_scale(l.part_quantity)::text AS part, trim_scale(GREATEST(stock.left, 0))::text AS available
            FROM order_lines l JOIN shop_listings listing ON listing.id = l.listing_id
            CROSS JOIN LATERAL (SELECT ${stockOf("listing")} AS left) stock
            WHERE l.order_id = $1 AND stock.left < l.stock_quantity
            ORDER BY l.position`, [id]);
        // A cart holds one line per listing, so each line is checked against its listing's stock alone.
        if (shortLines.length > 0) return { code: "NOT_ENOUGH_STOCK", shortLines };
      }
      if (!await moveOrder(client, order, to, { id: who.accountId, role: order.role }, now, reason)) return { code: "ORDER_STATUS_CHANGED" };
      if (to === "accepted") {
        const code = createHandoverCode(secret);
        await client.query(`UPDATE orders SET handover_code_hash = $2, handover_code_salt = $3, handover_code_ciphertext = $4
          WHERE id = $1`, [id, code.hash, code.salt, code.ciphertext]);
      }
      await client.query("COMMIT");
      return { now };
    });
    if (!("now" in outcome)) return reply.code(outcome.code === "NOT_FOUND" ? 404 : 409).send({ error: outcome });
    return shopOrderView(pool, id, who.accountId, outcome.now, failureWaitSeconds);
  };

  app.post("/v1/me/shop-orders/:id/accept", { schema: { params: OrderParams, response: { 200: ShopOrderResponse, ...errors } } }, answer("accepted"));
  app.post("/v1/me/shop-orders/:id/reject", { schema: { params: OrderParams, body: RejectOrderBody, response: { 200: ShopOrderResponse, ...errors } } },
    answer("rejected_by_shop"));

  /**
   * Cancelling after acceptance (ORD-5, #59), each in one transaction on the locked order. Agree and Keep answer the Customer's
   * ask; Cancel is the shop's own, with a reason, from accepted, preparing or ready. Reject stays for orders still placed.
   */
  const cancelling = (action: "agree" | "keep" | "cancel") => async (request: FastifyRequest, reply: FastifyReply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as OrderParams;
    const outcome = await withTransaction(pool, async (client): Promise<{ code: string } | { now: Date }> => {
      const { rows: [order] } = await client.query<{ id: string; status: OrderStatus; role: "owner" | "staff" }>(
        `SELECT o.id, o.status, m.role FROM orders o JOIN shop_members m ON m.shop_id = o.shop_id
         WHERE o.id = $1 AND m.account_id = $2 FOR UPDATE OF o`, [id, who.accountId]);
      if (!order) return { code: "NOT_FOUND" };
      const now = clock.now();
      const actor = { id: who.accountId, role: order.role };
      if (action === "cancel") {
        if (!await moveOrder(client, order, "cancelled_by_shop", actor, now, (request.body as CancelOrderBody).reason)) return { code: "ORDER_STATUS_CHANGED" };
      } else {
        const { rows: [asked] } = await client.query<{ status: string }>("SELECT status FROM order_cancel_requests WHERE order_id = $1", [id]);
        if (!asked) return { code: "ORDER_STATUS_CHANGED" };
        const settled = action === "agree" ? "agreed" : "kept";
        // The same answer again is a retry: it answers as before and notifies no one twice.
        if (asked.status === settled) return { now };
        if (asked.status !== "asked") return { code: "CANCEL_REQUEST_CLOSED" };
        await client.query("UPDATE order_cancel_requests SET status = $2, settled_at = $3, settled_by = $4 WHERE order_id = $1", [id, settled, now, who.accountId]);
        if (action === "keep") await queueNotification(client, id, cancelRules.kept, now);
        else if (!await moveOrder(client, order, "cancelled_by_customer", actor, now, "agreed_cancel")) return { code: "ORDER_STATUS_CHANGED" };
      }
      await client.query("COMMIT");
      return { now };
    });
    if (!("now" in outcome)) return reply.code(outcome.code === "NOT_FOUND" ? 404 : 409).send({ error: outcome });
    return shopOrderView(pool, id, who.accountId, outcome.now, failureWaitSeconds);
  };
  app.post("/v1/me/shop-orders/:id/cancel-request/agree", { schema: { params: OrderParams, response: { 200: ShopOrderResponse, ...errors } } }, cancelling("agree"));
  app.post("/v1/me/shop-orders/:id/cancel-request/keep", { schema: { params: OrderParams, response: { 200: ShopOrderResponse, ...errors } } }, cancelling("keep"));
  app.post("/v1/me/shop-orders/:id/cancel", { schema: { params: OrderParams, body: CancelOrderBody, response: { 200: ShopOrderResponse, ...errors } } }, cancelling("cancel"));

  /** What `pricing_revision_quote` returns: the revision's money, every amount as the engine wrote it (MNY-15). */
  type RevisionMoney = {
    lines: Array<{ shopDiscount: string; commission: string }>;
    productValue: string;
    shopDiscount: string;
    shopCoupon: string;
    platformCoupon: string;
    commission: string;
    customerTotal: string;
    platformContribution: string;
    couponReason: "BELOW_MINIMUM" | "NOTHING_ELIGIBLE" | "NO_ROOM" | null;
    /** A platform-funded coupon cut back to what the platform earns on the order (D-5, #530); null when it was not. */
    couponCutback: { reason: "REDUCED" | "REMOVED"; from: string; to: string } | null;
  };

  type PreparedRevisionLine = {
    position: number;
    listingId: string;
    name: string;
    brand: string | null;
    baseUnit: string;
    packQuantity: string;
    originalCount: number;
    count: number;
    originalPartQuantity: string | null;
    partQuantity: string | null;
    unitPrice: string;
    lineTotal: string;
    commission: string;
    shopDiscount: string;
    stockQuantity: string;
    changeReason: string | null;
  };

  /** The rule version the order was priced on, as the pricing function reads it, and its offer (#572). */
  type FrozenDiscountRule = { ruleId: string; version: number; rule: Record<string, string | null>; offer: ShopDiscountOffer } | null;
  /** The coupon version the order was priced on: its terms as the pricing function reads them, who pays, and its categories (#70). */
  type FrozenCoupon = { couponId: string; version: number; funding: "platform" | "shop"; rule: Record<string, string | null>; categoryIds: string[] } | null;

  type PartialAcceptEvaluation =
    | { ok: false; code: string; status?: number; shortLines?: ShortLine[] }
    | {
        ok: true;
        order: {
          id: string;
          shopId: string;
          status: OrderStatus;
          answerFrom: Date;
          role: "owner" | "staff";
          rateCardVersion: string;
          quote: {
            deliveryFee: { amount: string; platformShare: string; shopShare: string };
            smallCartFee: { amount: string; platformShare: string; shopShare: string } | null;
            pickup?: { customerFee: string; shopFee: string; contributionFloor: string };
            coupon?: Record<string, unknown> | null;
          };
          pickupFee: string | null;
          originalTotal: string;
          discountRule: FrozenDiscountRule;
          coupon: FrozenCoupon;
        };
        activeLines: Array<{
          position: number;
          listingId: string;
          name: string;
          brand: string | null;
          baseUnit: string;
          packQuantity: string;
          count: number;
          partQuantity: string | null;
          unitPrice: string;
          lineTotal: string;
          stockQuantity: string;
          categoryId: string;
        }>;
        preparedLines: PreparedRevisionLine[];
        subtotalStr: string;
        shopDiscountStr: string;
        /** The order's coupon re-applied to these lines, the two funding amounts apart (MNY-6, #70); both 0.00 with none. */
        shopCouponStr: string;
        platformCouponStr: string;
        deliveryFee: { amount: string; platformShare: string; shopShare: string };
        smallCartFee: { amount: string; platformShare: string; shopShare: string } | null;
        /** A pickup's booking fee, which stands as quoted (ORD-4); null on a delivery. */
        pickupFee: string | null;
        /** The pickup floor the order is tested against, in place of the delivered one; null on a delivery. */
        pickupFloor: string | null;
        customerTotalStr: string;
        totalCommissionStr: string;
        platformContributionPaise: bigint;
        platformContributionStr: string;
        orderCard: Awaited<ReturnType<typeof resolveRateCard>>;
        revisionQuote: Record<string, unknown>;
        originalTotal: string;
        confirmByAt: Date;
        revision: number;
      };

  /** The shortfall below the contribution floor in paise, 0 when the order meets it (D-5: a recorded exception, not a cancel). */
  const floorShortfallPaise = (e: { orderCard?: { values: { deliveredContributionFloor?: { value?: unknown } } } | null; pickupFloor: string | null; platformContributionPaise: bigint }): bigint => {
    // A pickup is tested against the pickup floor alone, never the delivered one (MNY-4).
    const floorValue = e.pickupFloor ?? e.orderCard?.values.deliveredContributionFloor?.value;
    const floorPaise = typeof floorValue === "string" ? toPaise(floorValue) : 0n;
    return e.platformContributionPaise < floorPaise ? floorPaise - e.platformContributionPaise : 0n;
  };

  /** Independent reads run together on the pool, but one after another on a transaction's single connection, which cannot take two at once. */
  const readTogether = <T extends readonly unknown[]>(client: Pool | PoolClient, reads: { [K in keyof T]: () => Promise<T[K]> }): Promise<T> =>
    "release" in client
      ? reads.reduce<Promise<unknown[]>>(async (done, read) => [...await done, await read()], Promise.resolve([])) as unknown as Promise<T>
      : Promise.all(reads.map((read) => read())) as unknown as Promise<T>;

  async function evaluatePartialAccept(
    client: Pool | PoolClient,
    orderId: string,
    accountId: string,
    proposedLines: Array<{ listingId: string; count: number; reason?: string }>,
    now: Date,
    orderTimingConfig: { expireSeconds: number; confirmSeconds: number },
    forUpdate = false,
  ): Promise<PartialAcceptEvaluation> {
    const { rows: [order] } = await client.query<{
      id: string;
      shopId: string;
      status: OrderStatus;
      answerFrom: Date;
      role: "owner" | "staff";
      rateCardVersion: string;
      quote: {
        deliveryFee: { amount: string; platformShare: string; shopShare: string };
        smallCartFee: { amount: string; platformShare: string; shopShare: string } | null;
        pickup?: { customerFee: string; shopFee: string; contributionFloor: string };
        coupon?: Record<string, unknown> | null;
      };
      pickupFee: string | null;
      originalTotal: string;
      /** What the platform's coupon took off the total the customer last confirmed, so a requote can tell a cutback from a coupon that merely changed (#530). */
      priorPlatformCoupon: string;
      discountRule: FrozenDiscountRule;
      coupon: FrozenCoupon;
    }>(
      `SELECT o.id, o.shop_id AS "shopId", o.status, o.status_changed_at AS "answerFrom", m.role,
              o.rate_card_version AS "rateCardVersion", o.quote, o.pickup_fee::text AS "pickupFee",
              COALESCE(
                (SELECT r.total::text FROM order_revisions r WHERE r.order_id = o.id AND r.status = 'confirmed' ORDER BY r.revision DESC LIMIT 1),
                o.total::text
              ) AS "originalTotal",
              COALESCE(
                (SELECT r.platform_coupon::text FROM order_revisions r WHERE r.order_id = o.id AND r.status = 'confirmed' ORDER BY r.revision DESC LIMIT 1),
                o.platform_coupon::text
              ) AS "priorPlatformCoupon",
              (SELECT json_build_object('ruleId', v.rule_id, 'version', v.version,
                  'rule', json_build_object('form', v.form, 'percentage', v.percentage::text, 'cap', v.cap::text, 'amount', v.flat_amount::text, 'minimumOrder', v.minimum_order::text),
                  'offer', ${offerSql("v")})
                FROM shop_discount_versions v WHERE v.rule_id = o.shop_discount_rule_id AND v.version = o.shop_discount_rule_version) AS "discountRule",
              (SELECT json_build_object('couponId', v.coupon_id, 'version', v.version, 'funding', v.funding,
                  'rule', json_build_object('form', v.form, 'percentage', v.percentage::text, 'cap', v.cap::text, 'amount', v.flat_amount::text,
                    'minimumOrder', CASE WHEN v.form = 'flat' THEN COALESCE(v.minimum_order, 0)::text ELSE v.minimum_order::text END),
                  'categoryIds', v.category_ids)
                FROM coupon_versions v WHERE v.coupon_id = o.coupon_id AND v.version = o.coupon_version) AS coupon
       FROM orders o JOIN shop_members m ON m.shop_id = o.shop_id
       WHERE o.id = $1 AND m.account_id = $2 ${forUpdate ? "FOR UPDATE OF o" : ""}`, [orderId, accountId]);
    if (!order) return { ok: false, code: "NOT_FOUND", status: 404 };

    if (order.status === "placed" && now.getTime() >= order.answerFrom.getTime() + orderTimingConfig.expireSeconds * 1000) {
      return { ok: false, code: "ORDER_EXPIRED", status: 409 };
    }

    if (order.status === "awaiting_customer_confirm") {
      return { ok: false, code: "PROPOSAL_OPEN", status: 409 };
    }

    if (order.status !== "placed" && order.status !== "accepted" && order.status !== "preparing") {
      return { ok: false, code: "ORDER_STATUS_CHANGED", status: 409 };
    }

    // One read of the order's revisions answers the open-proposal check, the last confirmed revision and the next revision number.
    const { rows: [revisions] } = await client.query<{ proposed: boolean; confirmedId: string | null; nextRev: number }>(
      `SELECT bool_or(status = 'proposed') AS proposed,
              (array_agg(id ORDER BY revision DESC) FILTER (WHERE status = 'confirmed'))[1] AS "confirmedId",
              COALESCE(max(revision), 0) + 1 AS "nextRev"
       FROM order_revisions WHERE order_id = $1`, [orderId]);
    if (revisions?.proposed) return { ok: false, code: "PROPOSAL_OPEN", status: 409 };
    const confirmedRev = revisions?.confirmedId ? { id: revisions.confirmedId } : undefined;

    type ActiveLine = {
      position: number;
      listingId: string;
      name: string;
      brand: string | null;
      baseUnit: string;
      packQuantity: string;
      count: number;
      partQuantity: string | null;
      unitPrice: string;
      lineTotal: string;
      stockQuantity: string;
      categoryId: string;
    };

    // A line an earlier revision removed entirely (count 0) is gone: it cannot be carried forward with an original count of 0 (#579).
    const { rows: activeLines } = confirmedRev
      ? await client.query<ActiveLine>(
          `SELECT rl.position, rl.listing_id AS "listingId", rl.name, rl.brand, rl.base_unit AS "baseUnit",
                  rl.pack_quantity::text AS "packQuantity", rl.count, rl.part_quantity::text AS "partQuantity",
                  rl.unit_price::text AS "unitPrice", rl.line_total::text AS "lineTotal", rl.stock_quantity::text AS "stockQuantity",
                  p.category_id AS "categoryId"
           FROM order_revision_lines rl
           JOIN shop_listings l ON l.id = rl.listing_id
           JOIN packs pk ON pk.id = l.pack_id
           JOIN master_products p ON p.id = pk.product_id
           WHERE rl.revision_id = $1 AND rl.count > 0
           ORDER BY rl.position`, [confirmedRev.id])
      : await client.query<ActiveLine>(
          `SELECT ol.position, ol.listing_id AS "listingId", ol.name, ol.brand, ol.base_unit AS "baseUnit",
                  ol.pack_quantity::text AS "packQuantity", ol.count, ol.part_quantity::text AS "partQuantity",
                  ol.unit_price::text AS "unitPrice", ol.line_total::text AS "lineTotal", ol.stock_quantity::text AS "stockQuantity",
                  p.category_id AS "categoryId"
           FROM order_lines ol
           JOIN shop_listings l ON l.id = ol.listing_id
           JOIN packs pk ON pk.id = l.pack_id
           JOIN master_products p ON p.id = pk.product_id
           WHERE ol.order_id = $1
           ORDER BY ol.position`, [orderId]);

    const proposedListingIds = proposedLines.map((l) => l.listingId);
    if (new Set(proposedListingIds).size !== proposedListingIds.length) {
      return { ok: false, code: "INVALID_PARTIAL_ACCEPT", status: 400 };
    }

    const proposedMap = new Map(proposedLines.map((l) => [l.listingId, l]));

    for (const p of proposedLines) {
      if (!activeLines.some((l) => l.listingId === p.listingId)) {
        return { ok: false, code: "INVALID_PARTIAL_ACCEPT", status: 400 };
      }
    }

    if (forUpdate) {
      const allListingIds = [...new Set(activeLines.map((l) => l.listingId))].sort();
      if (allListingIds.length > 0) {
        await client.query("SELECT 1 FROM shop_listings WHERE id = ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE", [allListingIds]);
      }
    }

    let changedCount = 0;
    let remainingCount = 0;

    for (const line of activeLines) {
      const proposed = proposedMap.get(line.listingId);
      const targetCount = proposed ? proposed.count : line.count;

      if (targetCount > line.count) {
        return { ok: false, code: "INVALID_PARTIAL_ACCEPT", status: 400 };
      }

      if (line.partQuantity !== null && targetCount !== 0 && targetCount !== 1) {
        return { ok: false, code: "INVALID_PARTIAL_ACCEPT", status: 400 };
      }

      if (targetCount < line.count) {
        changedCount += 1;
        if (!proposed?.reason) {
          return { ok: false, code: "INVALID_PARTIAL_ACCEPT", status: 400 };
        }
      }

      if (targetCount > 0) {
        remainingCount += 1;
      }
    }

    if (changedCount === 0) {
      return { ok: false, code: "INVALID_PARTIAL_ACCEPT", status: 400 };
    }

    if (remainingCount === 0) {
      return { ok: false, code: "EMPTY_ORDER", status: 400 };
    }

    const categories = [...new Set(activeLines.map((l) => l.categoryId))];
    const [orderCard, ...categoryCards] = await readTogether(client, [
      () => resolveRateCard(client, order.shopId, undefined, order.rateCardVersion),
      ...categories.map((catId) => () => resolveRateCard(client, order.shopId, catId, order.rateCardVersion)),
    ]);
    const byCategory = new Map(categories.map((catId, index) => [catId, categoryCards[index]] as const));

    const preparedLines: PreparedRevisionLine[] = [];

    for (const line of activeLines) {
      const proposed = proposedMap.get(line.listingId);
      const count = proposed ? proposed.count : line.count;
      const changeReason = count < line.count ? (proposed?.reason ?? null) : null;
      const partQuantity = line.partQuantity !== null && count > 0 ? line.partQuantity : null;

      let lineTotalStr = "0.00";
      let stockQuantityStr = "0.000";

      if (count > 0) {
        const lineTotalPaise = partQuantity !== null
          ? toPaise(line.unitPrice)
          : toPaise(line.unitPrice) * BigInt(count);
        lineTotalStr = fromPaise(lineTotalPaise);
        stockQuantityStr = partQuantity ? partQuantity : (count * Number(line.packQuantity)).toFixed(3);
      }

      preparedLines.push({
        position: line.position,
        listingId: line.listingId,
        name: line.name,
        brand: line.brand,
        baseUnit: line.baseUnit,
        packQuantity: line.packQuantity,
        originalCount: line.count,
        count,
        originalPartQuantity: line.partQuantity,
        partQuantity,
        unitPrice: line.unitPrice,
        lineTotal: lineTotalStr,
        commission: "0.00",
        shopDiscount: "0.00",
        stockQuantity: stockQuantityStr,
        changeReason,
      });
    }

    // The discount is re-applied from the rule version the order was priced on, never the shop's current rule (#572), by the same function placement uses:
    // a percentage on the revised base under its cap, a flat amount only while the revised pre-discount base still meets its minimum order.
    // Every line stays eligible until #78 passes bargained lines as ineligible (BRG-5).
    const holdsNow = STOCK_HOLDING_ORDER_STATUSES.includes(order.status);
    const stockShortfall = () => client.query<ShortLine>(
      `SELECT p.name, p.brand, p.base_unit AS "baseUnit", trim_scale(p.pack_quantity)::text AS quantity, p.count,
          trim_scale(p.part)::text AS part, trim_scale(GREATEST(stock.left + p.own, 0))::text AS available
        FROM jsonb_to_recordset($1::jsonb) AS p(position int, listing_id uuid, name text, brand text, base_unit text,
          pack_quantity numeric, count int, part numeric, wanted numeric, own numeric)
        JOIN shop_listings listing ON listing.id = p.listing_id
        CROSS JOIN LATERAL (SELECT ${stockOf("listing")} AS left) stock
        WHERE p.wanted > p.own AND p.wanted - p.own > stock.left
        ORDER BY p.position`,
      [JSON.stringify(preparedLines.map((pl, index) => ({
        position: pl.position, listing_id: pl.listingId, name: pl.name, brand: pl.brand, base_unit: pl.baseUnit,
        pack_quantity: pl.packQuantity, count: pl.count, part: pl.partQuantity, wanted: pl.stockQuantity,
        own: holdsNow ? activeLines[index]?.stockQuantity : "0",
      })))]);
    const shortLines = (await stockShortfall()).rows;
    if (shortLines.length > 0) return { ok: false, code: "NOT_ENOUGH_STOCK", status: 409, shortLines };

    // The money is the pricing engine's, in one call (MNY-15): the discount or coupon the order was priced with, on the revised lines under its frozen terms
    // (its categories, its minimum order, its shares in whole paise), each line's commission on the order's own rate card, a platform-funded coupon cut back to
    // what the platform earns on the order, not the floor (D-5), and the totals. One promotion at most (D-7): the shop-wide discount, or the coupon. The fees stand as quoted on a requote (ORD-4).
    const coupon = order.coupon;
    const couponLines = coupon ? await couponCategoryEligibility(client, coupon, activeLines.map((line) => line.categoryId)) : [];
    const deliveryFee = order.quote.deliveryFee;
    const smallCartFee = order.quote.smallCartFee;
    const { rows: [quoted] } = await client.query<{ quote: RevisionMoney }>(
      "SELECT pricing_revision_quote($1::jsonb) AS quote",
      [JSON.stringify({
        lines: preparedLines.map((pl, index) => ({
          lineTotal: pl.lineTotal,
          couponEligible: pl.count > 0 && (couponLines[index] ?? true),
          // A pickup earns no product commission (MNY-2); the commission base is the order's own rate card, before or after the shop-funded discount.
          commission: pl.count === 0 || order.pickupFee !== null ? undefined : byCategory.get(activeLines[index]?.categoryId ?? "")?.values.commission?.value,
        })),
        shopDiscount: order.discountRule?.rule ?? null,
        coupon: coupon ? { ...coupon.rule, funding: coupon.funding } : null,
        deliveryFee: deliveryFee.amount,
        deliveryPlatformShare: deliveryFee.platformShare,
        smallCartFee: smallCartFee?.amount ?? null,
        smallCartPlatformShare: smallCartFee?.platformShare ?? null,
        priorPlatformCoupon: order.priorPlatformCoupon,
        pickupFee: order.pickupFee,
        pickupShopFee: order.quote.pickup?.shopFee ?? null,
      })]);
    if (!quoted || quoted.quote.lines.length !== preparedLines.length) throw new Error("Failed to price the revision lines");
    const money = quoted.quote;
    for (const [index, pl] of preparedLines.entries()) {
      pl.shopDiscount = money.lines[index]?.shopDiscount ?? "0.00";
      pl.commission = money.lines[index]?.commission ?? "0.00";
    }
    const subtotalStr = money.productValue;
    const shopDiscountStr = money.shopDiscount;
    const shopCouponStr = money.shopCoupon;
    const platformCouponStr = money.platformCoupon;
    const totalCommissionStr = money.commission;
    const customerTotalStr = money.customerTotal;
    const platformContributionStr = money.platformContribution;
    const platformContributionPaise = toPaise(platformContributionStr);

    const revision = revisions?.nextRev ?? 1;

    const confirmByAt = new Date(now.getTime() + orderTimingConfig.confirmSeconds * 1000);
    // The coupon inside the snapshot says what the revision's columns say: whether it still applied, why not, and what each side pays (#70).
    const couponTook = money.couponReason === null;
    const couponReason = money.couponReason;
    const revisionQuote = {
      ...order.quote,
      ...(order.quote.coupon ? { coupon: { ...order.quote.coupon, applied: couponTook, reason: couponReason, shopFunded: shopCouponStr, platformFunded: platformCouponStr, cutback: money.couponCutback } } : {}),
      productValue: subtotalStr,
      shopDiscount: shopDiscountStr,
      shopCoupon: shopCouponStr,
      platformCoupon: platformCouponStr,
      customerTotal: customerTotalStr,
      commission: totalCommissionStr,
      platformContribution: platformContributionStr,
    };

    return {
      ok: true,
      order,
      activeLines,
      preparedLines,
      subtotalStr,
      shopDiscountStr,
      shopCouponStr,
      platformCouponStr,
      deliveryFee,
      smallCartFee,
      pickupFee: order.pickupFee,
      pickupFloor: order.pickupFee !== null ? order.quote.pickup?.contributionFloor ?? null : null,
      customerTotalStr,
      totalCommissionStr,
      platformContributionPaise,
      platformContributionStr,
      orderCard,
      revisionQuote,
      originalTotal: order.originalTotal,
      confirmByAt,
      revision,
    };
  }

  // S05 Accept in part: quote preview dry-run (ORD-3).
  app.post("/v1/me/shop-orders/:id/partial-accept/preview", {
    schema: { params: OrderParams, body: PartialAcceptOrderBody, response: { 200: PartialAcceptPreviewResponse, ...errors } },
  }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as OrderParams;
    const { lines: proposedLines } = request.body as PartialAcceptOrderBody;
    const now = clock.now();
    const evalResult = await evaluatePartialAccept(pool, id, who.accountId, proposedLines, now, orderTiming, false);
    if (!evalResult.ok) {
      const { status, code, shortLines } = evalResult;
      return reply.code(status ?? 400).send({ error: { code, ...(shortLines ? { shortLines } : {}) } });
    }
    return {
      productValue: evalResult.subtotalStr,
      shopDiscount: toPaise(evalResult.shopDiscountStr) > 0n && evalResult.order.discountRule ? { amount: evalResult.shopDiscountStr, offer: evalResult.order.discountRule.offer } : null,
      deliveryFee: evalResult.deliveryFee.amount,
      smallCartFee: evalResult.smallCartFee?.amount ?? null,
      pickupFee: evalResult.pickupFee,
      total: evalResult.customerTotalStr,
      originalTotal: evalResult.originalTotal,
      cancelsOrder: evalResult.platformContributionPaise < 0n,
      belowFloor: evalResult.platformContributionPaise >= 0n && floorShortfallPaise(evalResult) > 0n,
    };
  });

  // S05 Accept in part: shopkeeper proposes quantity reductions or removals (#64).
  app.post("/v1/me/shop-orders/:id/partial-accept", {
    schema: { params: OrderParams, body: PartialAcceptOrderBody, response: { 200: ShopOrderResponse, ...errors } },
  }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as OrderParams;
    const { lines: proposedLines } = request.body as PartialAcceptOrderBody;

    type Outcome = { code: string; status?: number; shortLines?: ShortLine[] } | { now: Date };
    const outcome = await withTransaction(pool, async (client): Promise<Outcome> => {
      const now = clock.now();
      const evalResult = await evaluatePartialAccept(client, id, who.accountId, proposedLines, now, orderTiming, true);
      if (!evalResult.ok) return evalResult;

      // Negative contribution: cancel immediately as cancelled_by_shop, actor system, reason negative_contribution
      if (evalResult.platformContributionPaise < 0n) {
        const { rows: [insertedRev] } = await client.query<{ id: string }>(
          `INSERT INTO order_revisions (
             order_id, revision, status, source_status, actor_id, actor_role, product_value, delivery_fee, small_cart_fee, total,
             commission, platform_contribution, quote, below_floor_exception, below_floor_shortfall, confirm_by_at, created_at,
             shop_discount, shop_discount_rule_id, shop_discount_rule_version, pickup_fee, shop_coupon, platform_coupon, coupon_id, coupon_version
           ) VALUES ($1, $2, 'cancelled_negative_contribution', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24) RETURNING id`,
          [id, evalResult.revision, evalResult.order.status, who.accountId, evalResult.order.role, evalResult.subtotalStr, evalResult.deliveryFee.amount, evalResult.smallCartFee?.amount ?? null, evalResult.customerTotalStr,
           evalResult.totalCommissionStr, evalResult.platformContributionStr, JSON.stringify(evalResult.revisionQuote), true, fromPaise(-evalResult.platformContributionPaise),
           evalResult.confirmByAt, now, evalResult.shopDiscountStr, evalResult.order.discountRule?.ruleId ?? null, evalResult.order.discountRule?.version ?? null, evalResult.pickupFee,
           evalResult.shopCouponStr, evalResult.platformCouponStr, evalResult.order.coupon?.couponId ?? null, evalResult.order.coupon?.version ?? null]);
        if (!insertedRev) throw new Error("Failed to insert order revision");
        for (const pl of evalResult.preparedLines) {
          await client.query(
            `INSERT INTO order_revision_lines (
               revision_id, position, listing_id, name, brand, base_unit, pack_quantity, original_count, count,
               original_part_quantity, part_quantity, unit_price, line_total, commission, shop_discount, stock_quantity, change_reason
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
            [insertedRev.id, pl.position, pl.listingId, pl.name, pl.brand, pl.baseUnit, pl.packQuantity, pl.originalCount, pl.count,
             pl.originalPartQuantity, pl.partQuantity, pl.unitPrice, pl.lineTotal, pl.commission, pl.shopDiscount, pl.stockQuantity, pl.changeReason]);
        }
        await moveOrder(client, evalResult.order, "cancelled_by_shop", { id: null, role: "system" }, now, "negative_contribution");
        await client.query("COMMIT");
        return { code: "NEGATIVE_CONTRIBUTION_CANCELLED", status: 409 };
      }

      const shortfallPaise = floorShortfallPaise(evalResult);
      const belowFloorException = shortfallPaise > 0n;
      const belowFloorShortfall = belowFloorException ? fromPaise(shortfallPaise) : null;

      const { rows: [insertedRev] } = await client.query<{ id: string }>(
        `INSERT INTO order_revisions (
           order_id, revision, status, source_status, actor_id, actor_role, product_value, delivery_fee, small_cart_fee, total,
           commission, platform_contribution, quote, below_floor_exception, below_floor_shortfall, confirm_by_at, created_at,
             shop_discount, shop_discount_rule_id, shop_discount_rule_version, pickup_fee, shop_coupon, platform_coupon, coupon_id, coupon_version
         ) VALUES ($1, $2, 'proposed', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24) RETURNING id`,
        [id, evalResult.revision, evalResult.order.status, who.accountId, evalResult.order.role, evalResult.subtotalStr, evalResult.deliveryFee.amount, evalResult.smallCartFee?.amount ?? null, evalResult.customerTotalStr,
         evalResult.totalCommissionStr, evalResult.platformContributionStr, JSON.stringify(evalResult.revisionQuote), belowFloorException, belowFloorShortfall,
         evalResult.confirmByAt, now, evalResult.shopDiscountStr, evalResult.order.discountRule?.ruleId ?? null, evalResult.order.discountRule?.version ?? null, evalResult.pickupFee,
         evalResult.shopCouponStr, evalResult.platformCouponStr, evalResult.order.coupon?.couponId ?? null, evalResult.order.coupon?.version ?? null]);

      if (!insertedRev) throw new Error("Failed to insert order revision");

      for (const pl of evalResult.preparedLines) {
        await client.query(
          `INSERT INTO order_revision_lines (
             revision_id, position, listing_id, name, brand, base_unit, pack_quantity, original_count, count,
             original_part_quantity, part_quantity, unit_price, line_total, commission, shop_discount, stock_quantity, change_reason
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
          [insertedRev.id, pl.position, pl.listingId, pl.name, pl.brand, pl.baseUnit, pl.packQuantity, pl.originalCount, pl.count,
           pl.originalPartQuantity, pl.partQuantity, pl.unitPrice, pl.lineTotal, pl.commission, pl.shopDiscount, pl.stockQuantity, pl.changeReason]);
      }

      if (!await moveOrder(client, evalResult.order, "awaiting_customer_confirm", { id: who.accountId, role: evalResult.order.role }, now)) {
        return { code: "ORDER_STATUS_CHANGED", status: 409 };
      }

      await client.query("COMMIT");
      return { now };
    });

    if (!("now" in outcome)) {
      const { status, ...error } = outcome;
      return reply.code(status ?? (error.code === "NOT_FOUND" ? 404 : 409)).send({ error });
    }
    return shopOrderView(pool, id, who.accountId, outcome.now, failureWaitSeconds);
  });

  const move = (to: Extract<OrderStatus, "preparing" | "out_for_delivery" | "arrived">) => async (request: FastifyRequest, reply: FastifyReply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as OrderParams;
    const now = await withTransaction(pool, async (client) => {
      // The order, then the caller's shop link are locked, so Deactivate (which takes the link first) and a delivery
      // start take turns: a link deleted while this waits makes the row vanish and the caller gets NOT_FOUND (#535).
      const { rows: [order] } = await client.query<{ id: string; status: OrderStatus; role: "owner" | "staff"; canDeliver: boolean }>(
        `SELECT o.id, o.status, m.role, (m.role = 'owner' OR m.can_deliver) AS "canDeliver" FROM orders o JOIN shop_members m ON m.shop_id = o.shop_id
         WHERE o.id = $1 AND m.account_id = $2 FOR UPDATE OF o FOR SHARE OF m`, [id, who.accountId]);
      if (!order) return "NOT_FOUND" as const;
      // Re-checked here, inside the transaction, so a Can deliver switched off meanwhile stops the delivery too.
      if (to !== "preparing" && !order.canDeliver) return "NOT_ASSIGNED" as const;
      const at = clock.now();
      if (to !== "preparing" && (await client.query("SELECT 1 FROM orders WHERE id = $1 AND deliverer_id = $2", [id, who.accountId])).rowCount === 0) return "NOT_ASSIGNED" as const;
      if (!await moveOrder(client, order, to, { id: who.accountId, role: order.role }, at)) return "ORDER_STATUS_CHANGED" as const;
      await client.query("COMMIT");
      return at;
    });
    if (now === "NOT_FOUND") return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    if (now === "NOT_ASSIGNED") return reply.code(403).send({ error: { code: "FORBIDDEN" } });
    if (now === "ORDER_STATUS_CHANGED") return reply.code(409).send({ error: { code: now } });
    return shopOrderView(pool, id, who.accountId, now, failureWaitSeconds);
  };
  app.post("/v1/me/shop-orders/:id/preparing", { schema: { params: OrderParams, response: { 200: ShopOrderResponse, ...errors } } }, move("preparing"));
  app.post("/v1/me/shop-orders/:id/out-for-delivery", { schema: { params: OrderParams, response: { 200: ShopOrderResponse, ...errors } } }, move("out_for_delivery"));
  app.post("/v1/me/shop-orders/:id/arrived", { schema: { params: OrderParams, response: { 200: ShopOrderResponse, ...errors } } }, move("arrived"));

  app.put("/v1/me/shop-orders/:id/ready", { schema: { params: OrderParams, body: AssignDelivererBody, response: { 200: ShopOrderResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as OrderParams;
    const { accountId } = request.body as AssignDelivererBody;
    const result = await withTransaction(pool, async (client) => {
      const { rows: [order] } = await client.query<{ id: string; shopId: string; status: OrderStatus; role: "owner" | "staff"; fulfilment: string }>(
        `SELECT o.id, o.shop_id AS "shopId", o.status, m.role, o.fulfilment FROM orders o JOIN shop_members m ON m.shop_id = o.shop_id
         WHERE o.id = $1 AND m.account_id = $2 FOR UPDATE OF o`, [id, who.accountId]);
      if (!order) return "NOT_FOUND" as const;
      // A pickup has no deliverer: it is made ready with Ready for pickup (FUL-7).
      if (order.fulfilment === "pickup") return "ORDER_IS_PICKUP" as const;
      const { rows: [deliverer] } = await client.query<{ role: "owner" | "staff"; canDeliver: boolean }>(
        `SELECT role, can_deliver AS "canDeliver" FROM shop_members WHERE shop_id = $1 AND account_id = $2 FOR SHARE`, [order.shopId, accountId]);
      if (!deliverer || (deliverer.role !== "owner" && !deliverer.canDeliver)) return "DELIVERER_NOT_ELIGIBLE" as const;
      const now = clock.now();
      // A Ready order not yet out for delivery can be handed to someone else by the Owner, e.g. after its
      // deliverer was deactivated (#535). Only the person changes: no status move, no new Ready time.
      const reassign = order.status === "ready" && order.role === "owner";
      if (!reassign && !await moveOrder(client, order, "ready", { id: who.accountId, role: order.role }, now)) return "ORDER_STATUS_CHANGED" as const;
      await client.query("UPDATE orders SET deliverer_id = $2 WHERE id = $1", [id, accountId]);
      await client.query("COMMIT");
      return now;
    });
    if (result === "NOT_FOUND") return reply.code(404).send({ error: { code: result } });
    if (result === "DELIVERER_NOT_ELIGIBLE" || result === "ORDER_IS_PICKUP" || result === "ORDER_STATUS_CHANGED") return reply.code(409).send({ error: { code: result } });
    return shopOrderView(pool, id, who.accountId, result, failureWaitSeconds);
  });

  // A pickup is made ready with no deliverer to name; the Customer then sees its code (FUL-7).
  app.post("/v1/me/shop-orders/:id/ready-for-pickup", { schema: { params: OrderParams, response: { 200: ShopOrderResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as OrderParams;
    const result = await withTransaction(pool, async (client) => {
      const { rows: [order] } = await client.query<{ id: string; status: OrderStatus; role: "owner" | "staff"; fulfilment: string }>(
        `SELECT o.id, o.status, m.role, o.fulfilment FROM orders o JOIN shop_members m ON m.shop_id = o.shop_id
         WHERE o.id = $1 AND m.account_id = $2 FOR UPDATE OF o`, [id, who.accountId]);
      if (!order) return "NOT_FOUND" as const;
      const now = clock.now();
      if (order.fulfilment !== "pickup" || !await moveOrder(client, order, "ready", { id: who.accountId, role: order.role }, now)) return "ORDER_STATUS_CHANGED" as const;
      await client.query("COMMIT");
      return now;
    });
    if (result === "NOT_FOUND") return reply.code(404).send({ error: { code: result } });
    if (result === "ORDER_STATUS_CHANGED") return reply.code(409).send({ error: { code: result } });
    return shopOrderView(pool, id, who.accountId, result, failureWaitSeconds);
  });

  // Completes a pickup at the counter: the Customer gives the same 4-digit code, there is no photo, and the shop records cash or UPI (FUL-7, MNY-1).
  app.post("/v1/me/shop-orders/:id/picked-up", { schema: { params: OrderParams, body: CompletePickupBody, response: { 200: ShopOrderResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as OrderParams;
    const { handoverCode, payment } = request.body as CompletePickupBody;
    const result = await withTransaction(pool, async (client) => {
      const { rows: [order] } = await client.query<{ id: string; status: OrderStatus; role: "owner" | "staff"; fulfilment: string } & Omit<HandoverCodeState, "id">>(
        `SELECT o.id, o.status, m.role, o.fulfilment, o.handover_code_hash AS "handoverCodeHash", o.handover_code_salt AS "handoverCodeSalt",
            o.handover_code_attempts AS "handoverCodeAttempts", o.handover_code_blocked_until AS "handoverCodeBlockedUntil"
         FROM orders o JOIN shop_members m ON m.shop_id = o.shop_id AND m.account_id = $2
         WHERE o.id = $1 FOR UPDATE OF o`, [id, who.accountId]);
      if (!order) return "NOT_FOUND" as const;
      if (order.fulfilment !== "pickup" || order.status !== "ready") return "ORDER_STATUS_CHANGED" as const;
      const now = clock.now();
      const refusal = await checkHandoverCode(client, order, handoverCode, now, secret);
      if (refusal) return refusal;
      if (!await moveOrder(client, order, "picked_up", { id: who.accountId, role: order.role }, now)) return "ORDER_STATUS_CHANGED" as const;
      await client.query("UPDATE orders SET delivery_payment = $2, handover_code_attempts = 0, handover_code_blocked_until = NULL WHERE id = $1", [id, payment]);
      await recordDeliverySale(client, id, who.accountId, now);
      await client.query("COMMIT");
      return now;
    });
    if (typeof result === "string") return sendRefusal(reply, result);
    return shopOrderView(pool, id, who.accountId, result, failureWaitSeconds);
  });

  // Owners manage the per-staff delivery capability; Owner accounts always qualify without a flag.
  app.put("/v1/me/shop-staff/:id/can-deliver", { schema: { params: OrderParams, body: SetStaffCanDeliverBody, response: { 200: SetStaffCanDeliverResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as OrderParams;
    const { canDeliver } = request.body as SetStaffCanDeliverBody;
    const { rows: [updated] } = await pool.query<{ accountId: string; canDeliver: boolean }>(
      `UPDATE shop_members target SET can_deliver = $3 FROM shop_members owner
       WHERE owner.account_id = $1 AND owner.role = 'owner' AND target.account_id = $2
         AND target.shop_id = owner.shop_id AND target.role = 'staff'
       RETURNING target.account_id AS "accountId", target.can_deliver AS "canDeliver"`, [who.accountId, id, canDeliver]);
    return updated ?? reply.code(404).send({ error: { code: "NOT_FOUND" } });
  });

  app.get("/v1/me/shop-staff", { schema: { response: { 200: ShopStaffResponse, 403: ErrorEnvelope, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { rows: [owner] } = await pool.query<{ shopId: string }>(
      "SELECT shop_id AS \"shopId\" FROM shop_members WHERE account_id = $1 AND role = 'owner'", [who.accountId]);
    if (!owner) return reply.code(403).send({ error: { code: "FORBIDDEN" } });
    const { rows } = await pool.query<ShopStaffResponse["staff"][number]>(
      `SELECT m.account_id AS "accountId", a.name, a.phone, m.can_deliver AS "canDeliver" FROM shop_members m
       JOIN accounts a ON a.id = m.account_id WHERE m.shop_id = $1 AND m.role = 'staff' ORDER BY lower(a.name), m.account_id`, [owner.shopId]);
    return { staff: rows };
  });

  app.post("/v1/me/shop-orders/:id/delivery-photo-upload", { schema: { params: OrderParams, body: DeliveryPhotoUploadBody, response: { 201: DeliveryPhotoUpload, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    if (!photos) return reply.code(503).send({ error: { code: "UNAVAILABLE" } });
    const { id } = request.params as OrderParams;
    const body = request.body as DeliveryPhotoUploadBody;
    return withTransaction(pool, async (client) => {
      const { rows: [order] } = await client.query<{ shopId: string }>(
        `SELECT shop_id AS "shopId" FROM orders WHERE id = $1 AND deliverer_id = $2 AND status = 'arrived' FOR UPDATE`, [id, who.accountId]);
      if (!order) return reply.code(409).send({ error: { code: "ORDER_STATUS_CHANGED" } });
      const { rows: [open] } = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM delivery_photo_uploads WHERE order_id = $1 AND expires_at > $2", [id, clock.now()]);
      if (open && open.count >= DELIVERY_PHOTO_OPEN_UPLOADS_MAX) return reply.code(400).send({ error: { code: "DELIVERY_PHOTO_INVALID" } });
      const upload = await photos.createUpload(id, who.accountId, body);
      await client.query(`INSERT INTO delivery_photo_uploads (id, order_id, account_id, byte_length, expires_at)
        VALUES ($1, $2, $3, $4, $5)`, [upload.id, id, who.accountId, body.byteLength, new Date(clock.now().getTime() + 15 * 60_000)]);
      await client.query("COMMIT");
      return reply.code(201).send(upload);
    });
  });

  const complete = (kind: "delivered" | "proof_exception") => async (request: FastifyRequest, reply: FastifyReply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    if (!photos) return reply.code(503).send({ error: { code: "UNAVAILABLE" } });
    const { id } = request.params as OrderParams;
    const body = request.body as CompleteDeliveryBody | ProofExceptionBody;
    const checked = await withTransaction(pool, (client) => actions.check(client, kind, id, who.accountId, body, clock.now(), true));
    if (typeof checked === "string") return sendRefusal(reply, checked);
    const photoKey = await actions.savePhoto(id, who.accountId, body.photoUploadId, checked.byteLength);
    if (photoKey === "UNAVAILABLE" || photoKey === "DELIVERY_PHOTO_INVALID") return sendRefusal(reply, photoKey);
    const now = clock.now();
    const result = await withTransaction(pool, (client) => actions.apply(client, kind, id, who.accountId, body, photoKey, now, true));
    if (typeof result === "string") return sendRefusal(reply, result);
    await actions.removeUpload(pool, id, who.accountId, result.uploadId);
    return shopOrderView(pool, id, who.accountId, now, failureWaitSeconds);
  };
  app.post("/v1/me/shop-orders/:id/delivered", { schema: { params: OrderParams, body: CompleteDeliveryBody, response: { 200: ShopOrderResponse, ...errors } } }, complete("delivered"));
  app.post("/v1/me/shop-orders/:id/proof-exception", { schema: { params: OrderParams, body: ProofExceptionBody, response: { 200: ShopOrderResponse, ...errors } } }, complete("proof_exception"));

  app.post("/v1/me/shop-orders/:id/call-attempt", { schema: { params: OrderParams, response: { 200: ShopOrderResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as OrderParams;
    const now = clock.now();
    const refusal = await withTransaction(pool, async (client) => {
      const refused = await actions.callAttempt(client, id, who.accountId, now);
      if (!refused) await client.query("COMMIT");
      return refused;
    });
    if (refusal === "NOT_FOUND") return reply.code(404).send({ error: { code: refusal } });
    if (refusal) return reply.code(409).send({ error: { code: refusal } });
    return shopOrderView(pool, id, who.accountId, now, failureWaitSeconds);
  });

  app.post("/v1/me/shop-orders/:id/delivery-failed", { schema: { params: OrderParams, body: FailDeliveryBody, response: { 200: ShopOrderResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    if (!photos) return reply.code(503).send({ error: { code: "UNAVAILABLE" } });
    const { id } = request.params as OrderParams;
    const body = request.body as FailDeliveryBody;
    const checked = await withTransaction(pool, (client) => actions.check(client, "failed", id, who.accountId, body, clock.now(), true));
    if (typeof checked === "string") return sendRefusal(reply, checked);
    const photoKey = await actions.savePhoto(id, who.accountId, body.photoUploadId, checked.byteLength);
    if (photoKey === "UNAVAILABLE" || photoKey === "DELIVERY_PHOTO_INVALID") return sendRefusal(reply, photoKey);
    const now = clock.now();
    const result = await withTransaction(pool, (client) => actions.apply(client, "failed", id, who.accountId, body, photoKey, now, true));
    if (typeof result === "string") return sendRefusal(reply, result);
    await actions.removeUpload(pool, id, who.accountId, result.uploadId);
    return shopOrderView(pool, id, who.accountId, now, failureWaitSeconds);
  });
}
