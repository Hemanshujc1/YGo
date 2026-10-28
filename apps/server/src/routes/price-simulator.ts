import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  type DeliveredQuote, ErrorEnvelope, PriceSimulatorBody, PriceSimulatorResponse, type RateCardDraft, type RateCardKey,
  type RateCardResponse,
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
  const order = await resolveRateCard(pool, shopId, undefined, version, undefined, draft) as RateCardResponse;
  const categories = [...new Set(lines.map((line) => line.categoryId))];
  const byCategory = new Map(await Promise.all(categories.map(async (id) =>
    [id, await resolveRateCard(pool, shopId, id, version, undefined, draft) as RateCardResponse] as const)));
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
    const basket = rows.map((row, index) => ({ ...row, count: lines[index]?.count ?? 0 }));
    // Pin one published version so both quotes and every category read the same cards.
    const { rows: [latest] } = await pool.query<{ version: string }>("SELECT COALESCE(MAX(version), 0) AS version FROM rate_card_versions");
    const pinned = latest?.version === "0" ? undefined : latest?.version;
    return { now: await deliveredQuote(pool, shopId, basket, pinned), draft: draft ? await deliveredQuote(pool, shopId, basket, pinned, draft) : null };
  });
}
