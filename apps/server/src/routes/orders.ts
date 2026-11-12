import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import {
  CartParams, ErrorEnvelope, OrderParams, OrderResponse, type OrderStatus, OrdersResponse, type OrderSummary, PlaceOrderBody, ReceiptResponse,
  TERMINAL_ORDER_STATUSES,
} from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { withTransaction } from "../db";
import { createHandoverCode, HANDOVER_CODE_MAX_ATTEMPTS, ITEMS_CHECK_SECONDS, revealHandoverCode } from "../delivery";
import { cancelRules, queueNotification } from "../notifications";
import { moveOrder, recordStatus } from "../orders";
import { orderTiming } from "../order-timing";
import { deriveKeys, mobileSignedIn } from "../tokens";
import { offerSql, packsOf, pricedCart, savedCart } from "./cart";
import { servingShops } from "./feed";
import { latestRateCardVersion } from "./price-simulator";

/**
 * The columns C19 and S05 both show of order `o`, as it was frozen: address, lines, amounts, and the shop's
 * reason when it rejected the order (owner's answer 3 on #425).
 */
export const frozenOrder = (o: string, includeListingId = false) => `${o}.fulfilment,
        CASE WHEN ${o}.fulfilment = 'delivery' THEN json_build_object('label', ${o}.address_label, 'flat', ${o}.address_flat,
          'areaLine', ${o}.address_area_line, 'pincode', ${o}.address_pincode) END AS address,
        COALESCE(
          (SELECT json_agg(json_build_object(${includeListingId ? "'listingId', rl.listing_id, " : ""}'name', rl.name, 'brand', rl.brand, 'baseUnit', rl.base_unit,
              'quantity', trim_scale(rl.pack_quantity)::text, 'count', rl.count, 'part', trim_scale(rl.part_quantity)::text,
              'unitPrice', rl.unit_price::text, 'lineTotal', rl.line_total::text) ORDER BY rl.position)
            FROM order_revision_lines rl
            WHERE rl.revision_id = (SELECT r.id FROM order_revisions r WHERE r.order_id = ${o}.id AND r.status = 'confirmed' ORDER BY r.revision DESC LIMIT 1)
              AND rl.count > 0),
          (SELECT json_agg(json_build_object(${includeListingId ? "'listingId', l.listing_id, " : ""}'name', l.name, 'brand', l.brand, 'baseUnit', l.base_unit,
              'quantity', trim_scale(l.pack_quantity)::text, 'count', l.count, 'part', trim_scale(l.part_quantity)::text,
              'unitPrice', l.unit_price::text, 'lineTotal', l.line_total::text) ORDER BY l.position)
            FROM order_lines l WHERE l.order_id = ${o}.id)
        ) AS lines,
        COALESCE(
          (SELECT r.product_value::text FROM order_revisions r WHERE r.order_id = ${o}.id AND r.status = 'confirmed' ORDER BY r.revision DESC LIMIT 1),
          ${o}.product_value::text
        ) AS "productValue",
        ${o}.delivery_fee::text AS "deliveryFee",
        ${o}.small_cart_fee::text AS "smallCartFee",
        ${o}.pickup_fee::text AS "pickupFee",
        COALESCE(
          (SELECT r.total::text FROM order_revisions r WHERE r.order_id = ${o}.id AND r.status = 'confirmed' ORDER BY r.revision DESC LIMIT 1),
          ${o}.total::text
        ) AS total,
        CASE WHEN ${o}.status = 'rejected_by_shop' THEN (SELECT h.reason_code FROM order_status_history h
          WHERE h.order_id = ${o}.id AND h.to_status = 'rejected_by_shop' AND h.reason_code IN ('out_of_stock', 'too_busy', 'closing_soon', 'cannot_deliver')
          ORDER BY h.at DESC LIMIT 1) END AS "rejectReason",
        CASE WHEN ${o}.status = 'awaiting_customer_confirm' THEN (
          SELECT to_char(p.confirm_by_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          FROM order_revisions p WHERE p.order_id = ${o}.id AND p.status = 'proposed' ORDER BY p.revision DESC LIMIT 1
        ) END AS "confirmByAt",
        CASE WHEN ${o}.status = 'awaiting_customer_confirm' THEN (
          SELECT json_build_object(
            'id', p.id,
            'revision', p.revision,
            'sourceStatus', p.source_status,
            'createdAt', to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'confirmByAt', to_char(p.confirm_by_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'lines', (
              SELECT json_agg(json_build_object(
                'listingId', pl.listing_id,
                'name', pl.name,
                'brand', pl.brand,
                'baseUnit', pl.base_unit,
                'quantity', trim_scale(pl.pack_quantity)::text,
                'originalCount', pl.original_count,
                'count', pl.count,
                'originalPart', trim_scale(pl.original_part_quantity)::text,
                'part', trim_scale(pl.part_quantity)::text,
                'unitPrice', pl.unit_price::text,
                'originalLineTotal', (
                  CASE WHEN pl.original_part_quantity IS NOT NULL THEN pl.unit_price
                  ELSE round(pl.unit_price * pl.original_count, 2) END
                )::text,
                'lineTotal', pl.line_total::text,
                'changeReason', pl.change_reason
              ) ORDER BY pl.position)
              FROM order_revision_lines pl WHERE pl.revision_id = p.id
            ),
            'productValue', p.product_value::text,
            'shopDiscount', ${revisionDiscount("p")},
            'lostShopDiscount', CASE WHEN p.shop_discount = 0 AND p.shop_discount_rule_id IS NOT NULL AND COALESCE(
                (SELECT prev.shop_discount FROM order_revisions prev WHERE prev.order_id = ${o}.id AND prev.status = 'confirmed' AND prev.revision < p.revision
                 ORDER BY prev.revision DESC LIMIT 1), ${o}.shop_discount) > 0
              THEN (SELECT ${offerSql("v")} FROM shop_discount_versions v WHERE v.rule_id = p.shop_discount_rule_id AND v.version = p.shop_discount_rule_version) END,
            'deliveryFee', ${o}.delivery_fee::text,
            'smallCartFee', ${o}.small_cart_fee::text,
            'pickupFee', ${o}.pickup_fee::text,
            'total', p.total::text,
            'originalProductValue', COALESCE(
              (SELECT prev.product_value::text FROM order_revisions prev
               WHERE prev.order_id = ${o}.id AND prev.status = 'confirmed' AND prev.revision < p.revision
               ORDER BY prev.revision DESC LIMIT 1),
              ${o}.product_value::text
            ),
            'originalTotal', COALESCE(
              (SELECT prev.total::text FROM order_revisions prev
               WHERE prev.order_id = ${o}.id AND prev.status = 'confirmed' AND prev.revision < p.revision
               ORDER BY prev.revision DESC LIMIT 1),
              ${o}.total::text
            )
          )
          FROM order_revisions p WHERE p.order_id = ${o}.id AND p.status = 'proposed' ORDER BY p.revision DESC LIMIT 1
        ) END AS proposal,
        (SELECT json_build_object('status', c.status, 'askedAt', to_char(c.asked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
          FROM order_cancel_requests c WHERE c.order_id = ${o}.id) AS "cancelRequest"`;

/** The discount of one revision row `r` and the offer of the exact rule version it names (#572). */
const revisionDiscount = (r: string) => `CASE WHEN ${r}.shop_discount > 0
  THEN json_build_object('amount', ${r}.shop_discount::text, 'offer', (SELECT ${offerSql("v")} FROM shop_discount_versions v
    WHERE v.rule_id = ${r}.shop_discount_rule_id AND v.version = ${r}.shop_discount_rule_version)) END`;

/**
 * The discount in force on order `o` and the offer of the exact rule version that gave it (#571, #572): the latest confirmed revision's own,
 * else the one frozen at placement. A revision that lost its discount is null, never the placement one.
 */
const currentDiscount = (o: string) => `CASE
  WHEN EXISTS (SELECT 1 FROM order_revisions c WHERE c.order_id = ${o}.id AND c.status = 'confirmed')
  THEN (SELECT ${revisionDiscount("c")} FROM order_revisions c WHERE c.order_id = ${o}.id AND c.status = 'confirmed' ORDER BY c.revision DESC LIMIT 1)
  WHEN ${o}.shop_discount_rule_id IS NOT NULL AND ${o}.shop_discount > 0
  THEN json_build_object('amount', ${o}.shop_discount::text, 'offer', (SELECT ${offerSql("v")} FROM shop_discount_versions v
    WHERE v.rule_id = ${o}.shop_discount_rule_id AND v.version = ${o}.shop_discount_rule_version)) END`;

/** The shop as C18 and C19 show it, with the Owner's phone read now (ORD-8). */
const shopOf = (s: string) => `json_build_object('id', ${s}.id, 'name', ${s}.shop_name, 'phone', (SELECT a.phone FROM shop_members m
          JOIN accounts a ON a.id = m.account_id WHERE m.shop_id = ${s}.id AND m.role = 'owner' ORDER BY a.id LIMIT 1))`;

/**
 * Still placed at `now` but past its answer time: Accept, Reject and Cancel refuse from this moment, and S04 stops
 * listing it as New (owner's answer 4 on #426). The one place the 600 s cut-off is written in SQL.
 */
export const answerExpired = (o: string, now: string) =>
  `(${o}.status = 'placed' AND ${o}.status_changed_at + make_interval(secs => ${orderTiming.expireSeconds}) <= ${now}::timestamptz)`;

/** C09 and C19: one of the Customer's orders as it was frozen. */
async function orderView(client: Pool | PoolClient, orderId: string, accountId: string, now: Date, secret: string): Promise<OrderResponse | undefined> {
  const { rows: [row] } = await client.query<Omit<OrderResponse, "placedAt" | "itemsCheckedAt" | "handoverCode"> & { placedAt: Date; itemsCheckedAt: Date | null; statusChangedAt: Date; handoverCodeCiphertext: string | null }>(
    `SELECT o.id, o.number, o.status, o.placed_at AS "placedAt", o.status_changed_at AS "statusChangedAt", o.items_checked_at AS "itemsCheckedAt",
        o.handover_code_ciphertext AS "handoverCodeCiphertext", o.handover_code_attempts >= ${HANDOVER_CODE_MAX_ATTEMPTS} AS "handoverLocked", ${shopOf("s")} AS shop, ${frozenOrder("o")},
        ${currentDiscount("o")} AS "shopDiscount", ${answerExpired("o", "$3")} AS "answerExpired"
      FROM orders o JOIN shops s ON s.id = o.shop_id
      WHERE o.id = $1 AND o.account_id = $2`, [orderId, accountId, now]);
  if (!row) return undefined;
  // Existing active orders from before DLV-2's migration have no saved code. Create one atomically
  // on first arrival read so an in-flight delivery can still be completed after deployment.
  if (row.status === "arrived" && !row.handoverCodeCiphertext) {
    const generated = createHandoverCode(secret);
    const { rows: [saved] } = await client.query<{ ciphertext: string }>(
      `UPDATE orders SET handover_code_hash = $2, handover_code_salt = $3, handover_code_ciphertext = $4
       WHERE id = $1 AND status = 'arrived' AND handover_code_hash IS NULL RETURNING handover_code_ciphertext AS ciphertext`,
      [orderId, generated.hash, generated.salt, generated.ciphertext]);
    if (saved) row.handoverCodeCiphertext = saved.ciphertext;
    else {
      const { rows: [current] } = await client.query<{ ciphertext: string | null }>("SELECT handover_code_ciphertext AS ciphertext FROM orders WHERE id = $1", [orderId]);
      row.handoverCodeCiphertext = current?.ciphertext ?? null;
    }
  }
  // A pickup has no door check: the code is shown from Ready, for the Customer to give at the counter (FUL-7).
  const mayReveal = (row.status === "arrived" && (row.itemsCheckedAt !== null || now.getTime() >= row.statusChangedAt.getTime() + ITEMS_CHECK_SECONDS * 1000))
    || (row.fulfilment === "pickup" && row.status === "ready");
  const { statusChangedAt, handoverCodeCiphertext, ...response } = row;
  void statusChangedAt;
  return {
    ...response, placedAt: row.placedAt.toISOString(), itemsCheckedAt: row.itemsCheckedAt?.toISOString() ?? null,
    handoverCode: mayReveal && handoverCodeCiphertext ? revealHandoverCode(secret, handoverCodeCiphertext) : null,
  };
}

/** C18 shows this many past orders, with no paging yet (owner's answer 2 on #426). */
const PAST_SHOWN = 50;

export function registerOrderRoutes(app: FastifyInstance, { pool, clock, secret, shopDiscounts }: { pool: Pool; clock: Clock; secret: string; shopDiscounts: boolean }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const errors = { 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope };

  // C07 Place order (#424): an instant delivery to a saved address with a pin, paid at the door (MNY-1).
  app.post("/v1/carts/:shopId/order", { schema: { params: CartParams, body: PlaceOrderBody, response: { 201: OrderResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { shopId } = request.params as CartParams;
    const body = request.body as PlaceOrderBody;
    const { revision, total } = body;
    // A pickup names no address, only the place it is ordered from (FUL-7); a delivery names a saved address.
    const pickup = "fulfilment" in body ? body : undefined;
    const addressId = "addressId" in body ? body.addressId : undefined;
    type Address = { pincode: string; latitude: number; longitude: number };
    const addressSql = `SELECT pincode, ST_Y(point::geometry) AS latitude, ST_X(point::geometry) AS longitude
      FROM saved_addresses WHERE id = $1 AND account_id = $2 AND point IS NOT NULL`;
    // The address and the cart as they are now, or undefined when either is gone.
    const current = async () => {
      const { rows: [address] } = pickup ? { rows: [{ pincode: pickup.pincode, latitude: pickup.latitude, longitude: pickup.longitude }] } : await pool.query<Address>(addressSql, [addressId, who.accountId]);
      const cart = address && await savedCart(pool, who.accountId, shopId, false);
      return address && cart && { address, cart };
    };
    // Priced holding no connection, as a cart save prices: the quote reads in parallel, which one
    // transaction's connection can't. The shop must serve the address delivered to: its radius, both Areas, its hours (DSC-1).
    const quote = async ({ address, cart }: NonNullable<Awaited<ReturnType<typeof current>>>) => {
      const [serving] = await servingShops(pool, clock.now(), { pincode: address.pincode, latitude: address.latitude, longitude: address.longitude }, shopId);
      const version = await latestRateCardVersion(pool);
      return { version, ...await pricedCart(pool, who.accountId, shopId, serving, cart.revision, cart.lines, shopDiscounts) };
    };
    const first = await current();
    if (!first) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    const { address, cart: read } = first;
    const { version, view, priced, packs, pickupDetail } = await quote(first);
    if (view.reasons.some((reason) => reason.code === "OWN_SHOP")) return reply.code(403).send({ error: { code: "OWN_SHOP" } });
    // Something changed while placement waited on the locks: read the address and the cart again and answer with the cart as it is now.
    const changed = async () => {
      const now = await current();
      if (!now) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      return reply.code(409).send({ error: { code: "CART_CHANGED", cart: (await quote(now)).view } });
    };
    // A pickup is placeable on its own quote and can be priced while delivery is switched off.
    const ordering = pickup ? view.pickup?.placeable === true && view.pickup.total === total : view.placeable && view.quote?.total === total;
    if (read.revision !== revision || !priced || !ordering) {
      return reply.code(409).send({ error: { code: "CART_CHANGED", cart: view } });
    }

    const placed = await withTransaction(pool, async (client) => {
      // Under these locks nothing priced above can change until the order is in: the address, the cart, and each
      // listing's price and stock (a price edit waits on FOR SHARE). Each is read again, one query at a time.
      const { rows: [locked] } = pickup ? { rows: [address] } : await client.query<Address>(`${addressSql} FOR SHARE`, [addressId, who.accountId]);
      const cart = await savedCart(client, who.accountId, shopId, true);
      await client.query("SELECT 1 FROM shop_listings WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE", [read.lines.map((line) => line.listingId)]);
      if (JSON.stringify(locked) !== JSON.stringify(address) || cart?.revision !== read.revision
        || JSON.stringify(await packsOf(client, shopId, read.lines)) !== JSON.stringify(packs)
        || await latestRateCardVersion(client) !== version) return "CHANGED";
      // A discount the quote took off still stands: the rule is still active at that version, or an Owner's save or a lower maximum came in between (MNY-6).
      if (priced.shopDiscount) {
        const { rows: [rule] } = await client.query<{ status: string; version: number }>("SELECT status, version FROM shop_discounts WHERE id = $1 FOR SHARE", [priced.shopDiscount.ruleId]);
        if (rule?.status !== "active" || rule.version !== priced.shopDiscount.ruleVersion) return "CHANGED";
      }
      // Read after the locks, so a wait on them doesn't stamp an earlier time.
      const now = clock.now();

      const discount = [priced.shopDiscount?.amount ?? "0", priced.shopDiscount?.ruleId ?? null, priced.shopDiscount?.ruleVersion ?? null];
      const { rows: [order] } = pickup && pickupDetail
        // A pickup: no address, no delivery fee, no commission (MNY-2). Its quote keeps the booking fees and the contribution they make (MNY-4).
        ? await client.query<{ id: string }>(
          `INSERT INTO orders (account_id, shop_id, status, placed_at, status_changed_at, shop_name, shop_address, shop_pincode, shop_gstin,
             fulfilment, product_value, delivery_fee, small_cart_fee, pickup_fee, total, rate_card_version, quote, shop_discount, shop_discount_rule_id, shop_discount_rule_version)
           SELECT $1, $2, 'placed', $3, $3, shop.shop_name, shop.address, shop.pincode, shop.gstin, 'pickup', $4, 0, NULL, $5, $6, $7, $8, $9, $10, $11
           FROM shops shop WHERE shop.id = $2 RETURNING id`,
          [who.accountId, shopId, now, priced.productValue, pickupDetail.pickupFee, pickupDetail.total, priced.rateCardVersion, JSON.stringify(pickupDetail.quote), ...discount])
        : await client.query<{ id: string }>(
          `INSERT INTO orders (account_id, shop_id, status, placed_at, status_changed_at, shop_name, shop_address, shop_pincode, shop_gstin,
             address_label, address_flat, address_area_line, address_pincode, address_point, product_value, delivery_fee, small_cart_fee, total, rate_card_version, quote,
             shop_discount, shop_discount_rule_id, shop_discount_rule_version)
           SELECT $1, $2, 'placed', $3, $3, shop.shop_name, shop.address, shop.pincode, shop.gstin,
             a.label, a.flat, a.area_line, a.pincode, a.point, $5, $6, $7, $8, $9, $10, $11, $12, $13
           FROM saved_addresses a, shops shop WHERE a.id = $4 AND shop.id = $2 RETURNING id`,
          [who.accountId, shopId, now, addressId, priced.productValue, priced.deliveryFee.amount, priced.smallCartFee?.amount ?? null,
            priced.customerTotal, priced.rateCardVersion, JSON.stringify(priced), ...discount]);
      if (!order) throw new Error("A locked address disappeared");
      // Each line takes from stock in the listing's own unit: count × pack size, or the part bought (#377).
      await client.query(
        `INSERT INTO order_lines (order_id, position, listing_id, name, brand, base_unit, pack_quantity, count, part_quantity, unit_price, line_total, shop_discount, stock_quantity)
         SELECT $1, entry.position, (line->>'listingId')::uuid, line->>'name', line->>'brand', line->>'baseUnit', (line->>'quantity')::numeric,
           (line->>'count')::int, (line->'part'->>'quantity')::numeric, COALESCE(line->'part'->>'price', line->>'price')::numeric, (line->>'lineTotal')::numeric, ($3::numeric[])[entry.position],
           COALESCE((line->'part'->>'quantity')::numeric, (line->>'count')::int * (line->>'quantity')::numeric)
         FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS entry(line, position)`,
        [order.id, JSON.stringify(view.lines), priced.lines.map((line) => line.shopDiscount)]);
      await recordStatus(client, order.id, null, "placed", { id: who.accountId, role: "customer" }, now);
      await client.query("DELETE FROM cart_lines WHERE cart_id = $1", [read.id]);
      await client.query("UPDATE carts SET revision = revision + 1, updated_at = $2 WHERE id = $1", [read.id, now]);
      await client.query("COMMIT");
      return { id: order.id };
    });
    if (placed === "CHANGED") return changed();
    return reply.code(201).send(await orderView(pool, placed.id, who.accountId, clock.now(), secret));
  });

  // C18 (#426): the Customer's own orders, active ones first.
  app.get("/v1/orders", { schema: { response: { 200: OrdersResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    type Row = Omit<OrderSummary, "placedAt"> & { placedAt: Date; ended: boolean };
    // One statement at one `now`, so an order changing meanwhile can't land in both groups or neither.
    const { rows } = await pool.query<Row>(
      `SELECT * FROM (
          SELECT *, row_number() OVER (PARTITION BY ended ORDER BY "placedAt" DESC, number DESC) AS rank FROM (
            SELECT o.id, o.number, o.status, o.placed_at AS "placedAt", ${shopOf("s")} AS shop,
              COALESCE(
                (SELECT r.total::text FROM order_revisions r WHERE r.order_id = o.id AND r.status = 'confirmed' ORDER BY r.revision DESC LIMIT 1),
                o.total::text
              ) AS total,
              ${answerExpired("o", "$3")} AS "answerExpired", (o.status = ANY($2::text[]) OR ${answerExpired("o", "$3")}) AS ended,
              CASE WHEN o.status = 'awaiting_customer_confirm' THEN (
                SELECT to_char(p.confirm_by_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                FROM order_revisions p WHERE p.order_id = o.id AND p.status = 'proposed' ORDER BY p.revision DESC LIMIT 1
              ) END AS "confirmByAt",
              CASE WHEN o.status = 'awaiting_customer_confirm' THEN (
                SELECT p.total::text FROM order_revisions p WHERE p.order_id = o.id AND p.status = 'proposed' ORDER BY p.revision DESC LIMIT 1
              ) END AS "proposedTotal"
            FROM orders o JOIN shops s ON s.id = o.shop_id WHERE o.account_id = $1) AS mine) AS ranked
        WHERE NOT ended OR rank <= ${PAST_SHOWN}
        ORDER BY ended, status IN ('awaiting_customer_confirm', 'arrived') DESC, "placedAt" DESC, number DESC`,
      [who.accountId, TERMINAL_ORDER_STATUSES, clock.now()]);
    const summary = ({ id, number, status, placedAt, shop, total, answerExpired: late, confirmByAt, proposedTotal }: Row): OrderSummary =>
      ({ id, number, status, placedAt: placedAt.toISOString(), shop, total, answerExpired: late, confirmByAt: confirmByAt ?? null, proposedTotal: proposedTotal ?? null });
    return { active: rows.filter((row) => !row.ended).map(summary), past: rows.filter((row) => row.ended).map(summary) };
  });

  app.get("/v1/orders/:id", { schema: { params: OrderParams, response: { 200: OrderResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const order = await orderView(pool, (request.params as OrderParams).id, who.accountId, clock.now(), secret);
    return order ?? reply.code(404).send({ error: { code: "NOT_FOUND" } });
  });

  // #61: the receipt of a finished sale. Every figure and the shop's identity are the ones frozen at placement (#537); lines, discount and total are the confirmed revision's when there is one (#572).
  app.get("/v1/orders/:id/receipt", { schema: { params: OrderParams, response: { 200: ReceiptResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { rows: [row] } = await pool.query<Omit<ReceiptResponse, "placedAt" | "status"> & { placedAt: Date; status: OrderStatus }>(
      `SELECT o.number, o.status, o.placed_at AS "placedAt", json_build_object('name', o.shop_name, 'address', o.shop_address, 'pincode', o.shop_pincode, 'gstin', o.shop_gstin) AS shop,
          CASE WHEN o.fulfilment = 'delivery' THEN json_build_object('label', o.address_label, 'areaLine', o.address_area_line) END AS address,
          COALESCE(
            (SELECT json_agg(json_build_object('name', l.name, 'brand', l.brand, 'baseUnit', l.base_unit, 'quantity', trim_scale(l.pack_quantity)::text,
                'count', l.count, 'part', trim_scale(l.part_quantity)::text, 'unitPrice', l.unit_price::text, 'lineTotal', l.line_total::text) ORDER BY l.position)
              FROM order_revision_lines l WHERE l.revision_id = rev.id AND l.count > 0),
            (SELECT json_agg(json_build_object('name', l.name, 'brand', l.brand, 'baseUnit', l.base_unit, 'quantity', trim_scale(l.pack_quantity)::text,
                'count', l.count, 'part', trim_scale(l.part_quantity)::text, 'unitPrice', l.unit_price::text, 'lineTotal', l.line_total::text) ORDER BY l.position)
              FROM order_lines l WHERE l.order_id = o.id)) AS lines,
          COALESCE(rev.product_value, o.product_value)::text AS "productValue", ${currentDiscount("o")} AS "shopDiscount", o.delivery_fee::text AS "deliveryFee",
          o.small_cart_fee::text AS "smallCartFee", o.pickup_fee::text AS "pickupFee", COALESCE(rev.total, o.total)::text AS total, o.delivery_payment AS payment
        FROM orders o
        LEFT JOIN LATERAL (SELECT r.id, r.product_value, r.total FROM order_revisions r WHERE r.order_id = o.id AND r.status = 'confirmed' ORDER BY r.revision DESC LIMIT 1) rev ON true
        WHERE o.id = $1 AND o.account_id = $2`, [(request.params as OrderParams).id, who.accountId]);
    if (!row) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    if (row.status !== "delivered" && row.status !== "picked_up") return reply.code(409).send({ error: { code: "ORDER_STATUS_CHANGED" } });
    return { ...row, status: row.status, placedAt: row.placedAt.toISOString() };
  });

  app.post("/v1/orders/:id/items-ok", { schema: { params: OrderParams, response: { 200: OrderResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as OrderParams;
    const result = await withTransaction(pool, async (client) => {
      const { rows: [order] } = await client.query<{ status: OrderStatus }>(
        "SELECT status FROM orders WHERE id = $1 AND account_id = $2 FOR UPDATE", [id, who.accountId]);
      if (!order) return "NOT_FOUND" as const;
      if (order.status !== "arrived") return "ORDER_STATUS_CHANGED" as const;
      await client.query("UPDATE orders SET items_checked_at = COALESCE(items_checked_at, $2) WHERE id = $1", [id, clock.now()]);
      await client.query("COMMIT");
      return "OK" as const;
    });
    if (result !== "OK") return reply.code(result === "NOT_FOUND" ? 404 : 409).send({ error: { code: result } });
    return orderView(pool, id, who.accountId, clock.now(), secret);
  });

  // A Customer who has checked the items, or whose pickup is Ready, may rotate a permanently locked code (#597). The shop can't: only the Customer's own new code opens it.
  app.post("/v1/orders/:id/handover-code/recover", { schema: { params: OrderParams, response: { 200: OrderResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as OrderParams;
    const result = await withTransaction(pool, async (client) => {
      const { rows: [order] } = await client.query<{ status: OrderStatus; fulfilment: string; itemsCheckedAt: Date | null; attempts: number }>(
        `SELECT status, fulfilment, items_checked_at AS "itemsCheckedAt", handover_code_attempts AS attempts
         FROM orders WHERE id = $1 AND account_id = $2 FOR UPDATE`, [id, who.accountId]);
      if (!order) return "NOT_FOUND" as const;
      const recoverable = order.fulfilment === "pickup" ? order.status === "ready" : order.status === "arrived" && order.itemsCheckedAt !== null;
      if (!recoverable || order.attempts < HANDOVER_CODE_MAX_ATTEMPTS) return "HANDOVER_CODE_LOCKED" as const;
      const generated = createHandoverCode(secret);
      await client.query(`UPDATE orders SET handover_code_hash = $2, handover_code_salt = $3, handover_code_ciphertext = $4,
        handover_code_attempts = 0, handover_code_blocked_until = NULL WHERE id = $1`, [id, generated.hash, generated.salt, generated.ciphertext]);
      await client.query("COMMIT");
      return "OK" as const;
    });
    if (result === "NOT_FOUND") return reply.code(404).send({ error: { code: result } });
    if (result === "HANDOVER_CODE_LOCKED") return reply.code(409).send({ error: { code: result } });
    return orderView(pool, id, who.accountId, clock.now(), secret);
  });

  // Cancel on C09/C19: free and with no reason while the shop hasn't answered (ORD-5),
  // or decline the proposal during awaiting_customer_confirm (#64).
  app.post("/v1/orders/:id/cancel", { schema: { params: OrderParams, response: { 200: OrderResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as OrderParams;
    const moved = await withTransaction(pool, async (client) => {
      const { rows: [order] } = await client.query<{ id: string; status: OrderStatus }>(
        "SELECT id, status FROM orders WHERE id = $1 AND account_id = $2 FOR UPDATE", [id, who.accountId]);
      if (!order) return "NOT_FOUND";
      const now = clock.now();
      const { rows: [late] } = await client.query<{ late: boolean }>(`SELECT ${answerExpired("orders", "$2")} AS late FROM orders WHERE id = $1`, [id, now]);
      if (late?.late) return "ORDER_EXPIRED";

      let reasonCode: string | null = null;
      if (order.status === "awaiting_customer_confirm") {
        const { rows: [proposal] } = await client.query<{ id: string; confirmByAt: Date }>(
          `SELECT id, confirm_by_at AS "confirmByAt"
           FROM order_revisions WHERE order_id = $1 AND status = 'proposed' FOR UPDATE`, [id]);
        if (!proposal) return "ORDER_STATUS_CHANGED";
        if (now.getTime() >= proposal.confirmByAt.getTime()) return "CONFIRMATION_EXPIRED";
        await client.query("UPDATE order_revisions SET status = 'declined' WHERE id = $1", [proposal.id]);
        reasonCode = "declined_total";
      }

      if (!await moveOrder(client, order, "cancelled_by_customer", { id: who.accountId, role: "customer" }, now, reasonCode)) return "ORDER_STATUS_CHANGED";
      await client.query("COMMIT");
      return "MOVED";
    });
    if (moved !== "MOVED") return reply.code(moved === "NOT_FOUND" ? 404 : 409).send({ error: { code: moved } });
    return orderView(pool, id, who.accountId, clock.now(), secret);
  });

  // C19 Ask to cancel: once the shop has accepted, the Customer asks and the shop answers (ORD-5, #59). One ask per order.
  app.post("/v1/orders/:id/cancel-request", { schema: { params: OrderParams, response: { 200: OrderResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as OrderParams;
    const result = await withTransaction(pool, async (client) => {
      const { rows: [order] } = await client.query<{ status: OrderStatus }>("SELECT status FROM orders WHERE id = $1 AND account_id = $2 FOR UPDATE", [id, who.accountId]);
      if (!order) return "NOT_FOUND";
      const { rows: [asked] } = await client.query<{ status: string }>("SELECT status FROM order_cancel_requests WHERE order_id = $1", [id]);
      // A retry of the ask that is still waiting answers the same, with no second row and no second notification.
      if (asked) return asked.status === "asked" ? "OK" : "CANCEL_REQUEST_CLOSED";
      if (order.status !== "accepted" && order.status !== "preparing") return "ORDER_STATUS_CHANGED";
      const now = clock.now();
      await client.query("INSERT INTO order_cancel_requests (order_id, status, asked_at) VALUES ($1, 'asked', $2)", [id, now]);
      await queueNotification(client, id, cancelRules.asked, now);
      await client.query("COMMIT");
      return "OK";
    });
    if (result !== "OK") return reply.code(result === "NOT_FOUND" ? 404 : 409).send({ error: { code: result } });
    return orderView(pool, id, who.accountId, clock.now(), secret);
  });

  // C10 Customer confirms partial acceptance proposal (#64).
  app.post("/v1/orders/:id/confirm-total", { schema: { params: OrderParams, response: { 200: OrderResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as OrderParams;
    const result = await withTransaction(pool, async (client) => {
      const { rows: [order] } = await client.query<{ id: string; status: OrderStatus }>(
        "SELECT id, status FROM orders WHERE id = $1 AND account_id = $2 FOR UPDATE", [id, who.accountId]);
      if (!order) return "NOT_FOUND";
      if (order.status !== "awaiting_customer_confirm") return "ORDER_STATUS_CHANGED";
      const { rows: [proposal] } = await client.query<{ id: string; sourceStatus: OrderStatus; confirmByAt: Date }>(
        `SELECT id, source_status AS "sourceStatus", confirm_by_at AS "confirmByAt"
         FROM order_revisions WHERE order_id = $1 AND status = 'proposed' FOR UPDATE`, [id]);
      if (!proposal) return "ORDER_STATUS_CHANGED";
      const now = clock.now();
      if (now.getTime() >= proposal.confirmByAt.getTime()) return "CONFIRMATION_EXPIRED";
      await client.query("UPDATE order_revisions SET status = 'confirmed', confirmed_at = $2 WHERE id = $1", [proposal.id, now]);
      if (!await moveOrder(client, order, proposal.sourceStatus, { id: who.accountId, role: "customer" }, now)) {
        return "ORDER_STATUS_CHANGED";
      }
      await client.query("COMMIT");
      return "OK";
    });
    if (result !== "OK") return reply.code(result === "NOT_FOUND" ? 404 : 409).send({ error: { code: result } });
    return orderView(pool, id, who.accountId, clock.now(), secret);
  });

  // C10 Customer declines partial acceptance proposal (#64).
  app.post("/v1/orders/:id/decline-total", { schema: { params: OrderParams, response: { 200: OrderResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as OrderParams;
    const result = await withTransaction(pool, async (client) => {
      const { rows: [order] } = await client.query<{ id: string; status: OrderStatus }>(
        "SELECT id, status FROM orders WHERE id = $1 AND account_id = $2 FOR UPDATE", [id, who.accountId]);
      if (!order) return "NOT_FOUND";
      if (order.status !== "awaiting_customer_confirm") return "ORDER_STATUS_CHANGED";
      const { rows: [proposal] } = await client.query<{ id: string; confirmByAt: Date }>(
        `SELECT id, confirm_by_at AS "confirmByAt"
         FROM order_revisions WHERE order_id = $1 AND status = 'proposed' FOR UPDATE`, [id]);
      if (!proposal) return "ORDER_STATUS_CHANGED";
      const now = clock.now();
      if (now.getTime() >= proposal.confirmByAt.getTime()) return "CONFIRMATION_EXPIRED";
      await client.query("UPDATE order_revisions SET status = 'declined' WHERE id = $1", [proposal.id]);
      if (!await moveOrder(client, order, "cancelled_by_customer", { id: who.accountId, role: "customer" }, now, "declined_total")) {
        return "ORDER_STATUS_CHANGED";
      }
      await client.query("COMMIT");
      return "OK";
    });
    if (result !== "OK") return reply.code(result === "NOT_FOUND" ? 404 : 409).send({ error: { code: result } });
    return orderView(pool, id, who.accountId, clock.now(), secret);
  });
}
