import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import {
  AddressPinBody,
  ErrorEnvelope,
  SaveAddressBody,
  SavedAddress,
  SavedAddressesResponse,
  SavedAddressParams,
} from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { withTransaction } from "../db";
import { pointFrom, pointJson } from "../points";
import { deriveKeys, mobileSignedIn } from "../tokens";

/** At most 10 per account (owner decision on #217). */
const LIMIT = 10;

const addressSql = `SELECT id, label, flat, area_line AS "areaLine", pincode, ${pointJson("point")} AS point
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
      let id: string | undefined;
      if (label !== "other") {
        // A new Home or Work replaces the old one, which frees its place under the limit.
        await client.query("DELETE FROM saved_addresses WHERE account_id = $1 AND label = $2", [who.accountId, label]);
      } else {
        // An Other the same in every field is a retried save: it answers the one
        // already saved, now the newest, even at the limit (#242, review of #249).
        const same = await client.query<{ id: string }>(
          `UPDATE saved_addresses SET saved_at = $7 WHERE id = (
             SELECT id FROM saved_addresses
             WHERE account_id = $1 AND label = 'other' AND flat = $2 AND area_line IS NOT DISTINCT FROM $3 AND pincode = $4
               AND CASE WHEN $5::float8 IS NULL THEN point IS NULL
                 ELSE ST_Y(point::geometry) = $5::float8 AND ST_X(point::geometry) = $6::float8 END
             LIMIT 1)
           RETURNING id`,
          [who.accountId, flat, areaLine, pincode, point?.latitude ?? null, point?.longitude ?? null, clock.now()],
        );
        id = same.rows[0]?.id;
      }
      if (!id) {
        const count = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM saved_addresses WHERE account_id = $1", [who.accountId]);
        if ((count.rows[0]?.n ?? 0) >= LIMIT) return reply.code(409).send({ error: { code: "ADDRESS_LIMIT_REACHED" } });
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO saved_addresses (account_id, label, flat, area_line, pincode, point, saved_at)
           VALUES ($1, $2, $3, $4, $5, ${pointFrom("$6", "$7")}, $8)
           RETURNING id`,
          [who.accountId, label, flat, areaLine, pincode, point?.latitude ?? null, point?.longitude ?? null, clock.now()],
        );
        id = inserted.rows[0]?.id;
      }
      const saved = await client.query<SavedAddress>(`${addressSql} WHERE id = $1`, [id]);
      await client.query("COMMIT");
      return reply.code(201).send(saved.rows[0]);
    });
  });

  // The phone can't read a place with location refused, so the typed pincode stays (#373, owner's answer 2).
  app.put("/v1/me/addresses/:id/point", { schema: { params: SavedAddressParams, body: AddressPinBody, response: { 200: SavedAddress, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as { id: string };
    const { point } = request.body as AddressPinBody;
    const pinned = await pool.query<SavedAddress>(
      `UPDATE saved_addresses SET point = ${pointFrom("$3", "$4")} WHERE id = $1 AND account_id = $2
       RETURNING id, label, flat, area_line AS "areaLine", pincode, ${pointJson("point")} AS point`,
      [id, who.accountId, point.latitude, point.longitude],
    );
    // Another account's address answers the same as a missing one.
    if (!pinned.rowCount) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    return pinned.rows[0];
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
