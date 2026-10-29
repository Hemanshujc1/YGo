import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  ErrorEnvelope, FeedQuery, indiaToday, FeedResponse, type RateCardValues,
  ShopPageParams, ShopPageResponse, type ShopPagePack, type ShopPageProduct,
} from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { visibleListings } from "../listings";
import { pointFrom } from "../points";
import { deriveKeys, mobileSignedIn } from "../tokens";
import { resolveRateCard } from "./rate-cards";

/** 10 minutes to prepare plus 4 a km, rounded up to the next 5 (owner's answer 3 on #47). */
export function estimatedMinutes(metres: number): number {
  return Math.ceil((10 + (4 * metres) / 1000) / 5) * 5;
}

type ServingShop = ShopPageResponse["shop"];

/**
 * The shops that can take this place's orders today, nearest first: every rule of C04 (owner's answers 6 and 13 on #47).
 * C05 asks for one shop by `shopId`, so a shop page follows the feed's rules exactly (owner's answer 10 on #47).
 */
async function servingShops(pool: Pool, now: Date, { pincode, latitude, longitude }: FeedQuery, shopId: string | null = null): Promise<ServingShop[]> {
  const rows = await pool.query<{ id: string; name: string; metres: number; fssaiNumber: string }>(
    `WITH here AS (SELECT ${pointFrom("$2", "$3")} AS point)
     SELECT s.id, s.shop_name AS name, ST_Distance(s.location, here.point) AS metres, s.fssai_number AS "fssaiNumber"
     FROM shops s, here
     WHERE s.state = 'live' AND s.fssai_expiry > $4::date AND ($5::uuid IS NULL OR s.id = $5)
       AND ST_DWithin(s.location, here.point, s.service_radius_metres)
       AND EXISTS (SELECT 1 FROM area_pincodes p JOIN areas a ON a.id = p.area_id WHERE p.pincode = $1 AND NOT a.paused)
       -- The shop's own Area must take orders too (owner's answer 13 on #47).
       AND EXISTS (SELECT 1 FROM area_pincodes p JOIN areas a ON a.id = p.area_id WHERE p.pincode = s.pincode AND NOT a.paused)
     ORDER BY metres, s.id`,
    [pincode, latitude, longitude, indiaToday(now), shopId],
  );
  const shops = await Promise.all(rows.rows.map(async (row): Promise<ServingShop | undefined> => {
    // A Live shop whose card has become incomplete stays out (ONB-4).
    const card = await resolveRateCard(pool, row.id);
    const fee = card?.complete && (card.values.deliveryFee?.value as RateCardValues["deliveryFee"]);
    const minimum = card?.values.minimumCart?.value as RateCardValues["minimumCart"];
    if (!fee || minimum === undefined) return undefined;
    return {
      id: row.id, name: row.name, estimatedMinutes: estimatedMinutes(row.metres),
      deliveryFee: fee.amount, minimumOrder: minimum, fssaiNumber: row.fssaiNumber,
    };
  }));
  return shops.filter((shop) => shop !== undefined);
}

type ListingRow = Omit<ShopPageProduct, "packs"> & ShopPagePack & { category: string };

export function registerFeedRoutes(app: FastifyInstance, { pool, clock, secret }: { pool: Pool; clock: Clock; secret: string }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const errors = { 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope };

  // C04 Home (#369).
  app.get("/v1/feed", { schema: { querystring: FeedQuery, response: { 200: FeedResponse, ...errors } } }, async (request, reply) => {
    if (!await mobileSignedIn(request, reply, auth)) return reply;
    const shops = await servingShops(pool, clock.now(), request.query as FeedQuery);
    return { shops: shops.map(({ id, name, estimatedMinutes, deliveryFee }) => ({ id, name, estimatedMinutes, deliveryFee })) };
  });

  // C05 Shop page (#370): 404 for a shop this place can't order from, as for one that doesn't exist.
  app.get("/v1/shops/:id", { schema: { params: ShopPageParams, querystring: FeedQuery, response: { 200: ShopPageResponse, ...errors, 404: ErrorEnvelope } } }, async (request, reply) => {
    if (!await mobileSignedIn(request, reply, auth)) return reply;
    const { id } = request.params as ShopPageParams;
    const [shop] = await servingShops(pool, clock.now(), request.query as FeedQuery, id);
    if (!shop) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    // Out of stock at or below zero (owner's answer 9 on #47); the MRP and a whole percent off show only below it (answer 3 on #370).
    const { rows } = await pool.query<ListingRow>(
      `SELECT COALESCE(parent.name, category.name) AS category, product.id, product.name, product.brand, product.base_unit AS "baseUnit",
          listing.id AS "listingId", trim_scale(pack.quantity)::text AS quantity, listing.online_price::text AS price,
          CASE WHEN listing.online_price < listing.mrp THEN listing.mrp::text END AS mrp,
          CASE WHEN listing.online_price < listing.mrp THEN floor((listing.mrp - listing.online_price) * 100 / listing.mrp)::int END AS "discountPercent",
          COALESCE((SELECT sum(movement.quantity) FROM stock_movements movement WHERE movement.listing_id = listing.id), 0) <= 0 AS "outOfStock"
        FROM ${visibleListings}
        ORDER BY lower(COALESCE(parent.name, category.name)), lower(product.name), product.id, pack.quantity`, [id]);
    const groups: ShopPageResponse["groups"] = [];
    for (const { category, id: productId, name, brand, baseUnit, ...pack } of rows) {
      let group = groups.at(-1);
      if (group?.category !== category) groups.push(group = { category, products: [] });
      let product = group.products.at(-1);
      if (product?.id !== productId) group.products.push(product = { id: productId, name, brand, baseUnit, packs: [] });
      product.packs.push(pack);
    }
    return { shop, groups };
  });
}
