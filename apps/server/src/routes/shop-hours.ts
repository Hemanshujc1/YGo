import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { ErrorEnvelope, ShopHours, ShopHoursResponse, type ShopHoursRange } from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { withTransaction } from "../db";
import { deriveKeys, mobileSignedIn } from "../tokens";
import { ownerShop } from "./shop-agreement";

/**
 * The Owner's weekly opening hours (#371), from Approved on. Only the Owner
 * reads and saves them (owner's answer 7 on #371): staff and other accounts
 * get 404, as with listings. A save replaces the whole week.
 */
export function registerShopHoursRoutes(app: FastifyInstance, { pool, clock, secret }: { pool: Pool; clock: Clock; secret: string }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const response = { 200: ShopHoursResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope };
  const read = async (client: Pick<Pool, "query">, shopId: string): Promise<ShopHoursResponse> => ({
    ranges: (await client.query<ShopHoursRange>(
      "SELECT weekday, opens, closes FROM shop_hours WHERE shop_id = $1 ORDER BY weekday, opens", [shopId])).rows,
  });

  app.get("/v1/me/shop-hours", { schema: { response } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const shop = await ownerShop(pool, who.accountId);
    if (!shop) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    if (shop.state !== "approved" && shop.state !== "live") return reply.code(409).send({ error: { code: "SHOP_NOT_APPROVED" } });
    return read(pool, shop.id);
  });

  app.put("/v1/me/shop-hours", { schema: { body: ShopHours, response } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { ranges } = request.body as ShopHours;
    return withTransaction(pool, async (client) => {
      // The shop's row lock keeps two saves, or a save and Move to Live, one after the other.
      const shop = await ownerShop(client, who.accountId, true);
      if (!shop) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      if (shop.state !== "approved" && shop.state !== "live") return reply.code(409).send({ error: { code: "SHOP_NOT_APPROVED" } });
      await client.query("DELETE FROM shop_hours WHERE shop_id = $1", [shop.id]);
      // A running open/closed switch was worked out from the old hours (owner's answer 3 on #380).
      await client.query("UPDATE shops SET open_override = NULL, open_override_until = NULL WHERE id = $1", [shop.id]);
      await client.query(
        `INSERT INTO shop_hours (shop_id, weekday, opens, closes)
         SELECT $1, * FROM unnest($2::smallint[], $3::smallint[], $4::smallint[])`,
        [shop.id, ranges.map((range) => range.weekday), ranges.map((range) => range.opens), ranges.map((range) => range.closes)]);
      const saved = await read(client, shop.id);
      await client.query("COMMIT");
      return reply.code(200).send(saved);
    });
  });
}
