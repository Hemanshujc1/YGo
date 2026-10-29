import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { ErrorEnvelope, FeedQuery, indiaToday, FeedResponse, type FeedShop, type RateCardValues } from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { pointFrom } from "../points";
import { deriveKeys, mobileSignedIn } from "../tokens";
import { resolveRateCard } from "./rate-cards";

/** 10 minutes to prepare plus 4 a km, rounded up to the next 5 (owner's answer 3 on #47). */
export function estimatedMinutes(metres: number): number {
  return Math.ceil((10 + (4 * metres) / 1000) / 5) * 5;
}

export function registerFeedRoutes(app: FastifyInstance, { pool, clock, secret }: { pool: Pool; clock: Clock; secret: string }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };

  // C04 Home (#369): every rule that stops a shop taking orders today (owner's answers 6 and 13 on #47).
  app.get("/v1/feed", { schema: { querystring: FeedQuery, response: { 200: FeedResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope } } }, async (request, reply) => {
    if (!await mobileSignedIn(request, reply, auth)) return reply;
    const { pincode, latitude, longitude } = request.query as FeedQuery;
    const rows = await pool.query<{ id: string; name: string; metres: number }>(
      `WITH here AS (SELECT ${pointFrom("$2", "$3")} AS point)
       SELECT s.id, s.shop_name AS name, ST_Distance(s.location, here.point) AS metres
       FROM shops s, here
       WHERE s.state = 'live' AND s.fssai_expiry > $4::date
         AND ST_DWithin(s.location, here.point, s.service_radius_metres)
         AND EXISTS (SELECT 1 FROM area_pincodes p JOIN areas a ON a.id = p.area_id WHERE p.pincode = $1 AND NOT a.paused)
         -- The shop's own Area must take orders too (owner's answer 13 on #47).
         AND EXISTS (SELECT 1 FROM area_pincodes p JOIN areas a ON a.id = p.area_id WHERE p.pincode = s.pincode AND NOT a.paused)
       ORDER BY metres, s.id`,
      [pincode, latitude, longitude, indiaToday(clock.now())],
    );
    const shops = await Promise.all(rows.rows.map(async (row): Promise<FeedShop | undefined> => {
      // A Live shop whose card has become incomplete stays out (ONB-4).
      const card = await resolveRateCard(pool, row.id);
      const fee = card?.complete && (card.values.deliveryFee?.value as RateCardValues["deliveryFee"]);
      return fee ? { id: row.id, name: row.name, estimatedMinutes: estimatedMinutes(row.metres), deliveryFee: fee.amount } : undefined;
    }));
    return { shops: shops.filter((shop) => shop !== undefined) };
  });
}
