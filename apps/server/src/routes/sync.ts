import { ErrorEnvelope, SyncAccessResponse, SyncChangesQuery, SyncChangesResponse, type ShopStockResponse, OpeningStockPayload, StockFlagPayload, SyncActionsBody, SyncActionsResponse, type SyncActionResult } from "@ygo/contracts";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Clock } from "../adapters/clock";
import { withTransaction } from "../db";
import { deriveKeys, mobileSignedIn } from "../tokens";
import { applyOpeningStock, catalogSql } from "./shop-listings";

type Options = { pool: Pool; clock: Clock; secret: string; maxAgeSeconds: number; clockSkewSeconds: number };

export function registerSyncRoutes(app: FastifyInstance, { pool, clock, secret, maxAgeSeconds, clockSkewSeconds }: Options) {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  app.get("/v1/sync/access", { schema: { response: { 200: SyncAccessResponse, 401: ErrorEnvelope } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    return withTransaction(pool, async (client) => {
      // Match the shop row lock used by Stock and lifecycle writes, and lock the
      // membership row so a concurrent unlink cannot race a positive answer.
      const { rows: [shop] } = await client.query(`SELECT s.id, s.state FROM shops s JOIN shop_members m ON m.shop_id = s.id
        WHERE m.account_id = $1 AND m.role IN ('owner', 'staff') FOR SHARE OF s, m`, [who.accountId]);
      await client.query("COMMIT");
      return reply.send({ shopId: shop?.id ?? null, state: shop?.state ?? null });
    });
  });

  app.get("/v1/sync/changes", { schema: { querystring: SyncChangesQuery, response: {
    200: SyncChangesResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope,
  } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { since } = request.query as SyncChangesQuery;
    return withTransaction(pool, async (client) => {
      const { rows: [shop] } = await client.query<{ id: string; state: "live" | "suspended" }>(`SELECT s.id, s.state FROM shops s JOIN shop_members m ON m.shop_id = s.id
        WHERE m.account_id = $1 AND m.role IN ('owner', 'staff') FOR UPDATE OF s`, [who.accountId]);
      if (!shop) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      if (shop.state !== "live" && shop.state !== "suspended") return reply.code(409).send({ error: { code: "SHOP_LISTING_NOT_READY" } });
      await client.query("INSERT INTO stock_sync_shops (shop_id) VALUES ($1) ON CONFLICT DO NOTHING", [shop.id]);
      const { rows: [saved] } = await client.query<{ revision: string }>("SELECT revision FROM stock_sync_shops WHERE shop_id = $1", [shop.id]);
      if (!saved) throw new Error("Missing Stock revision");
      if (since && (!since.startsWith(`${shop.id}:`) || BigInt(since.split(":")[1] ?? "0") > BigInt(saved.revision))) return reply.code(400).send({ error: { code: "VALIDATION_FAILED" } });
      // One statement snapshot: a writer committing later is picked up by the next pull.
      const { rows } = await client.query<ShopStockResponse["items"][number]>(`SELECT "listingId", "packId", name, "packQuantity", "baseUnit", stock AS quantity, held, "outOfStock"
        FROM (${catalogSql} AND sl.id IS NOT NULL) current_stock`, [shop.id]);
      const previous = await client.query<{ packId: string; payload: ShopStockResponse["items"][number] | null }>('SELECT pack_id AS "packId", payload FROM stock_sync_items WHERE shop_id = $1', [shop.id]);
      const current = new Map(rows.map((item) => [item.packId, item]));
      const old = new Map(previous.rows.map((row) => [row.packId, row.payload]));
      const removed = previous.rows.filter((row) => row.payload && !current.has(row.packId));
      // jsonb key order is unspecified, so compare fields rather than its serialization.
      const updates = rows.filter((item) => {
        const was = old.get(item.packId);
        return !was || Object.entries(item).some(([key, value]) => was[key as keyof typeof was] !== value);
      });
      let revision = BigInt(saved.revision);
      if (updates.length || removed.length) {
        revision++;
        for (const item of updates) await client.query(`INSERT INTO stock_sync_items (shop_id, pack_id, revision, payload) VALUES ($1, $2, $3, $4)
          ON CONFLICT (shop_id, pack_id) DO UPDATE SET revision = EXCLUDED.revision, payload = EXCLUDED.payload, deleted_at = NULL`, [shop.id, item.packId, revision.toString(), JSON.stringify(item)]);
        for (const row of removed) await client.query("UPDATE stock_sync_items SET revision = $3, payload = NULL, deleted_at = $4 WHERE shop_id = $1 AND pack_id = $2", [shop.id, row.packId, revision.toString(), clock.now()]);
        await client.query("UPDATE stock_sync_shops SET revision = $2 WHERE shop_id = $1", [shop.id, revision.toString()]);
      }
      const delta = await client.query<{ packId: string; item: ShopStockResponse["items"][number] | null; deletedAt: Date | null }>(`SELECT pack_id AS "packId", payload AS item, deleted_at AS "deletedAt" FROM stock_sync_items
        WHERE shop_id = $1 AND revision > $2 ORDER BY revision, pack_id`, [shop.id, since?.split(":")[1] ?? "0"]);
      await client.query("COMMIT");
      return reply.send({ shopId: shop.id, state: shop.state, cursor: `${shop.id}:${revision}`, changes: delta.rows.map((row) => ({ ...row, deletedAt: row.deletedAt?.toISOString() ?? null })) });
    });
  });

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
        const shop = await client.query<{ state: string; role: string }>(`SELECT s.state, m.role FROM shops s JOIN shop_members m ON m.shop_id = s.id
          WHERE s.id = $1 AND m.account_id = $2 AND m.role IN ('owner', 'staff') FOR UPDATE OF s`, [action.shopId, who.accountId]);
        if (!shop.rows[0] || (action.type === "opening_stock" && shop.rows[0].role !== "owner")) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
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
        if (action.type === "stock_flag") {
          const flag = StockFlagPayload.safeParse(action.payload);
          if (!flag.success) result.code = "VALIDATION_FAILED";
          else if (shop.rows[0].state !== "live" && shop.rows[0].state !== "suspended") result.code = "SHOP_LISTING_NOT_READY";
          else if (now.getTime() - Date.parse(action.createdAt) > maxAgeSeconds * 1000) result.code = "ACTION_TOO_OLD";
          else {
            const { rows: [listing] } = await client.query<{ id: string }>(`UPDATE shop_listings SET out_of_stock = $3, updated_at = $4
              WHERE shop_id = $1 AND pack_id = $2 RETURNING id`, [action.shopId, flag.data.packId, flag.data.outOfStock, now]);
            if (!listing) result.code = "NOT_FOUND";
            else {
              result.status = "applied";
              result.result = { listingId: listing.id, outOfStock: flag.data.outOfStock, recordedAt: now.toISOString() };
            }
          }
        } else if (shop.rows[0].role !== "owner") result.code = "NOT_FOUND";
        else if (action.type !== "opening_stock" || !payload.success) result.code = "VALIDATION_FAILED";
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
