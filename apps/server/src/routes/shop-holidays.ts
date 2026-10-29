import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import {
  addDays, ErrorEnvelope, HOLIDAY_DAYS_AHEAD, indiaToday, MAX_UPCOMING_HOLIDAYS, ShopHoliday, ShopHolidayParams, ShopHolidaysResponse,
} from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { withTransaction } from "../db";
import { deriveKeys, mobileSignedIn } from "../tokens";
import { ownerShop } from "./shop-agreement";

type Saved = ShopHolidaysResponse["upcoming"][number];

const holidaysSql = `SELECT id, to_char(starts, 'YYYY-MM-DD') AS starts, to_char(ends, 'YYYY-MM-DD') AS ends
  FROM shop_holidays WHERE shop_id = $1`;

async function list(client: Pool | PoolClient, shopId: string, today: string): Promise<ShopHolidaysResponse> {
  const rows = (await client.query<Saved>(`${holidaysSql} ORDER BY starts`, [shopId])).rows;
  return { upcoming: rows.filter((row) => row.ends >= today), past: rows.filter((row) => row.ends < today).reverse() };
}

/**
 * The Owner's holidays (#382), from Approved on, beside the weekly hours.
 * Owner's answers 1–12 on #382 and 1–4 of the second round: whole India days
 * from today up to HOLIDAY_DAYS_AHEAD, no overlaps, at most
 * MAX_UPCOMING_HOLIDAYS not ended yet. Ended holidays are a read-only record;
 * one under way keeps its start. A change that makes today a holiday or not
 * cancels a running open/closed switch, as saving hours does.
 */
export function registerShopHolidayRoutes(app: FastifyInstance, { pool, clock, secret }: { pool: Pool; clock: Clock; secret: string }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const response = { 200: ShopHolidaysResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope };
  const invalid = (reply: FastifyReply, field: string) => void reply.code(400).send({ error: { code: "VALIDATION_FAILED", fields: [field] } });

  /** Runs `change` on the signed-in Owner's Approved or Live shop under its row lock, then answers the list. */
  function change(handle: (client: PoolClient, shopId: string, today: string, request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | "saved">) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const who = await mobileSignedIn(request, reply, auth);
      if (!who) return reply;
      return withTransaction(pool, async (client) => {
        // The lock keeps two changes, or a change and the switch, one after the other.
        const shop = await ownerShop(client, who.accountId, true);
        if (!shop) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
        if (shop.state !== "approved" && shop.state !== "live") return reply.code(409).send({ error: { code: "SHOP_NOT_APPROVED" } });
        const today = indiaToday(clock.now());
        // A refusal has already answered; an awaited reply resolves to nothing, so only "saved" counts.
        if (await handle(client, shop.id, today, request, reply) !== "saved") return reply;
        const saved = await list(client, shop.id, today);
        await client.query("COMMIT");
        return reply.code(200).send(saved);
      });
    };
  }

  /** The Owner's holiday `id` that has not ended yet. */
  async function upcoming(client: PoolClient, shopId: string, id: string, today: string) {
    return (await client.query<Saved>(`${holidaysSql} AND id = $2 AND ends >= $3`, [shopId, id, today])).rows[0];
  }

  /**
   * Checks new dates against the window and the shop's other holidays, and
   * answers when they don't fit. It returns whether it answered, as an
   * awaited reply would resolve to nothing.
   */
  async function refused(client: PoolClient, reply: FastifyReply, shopId: string, today: string, dates: ShopHoliday, exceptId: string | null, startedOn: string | null) {
    if (startedOn ? dates.starts !== startedOn : dates.starts < today) { invalid(reply, "starts"); return true; }
    if (dates.ends < today || dates.ends > addDays(today, HOLIDAY_DAYS_AHEAD)) { invalid(reply, "ends"); return true; }
    const overlap = await client.query(
      "SELECT 1 FROM shop_holidays WHERE shop_id = $1 AND id IS DISTINCT FROM $2 AND starts <= $4 AND ends >= $3",
      [shopId, exceptId, dates.starts, dates.ends]);
    if (overlap.rowCount) void reply.code(409).send({ error: { code: "HOLIDAY_OVERLAP" } });
    return Boolean(overlap.rowCount);
  }

  /** A switch worked out while today was, or wasn't, a holiday no longer holds (owner's answer 4 of the second round). */
  async function todayChanged(client: PoolClient, shopId: string, before: boolean, after: boolean) {
    if (before !== after) await client.query("UPDATE shops SET open_override = NULL, open_override_until = NULL WHERE id = $1", [shopId]);
  }

  app.get("/v1/me/shop-holidays", { schema: { response } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const shop = await ownerShop(pool, who.accountId);
    if (!shop) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    if (shop.state !== "approved" && shop.state !== "live") return reply.code(409).send({ error: { code: "SHOP_NOT_APPROVED" } });
    return list(pool, shop.id, indiaToday(clock.now()));
  });

  app.post("/v1/me/shop-holidays", { schema: { body: ShopHoliday, response } }, change(async (client, shopId, today, request, reply) => {
    const dates = request.body as ShopHoliday;
    const count = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM shop_holidays WHERE shop_id = $1 AND ends >= $2", [shopId, today]);
    if ((count.rows[0]?.n ?? 0) >= MAX_UPCOMING_HOLIDAYS) return reply.code(409).send({ error: { code: "TOO_MANY_HOLIDAYS" } });
    if (await refused(client, reply, shopId, today, dates, null, null)) return reply;
    await client.query("INSERT INTO shop_holidays (shop_id, starts, ends) VALUES ($1, $2, $3)", [shopId, dates.starts, dates.ends]);
    await todayChanged(client, shopId, false, dates.starts === today);
    return "saved";
  }));

  app.put("/v1/me/shop-holidays/:id", { schema: { params: ShopHolidayParams, body: ShopHoliday, response } }, change(async (client, shopId, today, request, reply) => {
    const { id } = request.params as ShopHolidayParams;
    const dates = request.body as ShopHoliday;
    // An ended holiday is a record, so it can't be found to change.
    const old = await upcoming(client, shopId, id, today);
    if (!old) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    if (await refused(client, reply, shopId, today, dates, id, old.starts < today ? old.starts : null)) return reply;
    await client.query("UPDATE shop_holidays SET starts = $2, ends = $3 WHERE id = $1", [id, dates.starts, dates.ends]);
    await todayChanged(client, shopId, old.starts <= today, dates.starts <= today);
    return "saved";
  }));

  app.delete("/v1/me/shop-holidays/:id", { schema: { params: ShopHolidayParams, response } }, change(async (client, shopId, today, request, reply) => {
    const { id } = request.params as ShopHolidayParams;
    const old = await upcoming(client, shopId, id, today);
    if (!old) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    // A holiday under way ends yesterday, keeping its days gone by as a record (owner's answer 3 of the second round).
    if (old.starts < today) await client.query("UPDATE shop_holidays SET ends = $2 WHERE id = $1", [id, addDays(today, -1)]);
    else await client.query("DELETE FROM shop_holidays WHERE id = $1", [id]);
    await todayChanged(client, shopId, old.starts <= today, false);
    return "saved";
  }));
}
