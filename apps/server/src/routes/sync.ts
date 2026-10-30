import { ErrorEnvelope, OpeningStockPayload, SyncActionsBody, SyncActionsResponse, type SyncActionResult } from "@ygo/contracts";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Clock } from "../adapters/clock";
import { withTransaction } from "../db";
import { deriveKeys, mobileSignedIn } from "../tokens";
import { applyOpeningStock } from "./shop-listings";

type Options = { pool: Pool; clock: Clock; secret: string; maxAgeSeconds: number; clockSkewSeconds: number };

export function registerSyncRoutes(app: FastifyInstance, { pool, clock, secret, maxAgeSeconds, clockSkewSeconds }: Options) {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  app.post("/v1/sync/actions", { schema: { body: SyncActionsBody, response: {
    200: SyncActionsResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 404: ErrorEnvelope,
  } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const body = request.body as SyncActionsBody;
    return withTransaction(pool, async (client) => {
      // Also serializes reused action IDs arriving on different devices of this account.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [who.accountId]);
      await client.query(`INSERT INTO sync_devices (account_id, device_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [who.accountId, body.deviceId]);
      const device = await client.query<{ sequence: string }>("SELECT sequence FROM sync_devices WHERE account_id = $1 AND device_id = $2 FOR UPDATE", [who.accountId, body.deviceId]);
      let sequence = Number(device.rows[0]?.sequence);
      const now = clock.now();
      await client.query("DELETE FROM sync_actions WHERE account_id = $1 AND created_at < $2", [who.accountId, new Date(now.getTime() - 30 * 86400_000)]);
      const results: SyncActionResult[] = [];
      for (const action of body.actions) {
        // Access is checked even for replays; neither an ID nor a device grants shop access.
        const shop = await client.query<{ state: string }>(`SELECT s.state FROM shops s JOIN shop_members m ON m.shop_id = s.id
          WHERE s.id = $1 AND m.account_id = $2 AND m.role = 'owner' FOR UPDATE OF s`, [action.shopId, who.accountId]);
        if (!shop.rows[0]) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
        const clockSuspect = action.clockSuspect || Math.abs(now.getTime() - Date.parse(body.sentAt)) > clockSkewSeconds * 1000
          || Date.parse(action.createdAt) > Date.parse(body.sentAt) + clockSkewSeconds * 1000;
        const result: SyncActionResult = { actionId: action.id, sequence: action.sequence, status: "retry", code: null, result: null, clockSuspect };
        const previous = await client.query<{ deviceId: string; action: string; result: string }>(
          'SELECT device_id AS "deviceId", action, result FROM sync_actions WHERE account_id = $1 AND action_id = $2', [who.accountId, action.id]);
        const saved = previous.rows[0];
        if (saved) {
          results.push(saved.deviceId === body.deviceId && saved.action === JSON.stringify(action)
            ? JSON.parse(saved.result) as SyncActionResult : { ...result, code: "ACTION_CONFLICT" });
          continue;
        }
        if (action.sequence !== sequence + 1) {
          results.push({ ...result, code: action.sequence > sequence + 1 ? "SEQUENCE_MISSING" : "ACTION_CONFLICT" });
          continue;
        }
        result.status = "rejected";
        const payload = OpeningStockPayload.safeParse(action.payload);
        if (action.type !== "opening_stock" || !payload.success) result.code = "VALIDATION_FAILED";
        else if (shop.rows[0].state !== "approved" && shop.rows[0].state !== "live") result.code = "SHOP_LISTING_NOT_READY";
        else {
          // A legacy endpoint's lost response remains replayable even after the age bound.
          const legacy = await client.query(`SELECT 1 FROM stock_movements sm JOIN shop_listings sl ON sl.id = sm.listing_id
            WHERE sl.shop_id = $1 AND sl.pack_id = $2 AND sm.actor_id = $3 AND sm.client_id = $4
              AND sm.kind = 'opening' AND sm.quantity = $5::numeric`,
          [action.shopId, payload.data.packId, who.accountId, action.id, payload.data.quantity]);
          const age = now.getTime() - Date.parse(action.createdAt);
          if (!legacy.rowCount && age > maxAgeSeconds * 1000) result.code = "ACTION_TOO_OLD";
          else {
            const answer = await applyOpeningStock(client, who.accountId, action.shopId, payload.data.packId, { clientId: action.id, quantity: payload.data.quantity });
            if ("code" in answer) result.code = answer.code;
            else { result.status = "applied"; result.result = answer.result; }
          }
        }
        await client.query(`INSERT INTO sync_actions (account_id, action_id, device_id, sequence, action, result, clock_suspect, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [who.accountId, action.id, body.deviceId, action.sequence, JSON.stringify(action), JSON.stringify(result), clockSuspect, now]);
        sequence = action.sequence;
        results.push(result);
      }
      await client.query("UPDATE sync_devices SET sequence = $3 WHERE account_id = $1 AND device_id = $2", [who.accountId, body.deviceId, sequence]);
      await client.query("COMMIT");
      return reply.send({ results });
    });
  });
}
