import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  type DeliveredQuote, ErrorEnvelope, PriceSimulatorBody, PriceSimulatorResponse, type RateCardDraft, type RateCardKey,
  SimulatorListingsParams, SimulatorListingsResponse, type SimulatorListing,
} from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { adminSignedIn } from "../admin";
import { deriveKeys } from "../tokens";
import { resolveRateCard } from "./rate-cards";

type BasketLine = { listingId: string; quantityOptionId: string | null; categoryId: string; unitPrice: string; count: number };
const ORDER_KEYS: RateCardKey[] = ["deliveryFee", "smallCartFee", "deliveredContributionFloor", "minimumCart"];

/**
 * The delivered quote the cart will also use (MNY-10, MNY-15). TypeScript only picks the rules;
 * every amount comes from `pricing_delivered_quote` in PostgreSQL.
 */
export async function deliveredQuote(pool: Pool, shopId: string, lines: BasketLine[], version?: string, draft?: RateCardDraft): Promise<DeliveredQuote> {
  // Order-level values resolve shop → global; resolving without a category ignores category cards (#357).
  const resolve = async (categoryId?: string) => {
    const card = await resolveRateCard(pool, shopId, categoryId, version, undefined, draft);
    if (!card) throw new Error("Rate card did not resolve for a checked shop and category");
    return card;
  };
  const order = await resolve();
  const categories = [...new Set(lines.map((line) => line.categoryId))];
  const byCategory = new Map(await Promise.all(categories.map(async (id) => [id, await resolve(id)] as const)));
  const missing = ORDER_KEYS.filter((key) => order.missing.includes(key));
  if ([...byCategory.values()].some((card) => card.missing.includes("commission"))) missing.unshift("commission");
  if (missing.length) return { status: "incomplete", rateCardVersion: order.version, missing };

  const input = {
    lines: lines.map((line) => ({ unitPrice: line.unitPrice, count: line.count, commission: byCategory.get(line.categoryId)?.values.commission?.value })),
    deliveryFee: order.values.deliveryFee?.value, smallCartFee: order.values.smallCartFee?.value ?? null,
    minimumCart: order.values.minimumCart?.value, deliveredContributionFloor: order.values.deliveredContributionFloor?.value,
  };
  const { rows: [row] } = await pool.query<{ quote: Omit<Extract<DeliveredQuote, { status: "priced" }>, "status" | "rateCardVersion" | "sources" | "lines"> & { lines: Array<{ lineTotal: string; commission: string }> } }>(
    "SELECT pricing_delivered_quote($1::jsonb) AS quote", [JSON.stringify(input)]);
  if (!row) throw new Error("Pricing engine returned no quote");
  const sources: Extract<DeliveredQuote, { status: "priced" }>["sources"] = {};
  for (const key of ORDER_KEYS) { const entry = order.values[key]; if (entry) sources[key] = entry.source; }
  return {
    ...row.quote, status: "priced", rateCardVersion: order.version, sources,
    lines: lines.map((line, index) => {
      const commission = byCategory.get(line.categoryId)?.values.commission;
      if (!commission || !row.quote.lines[index]) throw new Error("Pricing engine dropped a line");
      return { ...line, ...row.quote.lines[index], commissionSource: commission.source };
    }),
  };
}

export function registerPriceSimulatorRoutes(app: FastifyInstance, { pool, clock, secret }: { pool: Pool; clock: Clock; secret: string }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const errors = { 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope };
  // What A05 builds a basket from: the shop's listed packs a customer can see, each with its quantity-price options (#358).
  app.get("/v1/admin/shops/:id/listings", { schema: { params: SimulatorListingsParams, response: { 200: SimulatorListingsResponse, ...errors } } }, async (request, reply) => {
    if (!await adminSignedIn(request, reply, auth)) return reply;
    const { id } = request.params as SimulatorListingsParams;
    if (!(await pool.query("SELECT 1 FROM shops WHERE id = $1", [id])).rowCount) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    const { rows } = await pool.query<SimulatorListing>(
      `SELECT listing.id AS "listingId", product.name, product.brand, product.base_unit AS "baseUnit",
          trim_scale(pack.quantity)::text AS "packQuantity", listing.online_price::text AS "onlinePrice",
          COALESCE((SELECT jsonb_agg(jsonb_build_object('id', option.id, 'name', option.name,
              'quantity', trim_scale(option.quantity)::text, 'price', option.price::text) ORDER BY option.quantity)
            FROM shop_quantity_price_options option WHERE option.listing_id = listing.id), '[]') AS "quantityOptions"
        FROM shop_listings listing
        JOIN packs pack ON pack.id = listing.pack_id
        JOIN master_products product ON product.id = pack.product_id
        JOIN categories category ON category.id = product.category_id
        LEFT JOIN categories parent ON parent.id = category.parent_id
        WHERE listing.shop_id = $1 AND pack.active AND product.active AND product.published AND category.active AND COALESCE(parent.active, true)
        ORDER BY lower(product.name), pack.quantity`, [id]);
    return { listings: rows };
  });

  app.post("/v1/admin/price-simulator", { schema: { body: PriceSimulatorBody, response: { 200: PriceSimulatorResponse, ...errors } } }, async (request, reply) => {
    if (!await adminSignedIn(request, reply, auth)) return reply;
    const { shopId, lines, draft } = request.body as PriceSimulatorBody;
    // Each line is a listing of this shop, or a quantity-price option of one; the unit price is read, never sent.
    const { rows } = await pool.query<Omit<BasketLine, "count">>(
      `SELECT listing.id AS "listingId", entry.line->>'quantityOptionId' AS "quantityOptionId",
          COALESCE(option.price, listing.online_price)::text AS "unitPrice", product.category_id AS "categoryId"
        FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS entry(line, position)
        LEFT JOIN shop_quantity_price_options option ON option.id = (entry.line->>'quantityOptionId')::uuid
        JOIN shop_listings listing ON listing.id = COALESCE(option.listing_id, (entry.line->>'listingId')::uuid) AND listing.shop_id = $1
        JOIN packs pack ON pack.id = listing.pack_id
        JOIN master_products product ON product.id = pack.product_id
        ORDER BY entry.position`, [shopId, JSON.stringify(lines)]);
    if (rows.length !== lines.length) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    // A draft for another shop or an unknown category would silently change nothing.
    if (draft?.scope.type === "shop" && draft.scope.id !== shopId) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    if (draft?.scope.type === "category" && !(await pool.query("SELECT 1 FROM categories WHERE id = $1", [draft.scope.id])).rowCount) {
      return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    }
    const basket = rows.map((row, index) => ({ ...row, count: lines[index]?.count ?? 0 }));
    // Pin the latest published version so both quotes and every category read the same cards.
    // Before any card exists there is nothing to pin, and the reads may see a first card published meanwhile.
    const { rows: [latest] } = await pool.query<{ version: string }>("SELECT COALESCE(MAX(version), 0) AS version FROM rate_card_versions");
    const pinned = latest?.version === "0" ? undefined : latest?.version;
    const [now, tried] = await Promise.all([deliveredQuote(pool, shopId, basket, pinned), draft && deliveredQuote(pool, shopId, basket, pinned, draft)]);
    return { now, draft: tried ?? null };
  });
}
