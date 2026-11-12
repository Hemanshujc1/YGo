import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import {
  type DeliveredQuote, ErrorEnvelope, PriceSimulatorBody, PriceSimulatorResponse, type RateCardDraft, type RateCardKey, type RateCardResponse,
  SimulatorListingsParams, SimulatorListingsResponse, type SimulatorListing,
} from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { adminSignedIn } from "../admin";
import { visibleListings } from "../listings";
import { deriveKeys } from "../tokens";
import { resolveRateCard } from "./rate-cards";

/** `eligible: false` keeps a line out of the shop-wide discount; nothing sets it yet, a bargained line will (#63). */
type BasketLine = { listingId: string; quantityOptionId: string | null; categoryId: string; unitPrice: string; count: number; eligible?: boolean };
const ORDER_KEYS: RateCardKey[] = ["deliveryFee", "smallCartFee", "deliveredContributionFloor", "minimumCart"];

/**
 * The latest published rate-card version, so every card a quote reads comes from the same one.
 * Before any card exists there is nothing to pin, and the reads may see a first card published meanwhile.
 */
export async function latestRateCardVersion(pool: Pool | PoolClient): Promise<string | undefined> {
  const { rows: [latest] } = await pool.query<{ version: string }>("SELECT COALESCE(MAX(version), 0) AS version FROM rate_card_versions");
  return latest?.version === "0" ? undefined : latest?.version;
}

/**
 * The delivered quote the cart will also use (MNY-10, MNY-15). TypeScript only picks the rules;
 * every amount comes from `pricing_delivered_quote` in PostgreSQL.
 */
export async function deliveredQuote(
  pool: Pool, shopId: string, lines: BasketLine[], shopDiscounts: boolean, version?: string, draft?: RateCardDraft, orderCard?: RateCardResponse,
): Promise<DeliveredQuote> {
  // Order-level values resolve shop → global; resolving without a category ignores category cards (#357).
  const resolve = async (categoryId?: string) => {
    const card = await resolveRateCard(pool, shopId, categoryId, version, undefined, draft);
    if (!card) throw new Error("Rate card did not resolve for a checked shop and category");
    return card;
  };
  // A caller that already resolved the order-level card for this version (the cart, when pickup is open) passes it, so it is read once (#601).
  const order = orderCard ?? await resolve();
  const categories = [...new Set(lines.map((line) => line.categoryId))];
  const byCategory = new Map(await Promise.all(categories.map(async (id) => [id, await resolve(id)] as const)));
  const missing = ORDER_KEYS.filter((key) => order.missing.includes(key));
  if ([...byCategory.values()].some((card) => card.missing.includes("commission"))) missing.unshift("commission");
  if (missing.length) return { status: "incomplete", rateCardVersion: order.version, missing };

  // The shop's one rule applies while it is active; a paused or switched-off rule takes nothing off (MNY-5, NOT-6). Until customers can
  // see a discount (`shopDiscounts`, #571), no rule applies, even one left active in the database.
  const { rows: [rule] } = !shopDiscounts ? { rows: [] } : await pool.query<{ id: string; version: number; form: string; percentage: string | null; cap: string | null; amount: string | null; minimumOrder: string | null }>(
    `SELECT id, version, form, trim_scale(percentage)::text AS percentage, trim_scale(cap)::text AS cap, trim_scale(flat_amount)::text AS amount,
        trim_scale(minimum_order)::text AS "minimumOrder"
      FROM shop_discounts WHERE shop_id = $1 AND status = 'active'`, [shopId]);
  const input = {
    lines: lines.map((line) => ({ unitPrice: line.unitPrice, count: line.count, eligible: line.eligible ?? true, commission: byCategory.get(line.categoryId)?.values.commission?.value })),
    shopDiscount: rule ? { form: rule.form, percentage: rule.percentage, cap: rule.cap, amount: rule.amount, minimumOrder: rule.minimumOrder } : null,
    deliveryFee: order.values.deliveryFee?.value, smallCartFee: order.values.smallCartFee?.value ?? null,
    minimumCart: order.values.minimumCart?.value, deliveredContributionFloor: order.values.deliveredContributionFloor?.value,
  };
  const { rows: [row] } = await pool.query<{ quote: Omit<Extract<DeliveredQuote, { status: "priced" }>, "status" | "rateCardVersion" | "sources" | "lines" | "shopDiscount"> & { shopDiscount: string; lines: Array<{ lineTotal: string; shopDiscount: string; commission: string }> } }>(
    "SELECT pricing_delivered_quote($1::jsonb) AS quote", [JSON.stringify(input)]);
  if (!row) throw new Error("Pricing engine returned no quote");
  const sources: Extract<DeliveredQuote, { status: "priced" }>["sources"] = {};
  for (const key of ORDER_KEYS) { const entry = order.values[key]; if (entry) sources[key] = entry.source; }
  const { shopDiscount, ...quote } = row.quote;
  return {
    ...quote, status: "priced", rateCardVersion: order.version, sources,
    shopDiscount: rule && Number(shopDiscount) > 0 ? { amount: shopDiscount, ruleId: rule.id, ruleVersion: rule.version } : null,
    lines: lines.map((line, index) => {
      const commission = byCategory.get(line.categoryId)?.values.commission;
      if (!commission || !row.quote.lines[index]) throw new Error("Pricing engine dropped a line");
      return { ...line, ...row.quote.lines[index], commissionSource: commission.source };
    }),
  };
}

export function registerPriceSimulatorRoutes(app: FastifyInstance, { pool, clock, secret, shopDiscounts }: { pool: Pool; clock: Clock; secret: string; shopDiscounts: boolean }): void {
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
        FROM ${visibleListings}
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
    // Both quotes read the same cards.
    const pinned = await latestRateCardVersion(pool);
    const [now, tried] = await Promise.all([deliveredQuote(pool, shopId, basket, shopDiscounts, pinned), draft && deliveredQuote(pool, shopId, basket, shopDiscounts, pinned, draft)]);
    return { now, draft: tried ?? null };
  });
}
