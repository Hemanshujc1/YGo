import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import {
  AdminFulfilmentModeParams, ErrorEnvelope, ForceFulfilmentModeBody, type FulfilmentMode, FulfilmentModeParams, FulfilmentModesResponse, OrderParams, SetFulfilmentModeBody,
} from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { adminSignedIn, withAdminTransaction } from "../admin";
import { withTransaction } from "../db";
import { fulfilmentModes, START_ON } from "../fulfilment";
import { deriveKeys, mobileSignedIn } from "../tokens";
import { resolveRateCard } from "./rate-cards";

/**
 * The fulfilment switches (FUL-1, #65): the Owner switches each of the shop's modes on or off, and Admin can force one off for a shop. A switch only
 * decides which new orders can be placed; an order already placed carries on. Pickup can be switched on only once the shop's rate card has a pickup
 * rule with its contribution floor (MNY-13), so a shop never offers a route it can't price.
 */
export function registerFulfilmentModeRoutes(app: FastifyInstance, { pool, clock, secret }: { pool: Pool; clock: Clock; secret: string }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const errors = { 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope };
  // A row made by one side's change starts the other side's column at its start value, so Admin forcing pickup off and lifting it never switches it on for the Owner.
  const upsert = (shopId: string, mode: FulfilmentMode, column: "shop_on" | "admin_forced_off", value: boolean, client: Pool | PoolClient) => client.query(
    `INSERT INTO shop_fulfilment_modes (shop_id, mode, shop_on, admin_forced_off) VALUES ($1, $2, $3, $4)
     ON CONFLICT (shop_id, mode) DO UPDATE SET ${column} = EXCLUDED.${column}`,
    [shopId, mode, column === "shop_on" ? value : START_ON[mode], column === "admin_forced_off" ? value : false]);

  app.get("/v1/me/fulfilment-modes", { schema: { response: { 200: FulfilmentModesResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { rows: [member] } = await pool.query<{ shopId: string }>("SELECT shop_id AS \"shopId\" FROM shop_members WHERE account_id = $1", [who.accountId]);
    if (!member) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    return { modes: await fulfilmentModes(pool, member.shopId) };
  });

  app.put("/v1/me/fulfilment-modes/:mode", { schema: { params: FulfilmentModeParams, body: SetFulfilmentModeBody, response: { 200: FulfilmentModesResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { mode } = request.params as FulfilmentModeParams;
    const { on } = request.body as SetFulfilmentModeBody;
    return withTransaction(pool, async (client) => {
      const { rows: [member] } = await client.query<{ shopId: string; role: string }>(
        "SELECT m.shop_id AS \"shopId\", m.role FROM shop_members m JOIN shops s ON s.id = m.shop_id WHERE m.account_id = $1 FOR UPDATE OF s", [who.accountId]);
      if (!member) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      if (member.role !== "owner") return reply.code(403).send({ error: { code: "FORBIDDEN" } });
      // Switching pickup on needs the card's pickup rule and floor; switching anything off never does.
      if (on && mode === "pickup" && (await resolveRateCard(client, member.shopId, undefined, undefined, { usesPickup: true, usesBargain: false }))?.missing.includes("pickup")) {
        return reply.code(409).send({ error: { code: "PICKUP_NOT_CONFIGURED" } });
      }
      await upsert(member.shopId, mode, "shop_on", on, client);
      await client.query("COMMIT");
      return { modes: await fulfilmentModes(client, member.shopId) };
    });
  });

  app.get("/v1/admin/shops/:id/fulfilment-modes", { schema: { params: OrderParams, response: { 200: FulfilmentModesResponse, ...errors } } }, async (request, reply) => {
    if (!await adminSignedIn(request, reply, auth)) return reply;
    const { id } = request.params as OrderParams;
    if (!(await pool.query("SELECT 1 FROM shops WHERE id = $1", [id])).rowCount) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    return { modes: await fulfilmentModes(pool, id) };
  });

  app.put("/v1/admin/shops/:id/fulfilment-modes/:mode", { schema: { params: AdminFulfilmentModeParams, body: ForceFulfilmentModeBody, response: { 200: FulfilmentModesResponse, ...errors } } }, async (request, reply) => {
    const who = await adminSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id, mode } = request.params as AdminFulfilmentModeParams;
    const { forcedOff } = request.body as ForceFulfilmentModeBody;
    return withAdminTransaction(pool, who.accountId, reply, async (client) => {
      if (!(await client.query("SELECT 1 FROM shops WHERE id = $1 FOR UPDATE", [id])).rowCount) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      await upsert(id, mode, "admin_forced_off", forcedOff, client);
      await client.query("COMMIT");
      return { modes: await fulfilmentModes(client, id) };
    });
  });
}
