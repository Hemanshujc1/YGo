import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { CartParams, ErrorEnvelope, OrderParams, OrderResponse, type OrderStatus, PlaceOrderBody } from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { withTransaction } from "../db";
import { moveOrder, recordStatus } from "../orders";
import { deriveKeys, mobileSignedIn } from "../tokens";
import { pricedCart, savedCart } from "./cart";
import { servingShops } from "./feed";

/** C09 and C19: one of the Customer's orders as it was frozen, with the Owner's phone read now (ORD-8). */
async function orderView(client: Pool | PoolClient, orderId: string, accountId: string): Promise<OrderResponse | undefined> {
  const { rows: [row] } = await client.query<Omit<OrderResponse, "placedAt"> & { placedAt: Date }>(
    `SELECT o.id, o.number, o.status, o.placed_at AS "placedAt",
        json_build_object('id', s.id, 'name', s.shop_name, 'phone', (SELECT a.phone FROM shop_members m JOIN accounts a ON a.id = m.account_id
          WHERE m.shop_id = s.id AND m.role = 'owner' ORDER BY a.id LIMIT 1)) AS shop,
        json_build_object('label', o.address_label, 'flat', o.address_flat, 'areaLine', o.address_area_line, 'pincode', o.address_pincode) AS address,
        (SELECT json_agg(json_build_object('name', l.name, 'brand', l.brand, 'baseUnit', l.base_unit, 'quantity', trim_scale(l.pack_quantity)::text,
            'count', l.count, 'part', trim_scale(l.part_quantity)::text, 'unitPrice', l.unit_price::text, 'lineTotal', l.line_total::text) ORDER BY l.position)
          FROM order_lines l WHERE l.order_id = o.id) AS lines,
        o.product_value::text AS "productValue", o.delivery_fee::text AS "deliveryFee", o.small_cart_fee::text AS "smallCartFee", o.total::text AS total
      FROM orders o JOIN shops s ON s.id = o.shop_id
      WHERE o.id = $1 AND o.account_id = $2`, [orderId, accountId]);
  return row && { ...row, placedAt: row.placedAt.toISOString() };
}

export function registerOrderRoutes(app: FastifyInstance, { pool, clock, secret }: { pool: Pool; clock: Clock; secret: string }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const errors = { 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope };

  // C07 Place order (#424): an instant delivery to a saved address with a pin, paid at the door (MNY-1).
  app.post("/v1/carts/:shopId/order", { schema: { params: CartParams, body: PlaceOrderBody, response: { 201: OrderResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { shopId } = request.params as CartParams;
    const { revision, total, addressId } = request.body as PlaceOrderBody;
    if ((await pool.query("SELECT 1 FROM shop_members WHERE account_id = $1 AND shop_id = $2", [who.accountId, shopId])).rowCount) {
      return reply.code(403).send({ error: { code: "OWN_SHOP" } });
    }
    const now = clock.now();
    const placed = await withTransaction(pool, async (client) => {
      // The address can't be edited, nor the cart saved, until the order is in.
      const { rows: [address] } = await client.query<{ pincode: string; latitude: number; longitude: number }>(
        `SELECT pincode, ST_Y(point::geometry) AS latitude, ST_X(point::geometry) AS longitude
         FROM saved_addresses WHERE id = $1 AND account_id = $2 AND point IS NOT NULL FOR SHARE`, [addressId, who.accountId]);
      const cart = address && await savedCart(client, who.accountId, shopId, true);
      if (!address || !cart) return "NOT_FOUND";
      // A price edit waits for these locks, so the prices quoted below are the ones frozen.
      await client.query("SELECT 1 FROM shop_listings WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE", [cart.lines.map((line) => line.listingId)]);
      // The shop must serve the address delivered to: its radius, both Areas, its hours (DSC-1).
      const [serving] = await servingShops(pool, now, { pincode: address.pincode, latitude: address.latitude, longitude: address.longitude }, shopId);
      // Read outside the transaction, as a cart save prices: the quote reads in parallel. The locks above keep it current.
      const { view, priced } = await pricedCart(pool, who.accountId, shopId, serving, cart.revision, cart.lines);
      if (cart.revision !== revision || !view.placeable || !priced || view.quote?.total !== total) return { changed: view };

      const { rows: [order] } = await client.query<{ id: string }>(
        `INSERT INTO orders (account_id, shop_id, status, placed_at, status_changed_at, address_label, address_flat, address_area_line,
           address_pincode, address_point, product_value, delivery_fee, small_cart_fee, total, rate_card_version, quote)
         SELECT $1, $2, 'placed', $3, $3, label, flat, area_line, pincode, point, $5, $6, $7, $8, $9, $10
         FROM saved_addresses WHERE id = $4 RETURNING id`,
        [who.accountId, shopId, now, addressId, priced.productValue, priced.deliveryFee.amount, priced.smallCartFee?.amount ?? null,
          priced.customerTotal, priced.rateCardVersion, JSON.stringify(priced)]);
      if (!order) throw new Error("A locked address disappeared");
      // Each line takes from stock in the listing's own unit: count × pack size, or the part bought (#377).
      await client.query(
        `INSERT INTO order_lines (order_id, position, listing_id, name, brand, base_unit, pack_quantity, count, part_quantity, unit_price, line_total, stock_quantity)
         SELECT $1, entry.position, (line->>'listingId')::uuid, line->>'name', line->>'brand', line->>'baseUnit', (line->>'quantity')::numeric,
           (line->>'count')::int, (line->'part'->>'quantity')::numeric, COALESCE(line->'part'->>'price', line->>'price')::numeric, (line->>'lineTotal')::numeric,
           COALESCE((line->'part'->>'quantity')::numeric, (line->>'count')::int * (line->>'quantity')::numeric)
         FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS entry(line, position)`, [order.id, JSON.stringify(view.lines)]);
      await recordStatus(client, order.id, null, "placed", { id: who.accountId, role: "customer" }, now);
      await client.query("DELETE FROM cart_lines WHERE cart_id = $1", [cart.id]);
      await client.query("UPDATE carts SET revision = revision + 1, updated_at = $2 WHERE id = $1", [cart.id, now]);
      await client.query("COMMIT");
      return { id: order.id };
    });
    if (placed === "NOT_FOUND") return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    if ("changed" in placed) return reply.code(409).send({ error: { code: "CART_CHANGED", cart: placed.changed } });
    return reply.code(201).send(await orderView(pool, placed.id, who.accountId));
  });

  app.get("/v1/orders/:id", { schema: { params: OrderParams, response: { 200: OrderResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const order = await orderView(pool, (request.params as OrderParams).id, who.accountId);
    return order ?? reply.code(404).send({ error: { code: "NOT_FOUND" } });
  });

  // Cancel on C09/C19: free and with no reason while the shop hasn't answered (ORD-5).
  app.post("/v1/orders/:id/cancel", { schema: { params: OrderParams, response: { 200: OrderResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as OrderParams;
    const moved = await withTransaction(pool, async (client) => {
      const { rows: [order] } = await client.query<{ id: string; status: OrderStatus }>(
        "SELECT id, status FROM orders WHERE id = $1 AND account_id = $2 FOR UPDATE", [id, who.accountId]);
      if (!order) return "NOT_FOUND";
      if (!await moveOrder(client, order, "cancelled_by_customer", { id: who.accountId, role: "customer" }, clock.now())) return "ORDER_STATUS_CHANGED";
      await client.query("COMMIT");
      return "MOVED";
    });
    if (moved !== "MOVED") return reply.code(moved === "NOT_FOUND" ? 404 : 409).send({ error: { code: moved } });
    return orderView(pool, id, who.accountId);
  });
}
