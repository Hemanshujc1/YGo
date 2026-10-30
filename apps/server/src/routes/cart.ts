import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { CartParams, CartResponse, type CartLine, type CartReason, type DeliveredQuote, ErrorEnvelope, FeedQuery, type PartPack, SaveCartBody } from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { withTransaction } from "../db";
import { partOf, stockOf, visibleListings } from "../listings";
import { deriveKeys, mobileSignedIn } from "../tokens";
import { servingShops, type ServingShop } from "./feed";
import { deliveredQuote, latestRateCardVersion } from "./price-simulator";

type Line = { listingId: string; count: number };
export type Pack = Pick<CartLine, "listingId" | "name" | "brand" | "baseUnit" | "quantity" | "price"> & {
  categoryId: string; onSale: boolean; packsLeft: number; part: PartPack | null;
};

/** How many of a pack the cart may hold now: a part, set only when no whole pack is left, is one line of count 1 (#377). */
const leftOf = (pack: Pack) => pack.part ? 1 : pack.packsLeft;

/** Each line's pack as it is now, or undefined for one this shop doesn't list; prices and stock are read, never sent. */
export async function packsOf(client: Pool | PoolClient, shopId: string, lines: Line[]): Promise<Array<Pack | undefined>> {
  const { rows } = await client.query<Pack & { position: number }>(
    `SELECT entry.position::int AS position, l.id AS "listingId", product.name, product.brand, product.base_unit AS "baseUnit",
        trim_scale(pack.quantity)::text AS quantity, l.online_price::text AS price, product.category_id AS "categoryId",
        EXISTS (SELECT 1 FROM ${visibleListings} AND listing.id = l.id) AS "onSale",
        -- Capped at 1000, one above the largest count, so a count of 999 is never shown as the last packs left.
        CASE WHEN l.out_of_stock THEN 0 ELSE LEAST(GREATEST(floor(${stockOf("l")} / pack.quantity), 0), 1000)::int END AS "packsLeft", ${partOf("l")} AS part
      FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS entry(line, position)
      JOIN shop_listings l ON l.id = (entry.line->>'listingId')::uuid AND l.shop_id = $1
      JOIN packs pack ON pack.id = l.pack_id
      JOIN master_products product ON product.id = pack.product_id`, [shopId, JSON.stringify(lines)]);
  return lines.map((_, index) => rows.find((row) => row.position === index + 1));
}

export async function savedCart(client: Pool | PoolClient, accountId: string, shopId: string, lock: boolean) {
  // A save holds the cart's lock while it writes, so once locked the read below can't land halfway through one.
  if (lock) await client.query("SELECT 1 FROM carts WHERE account_id = $1 AND shop_id = $2 FOR UPDATE", [accountId, shopId]);
  // One statement, so the revision and its lines come from one snapshot even unlocked.
  const { rows: [cart] } = await client.query<{ id: string; revision: number; lines: Line[] }>(
    `SELECT id, revision, (SELECT COALESCE(json_agg(json_build_object('listingId', l.listing_id, 'count', l.count) ORDER BY l.position), '[]')
       FROM cart_lines l WHERE l.cart_id = c.id) AS lines
     FROM carts c WHERE account_id = $1 AND shop_id = $2`, [accountId, shopId]);
  return cart;
}

/**
 * The cart as C07 shows it: every figure from the pricing engine, and each reason it can't be ordered (CRT-2, CRT-4).
 * Placing an order (#424) also keeps the engine's whole result and each line's pack.
 */
export async function pricedCart(
  client: Pool, accountId: string, shopId: string, serving: ServingShop | undefined, revision: number, saved: Line[], read?: Array<Pack | undefined>,
): Promise<{ view: CartResponse; priced: Extract<DeliveredQuote, { status: "priced" }> | null; packs: Array<Pack | undefined> }> {
  // ACC-9: an Owner or Staff member can't order from their own shop. Read alongside the packs.
  const [member, packs] = await Promise.all([
    client.query("SELECT 1 FROM shop_members WHERE account_id = $1 AND shop_id = $2", [accountId, shopId]), read ?? packsOf(client, shopId, saved)]);
  const lines: CartLine[] = saved.map((line, index) => {
    const pack = packs[index];
    if (!pack) throw new Error("A saved cart line lost its listing");
    const left = leftOf(pack);
    const shown = { listingId: pack.listingId, name: pack.name, brand: pack.brand, baseUnit: pack.baseUnit, quantity: pack.quantity, price: pack.price };
    if (!pack.onSale) return { ...shown, count: line.count, state: "unavailable", part: null, left: null, lineTotal: null };
    if (left === 0) return { ...shown, count: line.count, state: "outOfStock", part: null, left: null, lineTotal: null };
    // The line follows stock: a part while less than a pack is left, a whole pack at the pack's price after a restock (owner's answer 6 on #377).
    const count = Math.min(line.count, left);
    return { ...shown, count, state: "orderable", part: pack.part, left: count === left ? left : null, lineTotal: null };
  });
  const orderable = lines.flatMap((line, index) => line.state === "orderable" ? [{ line, categoryId: packs[index]?.categoryId ?? "" }] : []);

  let delivering = Boolean(serving);
  let quote: CartResponse["quote"] = null;
  let engine: Extract<DeliveredQuote, { status: "priced" }> | null = null;
  const priceReasons: CartReason[] = [];
  if (serving && orderable.length) {
    const priced = await deliveredQuote(client, shopId, orderable.map(({ line, categoryId }) => ({
      listingId: line.listingId, quantityOptionId: null, categoryId, unitPrice: line.part?.price ?? line.price, count: line.count,
    })), await latestRateCardVersion(client));
    // The feed already leaves out a shop whose card is incomplete; this is a card changing in between.
    if (priced.status === "incomplete") delivering = false;
    else {
      engine = priced;
      orderable.forEach(({ line }, index) => { line.lineTotal = priced.lines[index]?.lineTotal ?? null; });
      quote = { productValue: priced.productValue, deliveryFee: priced.deliveryFee.amount, smallCartFee: priced.smallCartFee?.amount ?? null, total: priced.customerTotal };
      // The floor's shortfall is the platform's earnings, which the Customer never sees (owner's clarification 2 on #50).
      for (const reason of priced.reasons) priceReasons.push(reason.code === "BELOW_MINIMUM_CART" ? reason : { code: "BELOW_CONTRIBUTION_FLOOR" });
    }
  }
  const reasons: CartReason[] = [];
  if (member.rowCount) reasons.push({ code: "OWN_SHOP" });
  if (!delivering) reasons.push({ code: "NOT_DELIVERING" });
  else if (serving && !serving.open) reasons.push({ code: "SHOP_CLOSED", opensAt: serving.opensAt });
  if (orderable.length < lines.length) reasons.push({ code: "LINE_UNAVAILABLE" });
  if (delivering) reasons.push(...priceReasons);
  else quote = null;

  const name = serving?.name ?? (await client.query<{ name: string }>("SELECT shop_name AS name FROM shops WHERE id = $1", [shopId])).rows[0]?.name ?? "";
  return { view: { shop: { id: shopId, name }, revision, lines, quote, placeable: quote !== null && reasons.length === 0, reasons }, priced: engine, packs };
}

const cartView = async (...args: Parameters<typeof pricedCart>) => (await pricedCart(...args)).view;

export function registerCartRoutes(app: FastifyInstance, { pool, clock, secret }: { pool: Pool; clock: Clock; secret: string }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const errors = { 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope };

  // C07 (#405): the Customer's cart at one shop, priced for this place. 404 when there is no cart and the shop can't deliver here.
  app.get("/v1/carts/:shopId", { schema: { params: CartParams, querystring: FeedQuery, response: { 200: CartResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { shopId } = request.params as CartParams;
    const [[serving], cart] = await Promise.all([
      servingShops(pool, clock.now(), request.query as FeedQuery, shopId), savedCart(pool, who.accountId, shopId, false)]);
    if (!serving && !cart) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    return cartView(pool, who.accountId, shopId, serving, cart?.revision ?? 0, cart?.lines ?? []);
  });

  // Saves the whole cart and answers with its new quote (CRT-2). Saves of one cart run one at a time,
  // and one based on an older revision is refused, so an older request never overwrites a newer one.
  app.put("/v1/carts/:shopId", { schema: { params: CartParams, querystring: FeedQuery, body: SaveCartBody, response: { 200: CartResponse, ...errors, 409: ErrorEnvelope } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { shopId } = request.params as CartParams;
    const { revision, lines } = request.body as SaveCartBody;
    const [serving] = await servingShops(pool, clock.now(), request.query as FeedQuery, shopId);
    const saved = await withTransaction(pool, async (client) => {
      // Only a shop that can deliver here starts a cart; one already started can still be emptied.
      if (serving) {
        await client.query("INSERT INTO carts (account_id, shop_id, updated_at) VALUES ($1, $2, $3) ON CONFLICT (account_id, shop_id) DO NOTHING",
          [who.accountId, shopId, clock.now()]);
      }
      const cart = await savedCart(client, who.accountId, shopId, true);
      if (!cart) return "NOT_FOUND";
      if (cart.revision !== revision) return "CART_CHANGED";
      const packs = await packsOf(client, shopId, lines);
      const had = new Set(cart.lines.map((line) => line.listingId));
      // Every line is a pack of this shop; one not yet in the cart must be on sale, in stock, at a shop that can deliver here (C17).
      if (packs.some((pack) => !pack || (!had.has(pack.listingId) && !(pack.onSale && leftOf(pack) > 0 && serving)))) return "NOT_FOUND";
      // A count is held at stock, and a part at 1 (owner's answer 9 on #50, answer 5 on #377); a line with none left
      // keeps its count until removed. Nothing is reserved.
      const held = lines.map((line, index) => {
        const pack = packs[index];
        const left = pack?.onSale ? leftOf(pack) : 0;
        return { listingId: line.listingId, count: left > 0 ? Math.min(line.count, left) : line.count };
      });
      await client.query("DELETE FROM cart_lines WHERE cart_id = $1", [cart.id]);
      await client.query(
        `INSERT INTO cart_lines (cart_id, listing_id, position, count)
         SELECT $1, (entry.line->>'listingId')::uuid, entry.position, (entry.line->>'count')::int
         FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS entry(line, position)`, [cart.id, JSON.stringify(held)]);
      await client.query("UPDATE carts SET revision = revision + 1, updated_at = $2 WHERE id = $1", [cart.id, clock.now()]);
      await client.query("COMMIT");
      return { held, packs };
    });
    if (typeof saved === "string") return reply.code(saved === "NOT_FOUND" ? 404 : 409).send({ error: { code: saved } });
    // Priced after the commit, from the packs the save checked: the quote reads in parallel, which one transaction's connection can't.
    return cartView(pool, who.accountId, shopId, serving, revision + 1, saved.held, saved.packs);
  });
}
