import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import {
  AssignDelivererBody, CompleteDeliveryBody, DeliveryPhotoUpload, DeliveryPhotoUploadBody, ErrorEnvelope, FailDeliveryBody, OrderParams, type OrderStatus, PartialAcceptOrderBody, ProofExceptionBody, RejectOrderBody, ShopOrderResponse, type ShopOrderSummary, SetStaffCanDeliverBody, SetStaffCanDeliverResponse,
  ShopDeliverersResponse, ShopOrdersResponse, ShopStaffResponse, type ShortLine, STOCK_HOLDING_ORDER_STATUSES, TERMINAL_ORDER_STATUSES,
} from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { InvalidDeliveryPhotoError, type DeliveryPhotoStorage } from "../adapters/delivery-photos";
import { withTransaction } from "../db";
import { createHandoverCode, HANDOVER_CODE_ATTEMPTS_BEFORE_COOLDOWN, HANDOVER_CODE_COOLDOWN_MS, HANDOVER_CODE_MAX_ATTEMPTS, ITEMS_CHECK_SECONDS, matchesHandoverCode, recordDeliverySale } from "../delivery";
import { stockOf } from "../listings";
import { moveOrder } from "../orders";
import { orderTiming } from "../order-timing";
import { deriveKeys, mobileSignedIn } from "../tokens";
import { answerExpired, frozenOrder } from "./orders";
import { resolveRateCard } from "./rate-cards";

/** Until when the shop can answer, while the order still waits for it. */
const expiresAt = (status: OrderStatus, placedAt: Date) => status === "placed" ? new Date(placedAt.getTime() + orderTiming.expireSeconds * 1000).toISOString() : null;

/** Unexpired photo uploads one order may hold at once; retakes after a failed try fit, a flood does not. */
const DELIVERY_PHOTO_OPEN_UPLOADS_MAX = 5;

/** S05: one order of the shop the account is Owner or Staff of, whether or not the shop is Live now (owner's answer 13 on #425). */
async function shopOrderView(client: Pool | PoolClient, orderId: string, accountId: string, now: Date, failureWaitSeconds: number): Promise<ShopOrderResponse | undefined> {
  const { rows: [row] } = await client.query<Omit<ShopOrderResponse, "placedAt" | "expiresAt" | "now" | "deliveryFailureReadyAt"> & { placedAt: Date; deliveryFailureReadyAt: Date | null }>(
    `SELECT o.id, o.number, o.status, o.placed_at AS "placedAt", ${frozenOrder("o")}, o.deliverer_id AS "delivererId",
        json_build_object('name', a.name, 'phone', CASE WHEN o.deliverer_id = $2 THEN a.phone END) AS customer,
        CASE WHEN o.deliverer_id = $2 THEN s.upi_id END AS "shopUpiId", (o.delivery_photo_key IS NOT NULL) AS "deliveryPhotoAvailable",
        CASE WHEN o.deliverer_id = $2 AND o.delivery_call_attempt_at IS NOT NULL THEN o.delivery_call_attempt_at + make_interval(secs => $3) END AS "deliveryFailureReadyAt"
      FROM orders o JOIN shops s ON s.id = o.shop_id JOIN shop_members m ON m.shop_id = o.shop_id
      JOIN accounts a ON a.id = o.account_id
      WHERE o.id = $1 AND m.account_id = $2`, [orderId, accountId, failureWaitSeconds]);
  return row && { ...row, placedAt: row.placedAt.toISOString(), expiresAt: expiresAt(row.status, row.placedAt), now: now.toISOString(), deliveryFailureReadyAt: row.deliveryFailureReadyAt?.toISOString() ?? null };
}

export function registerShopOrderRoutes(app: FastifyInstance, { pool, clock, secret, photos, failureWaitSeconds, photoSaveTimeoutMs = 60_000 }: { pool: Pool; clock: Clock; secret: string; photos?: DeliveryPhotoStorage; failureWaitSeconds: number; photoSaveTimeoutMs?: number }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const errors = { 400: ErrorEnvelope, 401: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope, 429: ErrorEnvelope, 503: ErrorEnvelope };
  const refusalStatus = { NOT_FOUND: 404, UNAVAILABLE: 503, DELIVERY_PHOTO_INVALID: 400, HANDOVER_CODE_WRONG: 400, HANDOVER_CODE_LOCKED: 429 } as const;
  const sendRefusal = (reply: FastifyReply, code: string) =>
    reply.code(refusalStatus[code as keyof typeof refusalStatus] ?? 409).send({ error: { code } });
  const removeDeliveryUpload = async (orderId: string, accountId: string, uploadId: string) => {
    if (!photos) return;
    try {
      await photos.deleteUpload(orderId, accountId, uploadId);
      await pool.query("DELETE FROM delivery_photo_uploads WHERE id = $1", [uploadId]);
    } catch {
      // Keep the row when either deletion step fails; the cleanup job retries it.
    }
  };
  const proofExpiresAt = (at: Date) => new Date(at.getTime() + 30 * 24 * 60 * 60 * 1000);

  // S04: the shop's orders in three groups (owner's answers 5 and 8 on #425).
  app.get("/v1/me/shop-orders", { schema: { response: { 200: ShopOrdersResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { rows: [member] } = await pool.query<{ shopId: string; canDeliver: boolean }>('SELECT shop_id AS "shopId", (role = \'owner\' OR can_deliver) AS "canDeliver" FROM shop_members WHERE account_id = $1', [who.accountId]);
    if (!member) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    const now = clock.now();
    type Row = Omit<ShopOrderSummary, "placedAt" | "expiresAt"> & { placedAt: Date };
    // A placed order past its time is in no group until #57 moves it to Expired, so no Accept shows that can't work.
    const { rows } = await pool.query<Row>(
        `SELECT o.id, o.number, o.status, o.deliverer_id AS "delivererId", o.placed_at AS "placedAt",
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
            json_build_object('flat', o.address_flat, 'areaLine', o.address_area_line) AS address,
            CASE WHEN o.status = 'awaiting_customer_confirm' THEN (
              SELECT to_char(p.confirm_by_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              FROM order_revisions p WHERE p.order_id = o.id AND p.status = 'proposed' ORDER BY p.revision DESC LIMIT 1
            ) END AS "confirmByAt"
          FROM orders o
          WHERE o.shop_id = $1 AND (
            (o.status = 'placed' AND NOT ${answerExpired("o", "$2")})
            OR o.status = ANY($3::text[])
            OR (o.status = ANY($4::text[]) AND (o.status_changed_at AT TIME ZONE 'Asia/Kolkata')::date = ($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::date))
          ORDER BY CASE WHEN o.status = ANY($4::text[]) THEN -extract(epoch FROM o.status_changed_at) ELSE extract(epoch FROM o.placed_at) END`,
        [member.shopId, now, STOCK_HOLDING_ORDER_STATUSES, TERMINAL_ORDER_STATUSES]);
    const summary = (row: Row): ShopOrderSummary => ({
      ...row,
      placedAt: row.placedAt.toISOString(),
      expiresAt: expiresAt(row.status, row.placedAt),
      confirmByAt: row.confirmByAt ?? null,
    });
    return {
      now: now.toISOString(),
      canDeliver: member.canDeliver,
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
      const { rows: [order] } = await client.query<{ id: string; status: OrderStatus; placedAt: Date; role: "owner" | "staff" }>(
        `SELECT o.id, o.status, o.placed_at AS "placedAt", m.role FROM orders o JOIN shop_members m ON m.shop_id = o.shop_id
         WHERE o.id = $1 AND m.account_id = $2 FOR UPDATE OF o`, [id, who.accountId]);
      if (!order) return { code: "NOT_FOUND" };
      if (order.status !== "placed") return { code: "ORDER_STATUS_CHANGED" };
      // Read after the lock, so a wait on it can't stamp an earlier time.
      const now = clock.now();
      if (now.getTime() >= order.placedAt.getTime() + orderTiming.expireSeconds * 1000) return { code: "ORDER_EXPIRED" };
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
      const { rows: [order] } = await client.query<{
        id: string;
        shopId: string;
        status: OrderStatus;
        placedAt: Date;
        role: "owner" | "staff";
        rateCardVersion: string;
        quote: {
          deliveryFee: { amount: string; platformShare: string; shopShare: string };
          smallCartFee: { amount: string; platformShare: string; shopShare: string } | null;
        };
      }>(
        `SELECT o.id, o.shop_id AS "shopId", o.status, o.placed_at AS "placedAt", m.role,
                o.rate_card_version AS "rateCardVersion", o.quote
         FROM orders o JOIN shop_members m ON m.shop_id = o.shop_id
         WHERE o.id = $1 AND m.account_id = $2 FOR UPDATE OF o`, [id, who.accountId]);
      if (!order) return { code: "NOT_FOUND", status: 404 };

      // Placed order past answer time cannot be answered.
      const now = clock.now();
      if (order.status === "placed" && now.getTime() >= order.placedAt.getTime() + orderTiming.expireSeconds * 1000) {
        return { code: "ORDER_EXPIRED", status: 409 };
      }

      if (order.status === "awaiting_customer_confirm") {
        return { code: "PROPOSAL_OPEN", status: 409 };
      }

      if (order.status !== "placed" && order.status !== "accepted" && order.status !== "preparing") {
        return { code: "ORDER_STATUS_CHANGED", status: 409 };
      }

      // Check if an open proposal already exists
      const { rows: openProposals } = await client.query(
        "SELECT 1 FROM order_revisions WHERE order_id = $1 AND status = 'proposed'", [id]);
      if (openProposals.length > 0) return { code: "PROPOSAL_OPEN", status: 409 };

      // Find current active lines: latest confirmed revision if one exists, else order_lines
      const { rows: [confirmedRev] } = await client.query<{ id: string }>(
        "SELECT id FROM order_revisions WHERE order_id = $1 AND status = 'confirmed' ORDER BY revision DESC LIMIT 1", [id]);

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
             WHERE rl.revision_id = $1
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
             ORDER BY ol.position`, [id]);

      const proposedListingIds = proposedLines.map((l) => l.listingId);
      if (new Set(proposedListingIds).size !== proposedListingIds.length) {
        return { code: "INVALID_PARTIAL_ACCEPT", status: 409 };
      }

      const proposedMap = new Map(proposedLines.map((l) => [l.listingId, l]));

      // Validate all proposed lines exist in active lines
      for (const p of proposedLines) {
        if (!activeLines.some((l) => l.listingId === p.listingId)) {
          return { code: "INVALID_PARTIAL_ACCEPT", status: 400 };
        }
      }

      // Lock affected shop listings in deterministic ID order, compatible with Accept flow
      const allListingIds = [...new Set(activeLines.map((l) => l.listingId))].sort();
      if (allListingIds.length > 0) {
        await client.query("SELECT 1 FROM shop_listings WHERE id = ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE", [allListingIds]);
      }

      let changedCount = 0;
      let remainingCount = 0;

      for (const line of activeLines) {
        const proposed = proposedMap.get(line.listingId);
        const targetCount = proposed ? proposed.count : line.count;

        // Cannot increase quantity
        if (targetCount > line.count) {
          return { code: "INVALID_PARTIAL_ACCEPT", status: 400 };
        }

        // If line has partQuantity, count must be 0 or 1
        if (line.partQuantity !== null && targetCount !== 0 && targetCount !== 1) {
          return { code: "INVALID_PARTIAL_ACCEPT", status: 400 };
        }

        if (targetCount < line.count) {
          changedCount += 1;
          if (!proposed?.reason) {
            return { code: "INVALID_PARTIAL_ACCEPT", status: 400 };
          }
        }

        if (targetCount > 0) {
          remainingCount += 1;
        }
      }

      if (changedCount === 0) {
        return { code: "INVALID_PARTIAL_ACCEPT", status: 400 };
      }

      if (remainingCount === 0) {
        return { code: "EMPTY_ORDER", status: 400 };
      }

      // Requote with order.rateCardVersion using exact integer paise arithmetic (ADR-0004)
      const toPaise = (str: string): bigint => {
        const isNegative = str.startsWith("-");
        const s = isNegative ? str.slice(1) : str;
        const [whole = "0", frac = ""] = s.split(".");
        const cents = (frac + "00").slice(0, 2);
        const paise = BigInt(whole) * 100n + BigInt(cents);
        return isNegative ? -paise : paise;
      };

      const fromPaise = (paise: bigint): string => {
        const isNegative = paise < 0n;
        const abs = isNegative ? -paise : paise;
        const whole = abs / 100n;
        const frac = abs % 100n;
        return `${isNegative ? "-" : ""}${whole}.${frac.toString().padStart(2, "0")}`;
      };

      const orderCard = await resolveRateCard(client, order.shopId, undefined, order.rateCardVersion);

      const categories = [...new Set(activeLines.map((l) => l.categoryId))];
      const byCategory = new Map(await Promise.all(categories.map(async (catId) => [catId, await resolveRateCard(client, order.shopId, catId, order.rateCardVersion)] as const)));

      let subtotalPaise = 0n;
      let totalCommissionPaise = 0n;

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
        stockQuantity: string;
        changeReason: string | null;
      };

      const preparedLines: PreparedRevisionLine[] = [];

      for (const line of activeLines) {
        const proposed = proposedMap.get(line.listingId);
        const count = proposed ? proposed.count : line.count;
        const changeReason = count < line.count ? (proposed?.reason ?? null) : null;
        const partQuantity = line.partQuantity !== null && count > 0 ? line.partQuantity : null;

        let lineTotalStr = "0.00";
        let lineCommissionStr = "0.00";
        let stockQuantityStr = "0.000";

        if (count > 0) {
          const lineTotalPaise = partQuantity !== null
            ? toPaise(line.unitPrice)
            : toPaise(line.unitPrice) * BigInt(count);
          lineTotalStr = fromPaise(lineTotalPaise);
          subtotalPaise += lineTotalPaise;

          const categoryCard = byCategory.get(line.categoryId);
          const commissionRule = categoryCard?.values.commission?.value;
          if (commissionRule) {
            const { rows: [commRow] } = await client.query<{ comm: string }>(
              "SELECT pricing_line_commission($1::numeric, $2::jsonb)::text AS comm",
              [lineTotalStr, JSON.stringify(commissionRule)]);
            lineCommissionStr = commRow?.comm ?? "0.00";
            totalCommissionPaise += toPaise(lineCommissionStr);
          }

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
          commission: lineCommissionStr,
          stockQuantity: stockQuantityStr,
          changeReason,
        });
      }

      // The proposal holds its lines (awaiting_customer_confirm is a holding status). A placed order holds
      // nothing yet, so stock other orders took since placement may be gone: each line may hold no more than
      // stock left plus what this order already holds. A cut to an existing hold never needs new stock.
      const holdsNow = STOCK_HOLDING_ORDER_STATUSES.includes(order.status);
      const { rows: shortLines } = await client.query<ShortLine>(
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
      if (shortLines.length > 0) return { code: "NOT_ENOUGH_STOCK", status: 409, shortLines };

      const subtotalStr = fromPaise(subtotalPaise);
      const totalCommissionStr = fromPaise(totalCommissionPaise);

      const deliveryFee = order.quote.deliveryFee;
      const smallCartFee = order.quote.smallCartFee;
      const deliveryPlatformSharePaise = toPaise(deliveryFee.platformShare);
      const smallCartPlatformSharePaise = smallCartFee ? toPaise(smallCartFee.platformShare) : 0n;
      const deliveryFeeAmountPaise = toPaise(deliveryFee.amount);
      const smallCartFeeAmountPaise = smallCartFee ? toPaise(smallCartFee.amount) : 0n;

      const customerTotalPaise = subtotalPaise + deliveryFeeAmountPaise + smallCartFeeAmountPaise;
      const platformContributionPaise = totalCommissionPaise + deliveryPlatformSharePaise + smallCartPlatformSharePaise;

      const customerTotalStr = fromPaise(customerTotalPaise);
      const platformContributionStr = fromPaise(platformContributionPaise);

      const { rows: [revRow] } = await client.query<{ nextRev: number }>(
        "SELECT COALESCE(max(revision), 0) + 1 AS \"nextRev\" FROM order_revisions WHERE order_id = $1", [id]);
      const revision = revRow?.nextRev ?? 1;

      const confirmByAt = new Date(now.getTime() + orderTiming.confirmSeconds * 1000);
      const revisionQuote = {
        ...order.quote,
        productValue: subtotalStr,
        customerTotal: customerTotalStr,
        commission: totalCommissionStr,
        platformContribution: platformContributionStr,
      };

      // Negative contribution: cancel immediately as cancelled_by_shop, actor system, reason negative_contribution
      if (platformContributionPaise < 0n) {
        const { rows: [insertedRev] } = await client.query<{ id: string }>(
          `INSERT INTO order_revisions (
             order_id, revision, status, source_status, actor_id, actor_role, product_value, delivery_fee, small_cart_fee, total,
             commission, platform_contribution, quote, below_floor_exception, below_floor_shortfall, confirm_by_at, created_at
           ) VALUES ($1, $2, 'cancelled_negative_contribution', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
          [id, revision, order.status, who.accountId, order.role, subtotalStr, deliveryFee.amount, smallCartFee?.amount ?? null, customerTotalStr,
           totalCommissionStr, platformContributionStr, JSON.stringify(revisionQuote), true, fromPaise(-platformContributionPaise),
           confirmByAt, now]);
        if (!insertedRev) throw new Error("Failed to insert order revision");
        for (const pl of preparedLines) {
          await client.query(
            `INSERT INTO order_revision_lines (
               revision_id, position, listing_id, name, brand, base_unit, pack_quantity, original_count, count,
               original_part_quantity, part_quantity, unit_price, line_total, commission, stock_quantity, change_reason
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
            [insertedRev.id, pl.position, pl.listingId, pl.name, pl.brand, pl.baseUnit, pl.packQuantity, pl.originalCount, pl.count,
             pl.originalPartQuantity, pl.partQuantity, pl.unitPrice, pl.lineTotal, pl.commission, pl.stockQuantity, pl.changeReason]);
        }
        await moveOrder(client, order, "cancelled_by_shop", { id: null, role: "system" }, now, "negative_contribution");
        await client.query("COMMIT");
        return { code: "NEGATIVE_CONTRIBUTION_CANCELLED", status: 409 };
      }

      const floorValue = orderCard?.values.deliveredContributionFloor?.value;
      const floorPaise = typeof floorValue === "string" ? toPaise(floorValue) : 0n;

      const belowFloorException = platformContributionPaise < floorPaise;
      const belowFloorShortfall = belowFloorException ? fromPaise(floorPaise - platformContributionPaise) : null;

      const { rows: [insertedRev] } = await client.query<{ id: string }>(
        `INSERT INTO order_revisions (
           order_id, revision, status, source_status, actor_id, actor_role, product_value, delivery_fee, small_cart_fee, total,
           commission, platform_contribution, quote, below_floor_exception, below_floor_shortfall, confirm_by_at, created_at
         ) VALUES ($1, $2, 'proposed', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
        [id, revision, order.status, who.accountId, order.role, subtotalStr, deliveryFee.amount, smallCartFee?.amount ?? null, customerTotalStr,
         totalCommissionStr, platformContributionStr, JSON.stringify(revisionQuote), belowFloorException, belowFloorShortfall,
         confirmByAt, now]);

      if (!insertedRev) throw new Error("Failed to insert order revision");

      for (const pl of preparedLines) {
        await client.query(
          `INSERT INTO order_revision_lines (
             revision_id, position, listing_id, name, brand, base_unit, pack_quantity, original_count, count,
             original_part_quantity, part_quantity, unit_price, line_total, commission, stock_quantity, change_reason
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
          [insertedRev.id, pl.position, pl.listingId, pl.name, pl.brand, pl.baseUnit, pl.packQuantity, pl.originalCount, pl.count,
           pl.originalPartQuantity, pl.partQuantity, pl.unitPrice, pl.lineTotal, pl.commission, pl.stockQuantity, pl.changeReason]);
      }

      if (!await moveOrder(client, order, "awaiting_customer_confirm", { id: who.accountId, role: order.role }, now)) {
        return { code: "ORDER_STATUS_CHANGED", status: 409 };
      }

      await client.query("COMMIT");
      return { now };
    });

    if (!("now" in outcome)) {
      const { status, ...error } = outcome;
      return reply.code(status ?? 409).send({ error });
    }
    return shopOrderView(pool, id, who.accountId, outcome.now, failureWaitSeconds);
  });

  const move = (to: Extract<OrderStatus, "preparing" | "out_for_delivery" | "arrived">) => async (request: FastifyRequest, reply: FastifyReply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as OrderParams;
    const now = await withTransaction(pool, async (client) => {
      const { rows: [order] } = await client.query<{ id: string; status: OrderStatus; role: "owner" | "staff" }>(
        `SELECT o.id, o.status, m.role FROM orders o JOIN shop_members m ON m.shop_id = o.shop_id
         WHERE o.id = $1 AND m.account_id = $2 FOR UPDATE OF o`, [id, who.accountId]);
      if (!order) return "NOT_FOUND" as const;
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
      const { rows: [order] } = await client.query<{ id: string; shopId: string; status: OrderStatus; role: "owner" | "staff" }>(
        `SELECT o.id, o.shop_id AS "shopId", o.status, m.role FROM orders o JOIN shop_members m ON m.shop_id = o.shop_id
         WHERE o.id = $1 AND m.account_id = $2 FOR UPDATE OF o`, [id, who.accountId]);
      if (!order) return "NOT_FOUND" as const;
      const { rows: [deliverer] } = await client.query<{ role: "owner" | "staff"; canDeliver: boolean }>(
        `SELECT role, can_deliver AS "canDeliver" FROM shop_members WHERE shop_id = $1 AND account_id = $2 FOR SHARE`, [order.shopId, accountId]);
      if (!deliverer || (deliverer.role !== "owner" && !deliverer.canDeliver)) return "DELIVERER_NOT_ELIGIBLE" as const;
      const now = clock.now();
      if (!await moveOrder(client, order, "ready", { id: who.accountId, role: order.role }, now)) return "ORDER_STATUS_CHANGED" as const;
      await client.query("UPDATE orders SET deliverer_id = $2 WHERE id = $1", [id, accountId]);
      await client.query("COMMIT");
      return now;
    });
    if (result === "NOT_FOUND") return reply.code(404).send({ error: { code: result } });
    if (result === "DELIVERER_NOT_ELIGIBLE") return reply.code(409).send({ error: { code: result } });
    if (result === "ORDER_STATUS_CHANGED") return reply.code(409).send({ error: { code: result } });
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
      `SELECT m.account_id AS "accountId", a.name, m.can_deliver AS "canDeliver" FROM shop_members m
       JOIN accounts a ON a.id = m.account_id WHERE m.shop_id = $1 AND m.role = 'staff' ORDER BY lower(a.name)`, [owner.shopId]);
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

  // The photo is read, transcoded and written between two short transactions, so no order row stays locked
  // while storage is slow. A photo left behind when the second one refuses is removed with its upload row.
  const savePhoto = async (orderId: string, accountId: string, uploadId: string, byteLength: number) => {
    if (!photos) return "UNAVAILABLE" as const;
    // The save is stopped through the signal and awaited, so when this returns nothing of it is still running
    // and cleanup, which waits for the 5-minute lease, never meets a photo being processed.
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), photoSaveTimeoutMs);
    try { return await photos.save(orderId, accountId, uploadId, byteLength, stop.signal); }
    catch (error) {
      if (error instanceof InvalidDeliveryPhotoError || (error as { name?: string }).name === "NoSuchKey") return "DELIVERY_PHOTO_INVALID" as const;
      return "UNAVAILABLE" as const;
    } finally { clearTimeout(timer); }
  };
  /** Holds the upload against cleanup while the photo is read and saved, which happens outside any lock. */
  const PHOTO_SAVE_LEASE_MS = 5 * 60_000;
  const leaseUpload = async (client: PoolClient, uploadId: string, now: Date) => {
    const leased = await client.query("UPDATE delivery_photo_uploads SET processing_until = $2 WHERE id = $1", [uploadId, new Date(now.getTime() + PHOTO_SAVE_LEASE_MS)]);
    return leased.rowCount === 1;
  };
  /** Locks the arrived order of this deliverer and the upload they chose, for the second transaction. */
  const lockArrived = async (client: PoolClient, orderId: string, accountId: string, uploadId: string) => {
    const { rows: [order] } = await client.query<{ status: OrderStatus; role: "owner" | "staff" }>(
      `SELECT o.status, m.role FROM orders o JOIN shop_members m ON m.shop_id = o.shop_id
       WHERE o.id = $1 AND o.deliverer_id = $2 AND m.account_id = $2 FOR UPDATE OF o`, [orderId, accountId]);
    if (!order) return "NOT_FOUND" as const;
    if (order.status !== "arrived") return "ORDER_STATUS_CHANGED" as const;
    const upload = await client.query("SELECT 1 FROM delivery_photo_uploads WHERE id = $1 AND order_id = $2 AND account_id = $3 AND expires_at > $4 FOR UPDATE", [uploadId, orderId, accountId, clock.now()]);
    if (!upload.rowCount) return "DELIVERY_PHOTO_INVALID" as const;
    return order;
  };

  const complete = (proofException: boolean) => async (request: FastifyRequest, reply: FastifyReply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    if (!photos) return reply.code(503).send({ error: { code: "UNAVAILABLE" } });
    const { id } = request.params as OrderParams;
    const body = request.body as CompleteDeliveryBody | ProofExceptionBody;
    const checked = await withTransaction(pool, async (client) => {
      const { rows: [order] } = await client.query<{ id: string; status: OrderStatus; statusChangedAt: Date; handoverCodeHash: string | null; handoverCodeSalt: string | null; handoverCodeAttempts: number; handoverCodeBlockedUntil: Date | null; itemsCheckedAt: Date | null; callAttemptAt: Date | null }>(
        `SELECT o.id, o.status, o.status_changed_at AS "statusChangedAt", o.handover_code_hash AS "handoverCodeHash", o.handover_code_salt AS "handoverCodeSalt",
          o.handover_code_attempts AS "handoverCodeAttempts", o.handover_code_blocked_until AS "handoverCodeBlockedUntil", o.items_checked_at AS "itemsCheckedAt",
          o.delivery_call_attempt_at AS "callAttemptAt"
         FROM orders o JOIN shop_members m ON m.shop_id = o.shop_id AND m.account_id = $2
         WHERE o.id = $1 AND o.deliverer_id = $2 FOR UPDATE OF o`, [id, who.accountId]);
      if (!order) return "NOT_FOUND" as const;
      const now = clock.now();
      if (order.status !== "arrived") return "ORDER_STATUS_CHANGED" as const;
      if (!order.itemsCheckedAt && now.getTime() < order.statusChangedAt.getTime() + ITEMS_CHECK_SECONDS * 1000) return "ITEM_CHECK_WAIT" as const;
      const { rows: [upload] } = await client.query<{ byteLength: number; expiresAt: Date }>(
        `SELECT byte_length AS "byteLength", expires_at AS "expiresAt" FROM delivery_photo_uploads
         WHERE id = $1 AND order_id = $2 AND account_id = $3`, [body.photoUploadId, id, who.accountId]);
      if (!upload || upload.expiresAt <= now) return "DELIVERY_PHOTO_INVALID" as const;
      if (proofException) {
        // A deliverer who cannot get the code must have tried to reach the Customer first (no wait, unlike a failed delivery).
        if (!order.callAttemptAt) return "PROOF_EXCEPTION_CALL_REQUIRED" as const;
      } else {
        if (order.handoverCodeBlockedUntil && order.handoverCodeBlockedUntil > now) return "HANDOVER_CODE_LOCKED" as const;
        if (order.handoverCodeAttempts >= HANDOVER_CODE_MAX_ATTEMPTS) return "HANDOVER_CODE_LOCKED" as const;
        if (!order.handoverCodeHash || !order.handoverCodeSalt) {
          // An order accepted before the code existed: make one now, so the Customer can read it, and count nothing against the deliverer.
          const generated = createHandoverCode(secret);
          await client.query(`UPDATE orders SET handover_code_hash = $2, handover_code_salt = $3, handover_code_ciphertext = $4
            WHERE id = $1 AND handover_code_hash IS NULL`, [id, generated.hash, generated.salt, generated.ciphertext]);
          await client.query("COMMIT");
          return "HANDOVER_CODE_WRONG" as const;
        }
        const { handoverCode } = body as CompleteDeliveryBody;
        if (!matchesHandoverCode(handoverCode, order.handoverCodeSalt, order.handoverCodeHash)) {
          const attempts = order.handoverCodeAttempts + 1;
          const blockedUntil = attempts === HANDOVER_CODE_ATTEMPTS_BEFORE_COOLDOWN ? new Date(now.getTime() + HANDOVER_CODE_COOLDOWN_MS) : order.handoverCodeBlockedUntil;
          await client.query("UPDATE orders SET handover_code_attempts = $2, handover_code_blocked_until = $3 WHERE id = $1", [id, attempts, blockedUntil]);
          await client.query("COMMIT");
          return attempts === HANDOVER_CODE_ATTEMPTS_BEFORE_COOLDOWN || attempts >= HANDOVER_CODE_MAX_ATTEMPTS ? "HANDOVER_CODE_LOCKED" as const : "HANDOVER_CODE_WRONG" as const;
        }
      }
      if (!await leaseUpload(client, body.photoUploadId, now)) return "DELIVERY_PHOTO_INVALID" as const;
      await client.query("COMMIT");
      return { byteLength: upload.byteLength };
    });
    if (typeof checked === "string") return sendRefusal(reply, checked);
    const photoKey = await savePhoto(id, who.accountId, body.photoUploadId, checked.byteLength);
    if (photoKey === "UNAVAILABLE" || photoKey === "DELIVERY_PHOTO_INVALID") return sendRefusal(reply, photoKey);
    const result = await withTransaction(pool, async (client) => {
      const order = await lockArrived(client, id, who.accountId, body.photoUploadId);
      if (typeof order === "string") return order;
      const now = clock.now();
      if (!await moveOrder(client, { id, status: order.status }, "delivered", { id: who.accountId, role: order.role }, now)) return "ORDER_STATUS_CHANGED" as const;
      await client.query(`UPDATE orders SET delivery_photo_key = $2, delivery_photo_expires_at = $3, delivery_payment = $4, proof_exception = $5,
        proof_exception_reason = $6, handover_code_attempts = 0, handover_code_blocked_until = NULL WHERE id = $1`,
      [id, photoKey, proofExpiresAt(now), body.payment, proofException, proofException ? (body as ProofExceptionBody).reason : null]);
      await recordDeliverySale(client, id, who.accountId, now);
      await client.query("COMMIT");
      return { now, uploadId: body.photoUploadId };
    });
    if (typeof result === "string") return sendRefusal(reply, result);
    await removeDeliveryUpload(id, who.accountId, result.uploadId);
    return shopOrderView(pool, id, who.accountId, result.now, failureWaitSeconds);
  };
  app.post("/v1/me/shop-orders/:id/delivered", { schema: { params: OrderParams, body: CompleteDeliveryBody, response: { 200: ShopOrderResponse, ...errors } } }, complete(false));
  app.post("/v1/me/shop-orders/:id/proof-exception", { schema: { params: OrderParams, body: ProofExceptionBody, response: { 200: ShopOrderResponse, ...errors } } }, complete(true));

  app.post("/v1/me/shop-orders/:id/call-attempt", { schema: { params: OrderParams, response: { 200: ShopOrderResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as OrderParams;
    const result = await withTransaction(pool, async (client) => {
      const { rows: [order] } = await client.query<{ status: OrderStatus; role: "owner" | "staff" }>(
        `SELECT o.status, m.role FROM orders o JOIN shop_members m ON m.shop_id = o.shop_id
         WHERE o.id = $1 AND o.deliverer_id = $2 AND m.account_id = $2 FOR UPDATE OF o`, [id, who.accountId]);
      if (!order) return "NOT_FOUND" as const;
      if (order.status !== "arrived") return "ORDER_STATUS_CHANGED" as const;
      const now = clock.now();
      await client.query("UPDATE orders SET delivery_call_attempt_at = COALESCE(delivery_call_attempt_at, $2) WHERE id = $1", [id, now]);
      await client.query("COMMIT");
      return now;
    });
    if (result === "NOT_FOUND") return reply.code(404).send({ error: { code: result } });
    if (result === "ORDER_STATUS_CHANGED") return reply.code(409).send({ error: { code: result } });
    return shopOrderView(pool, id, who.accountId, result, failureWaitSeconds);
  });

  app.post("/v1/me/shop-orders/:id/delivery-failed", { schema: { params: OrderParams, body: FailDeliveryBody, response: { 200: ShopOrderResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    if (!photos) return reply.code(503).send({ error: { code: "UNAVAILABLE" } });
    const { id } = request.params as OrderParams;
    const body = request.body as FailDeliveryBody;
    const checked = await withTransaction(pool, async (client) => {
      const { rows: [order] } = await client.query<{ status: OrderStatus; callAttemptAt: Date | null }>(
        `SELECT o.status, o.delivery_call_attempt_at AS "callAttemptAt" FROM orders o JOIN shop_members m ON m.shop_id = o.shop_id
         WHERE o.id = $1 AND o.deliverer_id = $2 AND m.account_id = $2 FOR UPDATE OF o`, [id, who.accountId]);
      if (!order) return "NOT_FOUND" as const;
      const now = clock.now();
      if (order.status !== "arrived") return "ORDER_STATUS_CHANGED" as const;
      if (!order.callAttemptAt) return "DELIVERY_FAILURE_CALL_REQUIRED" as const;
      if (now.getTime() < order.callAttemptAt.getTime() + failureWaitSeconds * 1000) return "DELIVERY_FAILURE_WAIT" as const;
      const { rows: [upload] } = await client.query<{ byteLength: number; expiresAt: Date }>(
        `SELECT byte_length AS "byteLength", expires_at AS "expiresAt" FROM delivery_photo_uploads
         WHERE id = $1 AND order_id = $2 AND account_id = $3`, [body.photoUploadId, id, who.accountId]);
      if (!upload || upload.expiresAt <= now) return "DELIVERY_PHOTO_INVALID" as const;
      if (!await leaseUpload(client, body.photoUploadId, now)) return "DELIVERY_PHOTO_INVALID" as const;
      await client.query("COMMIT");
      return { byteLength: upload.byteLength };
    });
    if (typeof checked === "string") return sendRefusal(reply, checked);
    const photoKey = await savePhoto(id, who.accountId, body.photoUploadId, checked.byteLength);
    if (photoKey === "UNAVAILABLE" || photoKey === "DELIVERY_PHOTO_INVALID") return sendRefusal(reply, photoKey);
    const result = await withTransaction(pool, async (client) => {
      const order = await lockArrived(client, id, who.accountId, body.photoUploadId);
      if (typeof order === "string") return order;
      const now = clock.now();
      if (!await moveOrder(client, { id, status: order.status }, "delivery_failed", { id: who.accountId, role: order.role }, now, body.reason)) return "ORDER_STATUS_CHANGED" as const;
      await client.query("UPDATE orders SET delivery_photo_key = $2, delivery_photo_expires_at = $3, failed_delivery_reason = $4 WHERE id = $1", [id, photoKey, proofExpiresAt(now), body.reason]);
      await client.query("COMMIT");
      return { now, uploadId: body.photoUploadId };
    });
    if (typeof result === "string") return sendRefusal(reply, result);
    await removeDeliveryUpload(id, who.accountId, result.uploadId);
    return shopOrderView(pool, id, who.accountId, result.now, failureWaitSeconds);
  });
}
