import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  ErrorEnvelope, FeedQuery, indiaToday, FeedResponse, type FeedShop, type RateCardValues, type ShopHoursRange,
  ShopPageParams, ShopPageResponse, type ShopPagePack, type ShopPageProduct,
} from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import type { ProductImageStorage } from "../adapters/product-images";
import { inStock, partOf, visibleListings } from "../listings";
import { pointFrom } from "../points";
import { fulfilmentModes } from "../fulfilment";
import { holidaysNear, holidaysOf, indiaWeekday, openStatus, overrideOf } from "../shop-open";
import { deriveKeys, mobileSignedIn } from "../tokens";
import { resolveRateCard } from "./rate-cards";

/** 10 minutes to prepare plus 4 a km, rounded up to the next 5 (owner's answer 3 on #47). */
export function estimatedMinutes(metres: number): number {
  return Math.ceil((10 + (4 * metres) / 1000) / 5) * 5;
}

export interface RatingsSettings {
  windowDays: number;
  minCount: number;
}

export type ServingShop = ShopPageResponse["shop"];

/**
 * The shops that can take this place's orders today: every rule of C04 (owner's answers 6 and 13 on #47).
 * Open shops come first, then closed ones, nearest first in each (owner's answer 9 on #371).
 * C05 asks for one shop by `shopId`, so a shop page follows the feed's rules exactly (owner's answer 10 on #47).
 */
export async function servingShops(
  pool: Pool,
  now: Date,
  { pincode, latitude, longitude }: FeedQuery,
  shopId: string | null = null,
  ratingsSettings: RatingsSettings = { windowDays: 90, minCount: 3 },
): Promise<ServingShop[]> {
  const rows = await pool.query<{ id: string; name: string; metres: number; fssaiNumber: string; open_override: boolean | null; open_override_until: Date | null }>(
    `WITH here AS (SELECT ${pointFrom("$2", "$3")} AS point)
     SELECT s.id, s.shop_name AS name, ST_Distance(s.location, here.point) AS metres, s.fssai_number AS "fssaiNumber",
       s.open_override, s.open_override_until
     FROM shops s, here
     WHERE s.state = 'live' AND s.fssai_expiry > $4::date AND ($5::uuid IS NULL OR s.id = $5)
       AND ST_DWithin(s.location, here.point, s.service_radius_metres)
       AND EXISTS (SELECT 1 FROM area_pincodes p JOIN areas a ON a.id = p.area_id WHERE p.pincode = $1 AND NOT a.paused)
       -- The shop's own Area must take orders too (owner's answer 13 on #47).
       AND EXISTS (SELECT 1 FROM area_pincodes p JOIN areas a ON a.id = p.area_id WHERE p.pincode = s.pincode AND NOT a.paused)
     ORDER BY metres, s.id`,
    [pincode, latitude, longitude, indiaToday(now), shopId],
  );
  const shopIds = rows.rows.map((row) => row.id);
  const hours = (await pool.query<ShopHoursRange & { shopId: string }>(
    `SELECT shop_id AS "shopId", weekday, opens, closes FROM shop_hours WHERE shop_id = ANY($1::uuid[]) ORDER BY weekday, opens`,
    [shopIds])).rows;
  const holidays = await holidaysOf(pool, shopIds, now);
  const ratings = shopIds.length > 0 ? (await pool.query<{ shopId: string; avgRating: number; count: number }>(
    `SELECT shop_id AS "shopId", ROUND(AVG(stars)::numeric, 1)::float AS "avgRating", COUNT(*)::int AS count
     FROM ratings
     WHERE shop_id = ANY($1::uuid[]) AND created_at >= $2::timestamptz - make_interval(days => $3::int)
     GROUP BY shop_id`,
    [shopIds, now, ratingsSettings.windowDays],
  )).rows : [];
  const ratingsByShop = new Map(ratings.map((r) => [r.shopId, r]));

  const shops = await Promise.all(rows.rows.map(async (row): Promise<ServingShop | undefined> => {
    // A Live shop whose card has become incomplete stays out (ONB-4).
    const card = await resolveRateCard(pool, row.id);
    const fee = card?.complete && (card.values.deliveryFee?.value as RateCardValues["deliveryFee"]);
    const minimum = card?.values.minimumCart?.value as RateCardValues["minimumCart"];
    if (!fee || minimum === undefined) return undefined;
    // FUL-1: delivery shows only while the instant switch is open, and pickup only while its switch is open and the card has its rule (#597).
    const modes = await fulfilmentModes(pool, row.id);
    const open = (mode: "instant" | "pickup") => modes.find((candidate) => candidate.mode === mode)?.open ?? false;
    const pickupCard = open("pickup") ? await resolveRateCard(pool, row.id, undefined, undefined, { usesPickup: true, usesBargain: false }) : undefined;
    const week = hours.filter((range) => range.shopId === row.id).map(({ weekday, opens, closes }) => ({ weekday, opens, closes }));
    const off = holidays.filter((holiday) => holiday.shopId === row.id);
    const status = openStatus(week, off, overrideOf(row), now);
    const near = holidaysNear(off, now);
    const shopRating = ratingsByShop.get(row.id);
    const rating = shopRating && shopRating.count >= ratingsSettings.minCount ? shopRating.avgRating : null;
    return {
      id: row.id, name: row.name, estimatedMinutes: estimatedMinutes(row.metres),
      deliveryFee: fee.amount, delivers: open("instant"), pickup: Boolean(pickupCard?.complete && !pickupCard.missing.includes("pickup")), open: status.open, opensAt: status.open ? null : status.until, holiday: !status.open && near.today,
      minimumOrder: minimum, fssaiNumber: row.fssaiNumber, closesAt: status.open ? status.until : null,
      hours: week, today: indiaWeekday(now), holidays: near.week,
      rating,
    };
  }));
  // A stable sort keeps the nearest-first order within the open and the closed group.
  return shops.filter((shop) => shop !== undefined).sort((a, b) => Number(b.open) - Number(a.open));
}

/** Whether a serving shop has any way of taking an order now: delivery, or pickup (#597). */
export const takesOrders = ({ delivers, pickup }: ServingShop) => delivers || pickup;

/** The C04 card's part of a serving shop; C16 search shows the same card (#398). */
export const feedCard = ({ id, name, estimatedMinutes, deliveryFee, delivers, pickup, open, opensAt, holiday, rating }: ServingShop): FeedShop =>
  ({ id, name, estimatedMinutes, deliveryFee, delivers, pickup, open, opensAt, holiday, rating });

type ListingRow = Omit<ShopPageProduct, "packs" | "imageUrl"> & ShopPagePack & { category: string; imageKey: string | null };

export function registerFeedRoutes(
  app: FastifyInstance,
  { pool, clock, secret, images, ratingsSettings = { windowDays: 90, minCount: 3 } }: {
    pool: Pool; clock: Clock; secret: string; images?: ProductImageStorage; ratingsSettings?: RatingsSettings;
  },
): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const errors = { 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope };

  // C04 Home (#369).
  app.get("/v1/feed", { schema: { querystring: FeedQuery, response: { 200: FeedResponse, ...errors } } }, async (request, reply) => {
    if (!await mobileSignedIn(request, reply, auth)) return reply;
    const shops = await servingShops(pool, clock.now(), request.query as FeedQuery, null, ratingsSettings);
    // A shop with every way of ordering switched off has nothing to offer here (#597).
    return { shops: shops.filter(takesOrders).map(feedCard) };
  });

  // C05 Shop page (#370): 404 for a shop this place can't order from, as for one that doesn't exist.
  app.get("/v1/shops/:id", { schema: { params: ShopPageParams, querystring: FeedQuery, response: { 200: ShopPageResponse, ...errors, 404: ErrorEnvelope } } }, async (request, reply) => {
    if (!await mobileSignedIn(request, reply, auth)) return reply;
    const { id } = request.params as ShopPageParams;
    const [shop] = await servingShops(pool, clock.now(), request.query as FeedQuery, id, ratingsSettings);
    if (!shop) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    // Out of stock with neither a whole pack nor a part on sale (owner's answer 9 on #47, #377); the MRP and the percent off, to two decimals, show only below it (answer 3 on #370, #411).
    const { rows } = await pool.query<ListingRow>(
      `SELECT COALESCE(parent.name, category.name) AS category, product.id, product.name, product.brand, product.base_unit AS "baseUnit",
          product.image_256_key AS "imageKey", listing.id AS "listingId", trim_scale(pack.quantity)::text AS quantity, listing.online_price::text AS price,
          CASE WHEN listing.online_price < listing.mrp THEN listing.mrp::text END AS mrp,
          CASE WHEN listing.online_price < listing.mrp THEN round((listing.mrp - listing.online_price) * 100 / listing.mrp, 2)::text END AS "discountPercent",
          NOT ${inStock("listing")} AS "outOfStock", ${partOf("listing")} AS part
        FROM ${visibleListings}
        ORDER BY lower(COALESCE(parent.name, category.name)), lower(product.name), product.id, pack.quantity`, [id]);
    const groups: ShopPageResponse["groups"] = [];
    for (const { category, id: productId, name, brand, baseUnit, imageKey, ...pack } of rows) {
      let group = groups.at(-1);
      if (group?.category !== category) groups.push(group = { category, products: [] });
      let product = group.products.at(-1);
      if (product?.id !== productId) group.products.push(product = { id: productId, name, brand, baseUnit, imageUrl: images && imageKey ? images.url(imageKey) : null, packs: [] });
      product.packs.push(pack);
    }
    return { shop, groups };
  });
}
