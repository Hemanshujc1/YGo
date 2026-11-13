import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool, PoolClient } from "pg";
import { DenylistWordBody, DenylistWordParams, DenylistWordsResponse, ErrorEnvelope } from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { adminSignedIn, withAdminTransaction } from "../admin";
import { deriveKeys } from "../tokens";

async function record(client: PoolClient, accountId: string, action: string, reason: string): Promise<void> {
  await client.query("INSERT INTO admin_actions (actor_id, action, target_id, target_type, reason) VALUES ($1, $2, gen_random_uuid(), 'denylist_word', $3)", [accountId, action, reason]);
}

/** A13 denylist words (#69, CAT-8, ADM-3): platform-wide excluded-goods denylist, Admin only. */
export function registerDenylistWordRoutes(app: FastifyInstance, { pool, clock, secret }: { pool: Pool; clock: Clock; secret: string }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const response = { 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope };
  const inUse = (reply: FastifyReply) => (error: unknown) => {
    if ((error as { code?: string }).code === "23505") return reply.code(409).send({ error: { code: "DENYLIST_WORD_IN_USE" } });
    throw error;
  };

  app.get("/v1/admin/denylist-words", { schema: { response: { 200: DenylistWordsResponse, ...response } } }, async (request, reply) => {
    if (!await adminSignedIn(request, reply, auth)) return reply;
    const rows = await pool.query<{ word: string }>(`SELECT word FROM denylist_words ORDER BY word COLLATE "C"`);
    return { words: rows.rows.map((row) => row.word) };
  });

  app.post("/v1/admin/denylist-words", { schema: { body: DenylistWordBody, response: { 201: DenylistWordBody, ...response } } }, async (request, reply) => {
    const who = await adminSignedIn(request, reply, auth);
    if (!who) return reply;
    const body = request.body as DenylistWordBody;
    return withAdminTransaction(pool, who.accountId, reply, async (client) => {
      const saved = await client.query<{ word: string }>(
        `INSERT INTO denylist_words (word) VALUES ($1) RETURNING word`,
        [body.word]);
      const item = saved.rows[0];
      if (!item) throw new Error("Denylist word insert returned no row");
      await record(client, who.accountId, "denylist_word.create", `Denylist word added: ${item.word}`);
      await client.query("COMMIT");
      return reply.code(201).send(item);
    }).catch(inUse(reply));
  });

  app.delete("/v1/admin/denylist-words/:word", { schema: { params: DenylistWordParams, response } }, async (request, reply) => {
    const who = await adminSignedIn(request, reply, auth);
    if (!who) return reply;
    const { word } = request.params as DenylistWordParams;
    return withAdminTransaction(pool, who.accountId, reply, async (client) => {
      const deleted = (await client.query<{ word: string }>(`DELETE FROM denylist_words WHERE word = $1 RETURNING word`, [word])).rows[0];
      if (!deleted) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      await record(client, who.accountId, "denylist_word.delete", `Denylist word removed: ${deleted.word}`);
      await client.query("COMMIT");
      return (reply as FastifyReply).code(204).send();
    });
  });
}

