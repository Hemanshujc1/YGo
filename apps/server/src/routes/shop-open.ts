import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool, PoolClient } from "pg";
import { ErrorEnvelope, HOURS_STEP_MINUTES, ShopOpenChange, ShopOpenStatus, type ShopHoursRange } from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { withTransaction } from "../db";
import { holidaysOf, openStatus, overrideOf, schedule } from "../shop-open";
import { deriveKeys, mobileSignedIn } from "../tokens";

const DAY = 24 * 60 * 60_000;

type Shop = { id: string; state: string; role: string; open_override: boolean | null; open_override_until: Date | null };

/** The signed-in account's Live shop, or null once refused: Staff 403, no shop 404, not Live 409 (owner's answer 4 on #380). */
async function liveShop(client: Pool | PoolClient, accountId: string, reply: FastifyReply, lock = false) {
  const shop = (await client.query<Shop>(
    `SELECT s.id, s.state, m.role, s.open_override, s.open_override_until FROM shops s JOIN shop_members m ON m.shop_id = s.id
     WHERE m.account_id = $1${lock ? " FOR UPDATE OF s" : ""}`, [accountId])).rows[0];
  if (!shop) void reply.code(404).send({ error: { code: "NOT_FOUND" } });
  else if (shop.role !== "owner") void reply.code(403).send({ error: { code: "FORBIDDEN" } });
  else if (shop.state !== "live") void reply.code(409).send({ error: { code: "SHOP_NOT_LIVE" } });
  else return shop;
  return null;
}

async function hours(client: Pool | PoolClient, shopId: string) {
  return (await client.query<ShopHoursRange>("SELECT weekday, opens, closes FROM shop_hours WHERE shop_id = $1", [shopId])).rows;
}

/**
 * The Owner's open/closed switch (#380), for a Live shop. Owner's answers
 * 14–16 and 22 on #371 and 1–8 on #380: closing lasts until the next opening,
 * or 24 hours for a shop with no closed time; opening outside hours lasts
 * until a chosen half hour no later than the next opening.
 */
export function registerShopOpenRoutes(app: FastifyInstance, { pool, clock, secret }: { pool: Pool; clock: Clock; secret: string }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const response = { 200: ShopOpenStatus, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope };

  app.get("/v1/me/shop-open", { schema: { response } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const shop = await liveShop(pool, who.accountId, reply);
    if (!shop) return reply;
    const now = clock.now();
    return openStatus(await hours(pool, shop.id), await holidaysOf(pool, [shop.id], now), overrideOf(shop), now);
  });

  app.put("/v1/me/shop-open", { schema: { body: ShopOpenChange, response } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const change = request.body as ShopOpenChange;
    return withTransaction(pool, async (client) => {
      const shop = await liveShop(client, who.accountId, reply, true);
      if (!shop) return reply;
      const now = clock.now();
      const ranges = await hours(client, shop.id);
      const holidays = await holidaysOf(client, [shop.id], now);
      // On a holiday the hours are closed, so opening needs an end, as outside hours (owner's answer 9 on #382).
      const planned = schedule(ranges, holidays, now);
      let next: { open: boolean; until: Date } | null = null;
      if (change.open !== planned.open) {
        if (!change.open) next = { open: false, until: planned.nextOpening ?? new Date(now.getTime() + DAY) };
        else {
          const until = change.until ? new Date(change.until) : null;
          // Closed by the hours means a next opening exists; the chosen end sits on a half hour up to it.
          if (!until || !planned.nextOpening || until <= now || until > planned.nextOpening || until.getTime() % (HOURS_STEP_MINUTES * 60_000) !== 0) {
            return reply.code(400).send({ error: { code: "VALIDATION_FAILED", fields: ["until"] } });
          }
          next = { open: true, until };
        }
      }
      await client.query("UPDATE shops SET open_override = $2, open_override_until = $3 WHERE id = $1", [shop.id, next?.open ?? null, next?.until ?? null]);
      await client.query("COMMIT");
      return reply.code(200).send(openStatus(ranges, holidays, next, now));
    });
  });
}
