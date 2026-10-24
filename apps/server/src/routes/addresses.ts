import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import {
  ErrorEnvelope,
  SaveAddressBody,
  SavedAddress,
  SavedAddressesResponse,
  SavedAddressParams,
} from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { withTransaction } from "../db";
import { deriveKeys, mobileSignedIn } from "../tokens";

/** At most 10 per account (owner decision on #217). */
const LIMIT = 10;

const addressSql = `SELECT id, label, flat, area_line AS "areaLine", pincode,
  CASE WHEN point IS NULL THEN NULL
    ELSE json_build_object('latitude', ST_Y(point::geometry), 'longitude', ST_X(point::geometry)) END AS point
  FROM saved_addresses`;

export function registerAddressRoutes(app: FastifyInstance, { pool, clock, secret }: { pool: Pool; clock: Clock; secret: string }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };

  app.get("/v1/me/addresses", { schema: { response: { 200: SavedAddressesResponse, 401: ErrorEnvelope, 403: ErrorEnvelope } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const rows = await pool.query<SavedAddress>(`${addressSql} WHERE account_id = $1 ORDER BY saved_at DESC, id`, [who.accountId]);
    return { addresses: rows.rows };
  });

  // The pincode and the point are checked by the contract; no lookups (owner decision on #217).
  app.post("/v1/me/addresses", { schema: { body: SaveAddressBody, response: { 201: SavedAddress, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 409: ErrorEnvelope } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { label, flat, areaLine, pincode, point } = request.body as SaveAddressBody;
    return withTransaction(pool, async (client) => {
      // One save at a time per account, so two can't both pass the limit.
      await client.query("SELECT 1 FROM accounts WHERE id = $1 FOR NO KEY UPDATE", [who.accountId]);
      // A new Home or Work replaces the old one, so it never meets the limit.
      if (label !== "other") await client.query("DELETE FROM saved_addresses WHERE account_id = $1 AND label = $2", [who.accountId, label]);
      // An Other the same in every field is a retried save, so it answers the
      // one already saved, even at the limit (#242, review of #249).
      else {
        const same = await client.query<SavedAddress>(
          `${addressSql} WHERE account_id = $1 AND label = 'other' AND flat = $2 AND area_line IS NOT DISTINCT FROM $3 AND pincode = $4
             AND CASE WHEN $5::float8 IS NULL THEN point IS NULL
               ELSE ST_Y(point::geometry) = $5::float8 AND ST_X(point::geometry) = $6::float8 END
           LIMIT 1`,
          [who.accountId, flat, areaLine, pincode, point?.latitude ?? null, point?.longitude ?? null],
        );
        if (same.rows[0]) return reply.code(201).send(same.rows[0]);
      }
      const count = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM saved_addresses WHERE account_id = $1", [who.accountId]);
      if ((count.rows[0]?.n ?? 0) >= LIMIT) return reply.code(409).send({ error: { code: "ADDRESS_LIMIT_REACHED" } });
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO saved_addresses (account_id, label, flat, area_line, pincode, point, saved_at)
         VALUES ($1, $2, $3, $4, $5,
           CASE WHEN $6::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($7::float8, $6::float8), 4326)::geography END, $8)
         RETURNING id`,
        [who.accountId, label, flat, areaLine, pincode, point?.latitude ?? null, point?.longitude ?? null, clock.now()],
      );
      const saved = await client.query<SavedAddress>(`${addressSql} WHERE id = $1`, [inserted.rows[0]?.id]);
      await client.query("COMMIT");
      return reply.code(201).send(saved.rows[0]);
    });
  });

  app.delete("/v1/me/addresses/:id", { schema: { params: SavedAddressParams, response: { 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as { id: string };
    const removed = await pool.query("DELETE FROM saved_addresses WHERE id = $1 AND account_id = $2", [id, who.accountId]);
    // Another account's address answers the same as a missing one.
    if (!removed.rowCount) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    return (reply as FastifyReply).code(204).send();
  });
}
