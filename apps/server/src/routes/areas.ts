import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool, PoolClient } from "pg";
import {
  Area,
  AreaParams,
  AreasResponse,
  CreateAreaBody,
  EditAreaBody,
  ErrorEnvelope,
  Serviceability,
  ServiceabilityQuery,
  WaitlistBody,
  type WaitlistEntry,
  WaitlistResponse,
} from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { adminSignedIn, withAdminTransaction } from "../admin";
import { deriveKeys, signedIn } from "../tokens";

const areaSql = `SELECT a.id, a.name, a.paused,
  ARRAY(SELECT p.pincode FROM area_pincodes p WHERE p.area_id = a.id ORDER BY p.pincode) AS pincodes
  FROM areas a`;

async function area(client: PoolClient, id: string): Promise<Area> {
  const row = await client.query<Area>(`${areaSql} WHERE a.id = $1`, [id]);
  if (!row.rows[0]) throw new Error("Saved Area missing");
  return row.rows[0];
}

/**
 * Locks pincode writes so Area saves run one at a time (two Areas swapping
 * pincodes can't deadlock), then names each pincode another Area holds.
 * The lock doesn't block reads, so serviceability checks carry on.
 */
async function heldElsewhere(client: PoolClient, pincodes: string[], ownId: string | null) {
  await client.query("LOCK TABLE area_pincodes IN SHARE ROW EXCLUSIVE MODE");
  const held = await client.query<{ pincode: string; areaName: string }>(
    `SELECT p.pincode, a.name AS "areaName" FROM area_pincodes p JOIN areas a ON a.id = p.area_id
     WHERE p.pincode = ANY($1) AND a.id IS DISTINCT FROM $2 ORDER BY p.pincode`,
    [pincodes, ownId],
  );
  return held.rows;
}

const savePincodes = "INSERT INTO area_pincodes (pincode, area_id) SELECT unnest($1::text[]), $2";

export function registerAreaRoutes(app: FastifyInstance, { pool, clock, secret }: { pool: Pool; clock: Clock; secret: string }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const response = { 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope };

  app.get("/v1/admin/waitlist", { schema: { response: { 200: WaitlistResponse, ...response } } }, async (request, reply) => {
    if (!await adminSignedIn(request, reply, auth)) return reply;
    const rows = await pool.query<Omit<WaitlistEntry, "savedAt"> & { savedAt: Date }>(
      `SELECT w.account_id AS "accountId", a.name AS "accountName", a.email AS "accountEmail",
       w.phone, w.pincode, w.saved_at AS "savedAt"
       FROM waitlist_entries w JOIN accounts a ON a.id = w.account_id
       ORDER BY w.saved_at DESC, w.pincode, w.account_id`,
    );
    return { entries: rows.rows.map((row) => ({ ...row, savedAt: row.savedAt.toISOString() })) };
  });

  app.get("/v1/admin/areas", { schema: { response: { 200: AreasResponse, ...response } } }, async (request, reply) => {
    if (!await adminSignedIn(request, reply, auth)) return reply;
    const rows = await pool.query<Area>(`${areaSql} ORDER BY lower(a.name)`);
    return { areas: rows.rows };
  });

  app.post("/v1/admin/areas", { schema: { body: CreateAreaBody, response: { 201: Area, ...response } } }, async (request, reply) => {
    const who = await adminSignedIn(request, reply, auth);
    if (!who) return reply;
    const { name, pincodes, reason } = request.body as CreateAreaBody;
    return withAdminTransaction(pool, who.accountId, reply, async (client) => {
      const conflicts = await heldElsewhere(client, pincodes, null);
      if (conflicts.length) return reply.code(409).send({ error: { code: "PINCODE_IN_OTHER_AREA", conflicts } });
      const inserted = await client.query<{ id: string }>("INSERT INTO areas (name) VALUES ($1) RETURNING id", [name]);
      const id = inserted.rows[0]?.id;
      if (!id) throw new Error("Area insert returned no ID");
      await client.query(savePincodes, [pincodes, id]);
      await client.query("INSERT INTO admin_actions (actor_id, action, target_id, target_type, reason) VALUES ($1, 'area.create', $2, 'area', $3)", [who.accountId, id, reason]);
      const saved = await area(client, id);
      await client.query("COMMIT");
      return reply.code(201).send(saved);
    }).catch((error: unknown) => {
      if ((error as { constraint?: string }).constraint === "areas_name_idx") return reply.code(409).send({ error: { code: "AREA_NAME_IN_USE" } });
      throw error;
    });
  });

  app.patch("/v1/admin/areas/:id", { schema: { params: AreaParams, body: EditAreaBody, response: { 200: Area, ...response } } }, async (request, reply) => {
    const who = await adminSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as { id: string };
    const { pincodes, paused, reason } = request.body as EditAreaBody;
    return withAdminTransaction(pool, who.accountId, reply, async (client) => {
      const locked = await client.query<Area>(`${areaSql} WHERE a.id = $1 FOR UPDATE OF a`, [id]);
      const old = locked.rows[0];
      if (!old) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      let action: string;
      if (pincodes) {
        // An edit that changes nothing writes no record (owner decision on #213).
        if ([...pincodes].sort().join() === old.pincodes.join()) return reply.code(200).send(old);
        const conflicts = await heldElsewhere(client, pincodes, id);
        if (conflicts.length) return reply.code(409).send({ error: { code: "PINCODE_IN_OTHER_AREA", conflicts } });
        await client.query("DELETE FROM area_pincodes WHERE area_id = $1", [id]);
        await client.query(savePincodes, [pincodes, id]);
        action = "area.edit_pincodes";
      } else {
        if (paused === old.paused) return reply.code(200).send(old);
        await client.query("UPDATE areas SET paused = $1 WHERE id = $2", [paused, id]);
        action = paused ? "area.pause" : "area.resume";
      }
      await client.query("INSERT INTO admin_actions (actor_id, action, target_id, target_type, reason) VALUES ($1, $2, $3, 'area', $4)", [who.accountId, action, id, reason]);
      const saved = await area(client, id);
      await client.query("COMMIT");
      return reply.code(200).send(saved);
    });
  });

  app.get("/v1/serviceability", { schema: { querystring: ServiceabilityQuery, response: { 200: Serviceability, 400: ErrorEnvelope, 401: ErrorEnvelope } } }, async (request, reply) => {
    if (!await signedIn(request, reply, auth)) return reply;
    const { pincode } = request.query as ServiceabilityQuery;
    const row = await pool.query<{ name: string }>(
      "SELECT a.name FROM area_pincodes p JOIN areas a ON a.id = p.area_id WHERE p.pincode = $1 AND NOT a.paused",
      [pincode],
    );
    return row.rows[0] ? { serviceable: true as const, areaName: row.rows[0].name } : { serviceable: false as const };
  });

  // Saved for any pincode, without a serviceability check (owner decision on #214).
  app.post("/v1/waitlist", { schema: { body: WaitlistBody, response: { 400: ErrorEnvelope, 401: ErrorEnvelope } } }, async (request, reply) => {
    const who = await signedIn(request, reply, auth);
    if (!who) return reply;
    const { pincode, phone } = request.body as WaitlistBody;
    await pool.query(
      `INSERT INTO waitlist_entries (account_id, pincode, phone, saved_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_id, pincode) DO UPDATE SET phone = EXCLUDED.phone, saved_at = EXCLUDED.saved_at`,
      [who.accountId, pincode, phone, clock.now()],
    );
    return (reply as FastifyReply).code(204).send();
  });
}
