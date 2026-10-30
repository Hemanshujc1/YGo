import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { ErrorEnvelope, SearchQuery, SearchResponse, type SearchProduct } from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { inStock, visibleListings } from "../listings";
import { deriveKeys, mobileSignedIn } from "../tokens";
import { feedCard, servingShops } from "./feed";

/** One typed word's alternatives (`word`) match `text`: at the start of one of its words, or, from 4 letters, as a near spelling (owner's answers 9 on #49 and 1 on #398). */
const wordIn = (text: string) => `EXISTS (SELECT 1 FROM jsonb_array_elements_text(word) alt
    WHERE strpos(' ' || ${text}, ' ' || alt) > 0 OR (length(alt) >= 4 AND alt <% ${text}))`;
/** Every typed word in `$2`, one list of alternatives each, matches `text`. */
const everyWord = (text: string) => `NOT EXISTS (SELECT 1 FROM jsonb_array_elements($2::jsonb) word WHERE NOT ${wordIn(text)})`;
/** At least one typed word matches `text`. */
const someWord = (text: string) => `EXISTS (SELECT 1 FROM jsonb_array_elements($2::jsonb) word WHERE ${wordIn(text)})`;

/** C16 Search (#398, DSC-3): the shops Home lists that match by name or by a product they list. */
export function registerSearchRoutes(app: FastifyInstance, { pool, clock, secret }: { pool: Pool; clock: Clock; secret: string }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };

  app.get("/v1/search", { schema: { querystring: SearchQuery, response: { 200: SearchResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope } } }, async (request, reply) => {
    if (!await mobileSignedIn(request, reply, auth)) return reply;
    const { q, ...place } = request.query as SearchQuery;
    const text = (await pool.query<{ text: string }>("SELECT search_text($1) AS text", [q])).rows[0]?.text ?? "";
    if (!text) return { shops: [] };
    // A search term applies when its whole typed phrase is in the search; its catalog word then stands in for those words (owner's answer 4 on #398).
    const words = text.split(" ");
    const alternatives = words.map((word) => [word]);
    const terms = await pool.query<{ typed: string; catalog: string }>(
      `SELECT typed_word AS typed, catalog_word AS catalog FROM search_terms WHERE strpos(' ' || $1 || ' ', ' ' || typed_word || ' ') > 0`, [text]);
    for (const { typed, catalog } of terms.rows) {
      const phrase = typed.split(" ");
      words.forEach((word, index) => { if (phrase.includes(word)) alternatives[index]?.push(catalog); });
    }
    const wordsJson = JSON.stringify(alternatives);

    const shops = await Promise.all((await servingShops(pool, clock.now(), place)).map(async (shop) => {
      // Each word may match the shop's name, the product's name or its brand, and one must match the product itself;
      // up to 5 products, A to Z (owner's answer 2 on #398).
      const { rows } = await pool.query<SearchProduct & { total: number }>(
        `SELECT product.id, product.name, product.brand,
            bool_or(${inStock("listing")}) AS "inStock",
            count(*) OVER ()::int AS total
          FROM ${visibleListings}
            AND ${everyWord("search_text($3 || ' ' || product.name || ' ' || COALESCE(product.brand, ''))")}
            AND ${someWord("search_text(product.name || ' ' || COALESCE(product.brand, ''))")}
          GROUP BY product.id
          ORDER BY lower(product.name), product.id
          LIMIT 5`, [shop.id, wordsJson, shop.name]);
      if (rows.length === 0) {
        // A shop matched by its name alone shows just its card (owner's answer 12 on #49).
        const byName = await pool.query<{ hit: boolean }>(`SELECT ${everyWord("search_text($1)")} AS hit`, [shop.name, wordsJson]);
        return byName.rows[0]?.hit ? { ...feedCard(shop), products: [], moreProducts: 0 } : undefined;
      }
      const products = rows.map(({ id, name, brand, inStock }) => ({ id, name, brand, inStock }));
      return { ...feedCard(shop), products, moreProducts: (rows[0]?.total ?? 0) - rows.length };
    }));
    return { shops: shops.filter((shop) => shop !== undefined) };
  });
}
