import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool, PoolClient } from "pg";
import { ErrorEnvelope, SearchTerm, SearchTermBody, SearchTermParams, SearchTermsResponse } from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { adminSignedIn, withAdminTransaction } from "../admin";
import { deriveKeys } from "../tokens";

const columns = `id, typed_word AS "typedWord", catalog_word AS "catalogWord"`;

/** The record keeps the words themselves, so it still says what a removed term was (owner's answer 4 on #49). */
async function record(client: PoolClient, accountId: string, action: string, id: string, reason: string): Promise<void> {
  await client.query("INSERT INTO admin_actions (actor_id, action, target_id, target_type, reason) VALUES ($1, $2, $3, 'search_term', $4)", [accountId, action, id, reason]);
}

const pair = (term: SearchTermBody) => `${term.typedWord} → ${term.catalogWord}`;

/** A13 search terms (#397, DSC-3, ADM-3): one list for the whole platform, Admin only. */
export function registerSearchTermRoutes(app: FastifyInstance, { pool, clock, secret }: { pool: Pool; clock: Clock; secret: string }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const response = { 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope };
  const inUse = (reply: FastifyReply) => (error: unknown) => {
    if ((error as { code?: string }).code === "23505") return reply.code(409).send({ error: { code: "SEARCH_TERM_IN_USE" } });
    throw error;
  };

  app.get("/v1/admin/search-terms", { schema: { response: { 200: SearchTermsResponse, ...response } } }, async (request, reply) => {
    if (!await adminSignedIn(request, reply, auth)) return reply;
    const rows = await pool.query<SearchTerm>(`SELECT ${columns} FROM search_terms ORDER BY typed_word COLLATE "C", catalog_word COLLATE "C"`);
    return { terms: rows.rows };
  });

  app.post("/v1/admin/search-terms", { schema: { body: SearchTermBody, response: { 201: SearchTerm, ...response } } }, async (request, reply) => {
    const who = await adminSignedIn(request, reply, auth);
    if (!who) return reply;
    const body = request.body as SearchTermBody;
    return withAdminTransaction(pool, who.accountId, reply, async (client) => {
      const saved = await client.query<SearchTerm>(
        `INSERT INTO search_terms (typed_word, catalog_word) VALUES ($1, $2) RETURNING ${columns}`,
        [body.typedWord, body.catalogWord]);
      const term = saved.rows[0];
      if (!term) throw new Error("Search term insert returned no row");
      await record(client, who.accountId, "search_term.create", term.id, `Search term added: ${pair(term)}`);
      await client.query("COMMIT");
      return reply.code(201).send(term);
    }).catch(inUse(reply));
  });

  app.put("/v1/admin/search-terms/:id", { schema: { params: SearchTermParams, body: SearchTermBody, response: { 200: SearchTerm, ...response } } }, async (request, reply) => {
    const who = await adminSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as SearchTermParams;
    const body = request.body as SearchTermBody;
    return withAdminTransaction(pool, who.accountId, reply, async (client) => {
      const old = (await client.query<SearchTerm>(`SELECT ${columns} FROM search_terms WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!old) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      // Saving with nothing changed records nothing.
      if (old.typedWord === body.typedWord && old.catalogWord === body.catalogWord) return reply.code(200).send(old);
      await client.query("UPDATE search_terms SET typed_word = $1, catalog_word = $2 WHERE id = $3", [body.typedWord, body.catalogWord, id]);
      await record(client, who.accountId, "search_term.edit", id, `Search term changed: ${pair(old)} to ${pair(body)}`);
      await client.query("COMMIT");
      return reply.code(200).send({ id, ...body });
    }).catch(inUse(reply));
  });

  // Removing deletes the term (owner's answer 5 on #49).
  app.delete("/v1/admin/search-terms/:id", { schema: { params: SearchTermParams, response } }, async (request, reply) => {
    const who = await adminSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as SearchTermParams;
    return withAdminTransaction(pool, who.accountId, reply, async (client) => {
      const old = (await client.query<SearchTerm>(`DELETE FROM search_terms WHERE id = $1 RETURNING ${columns}`, [id])).rows[0];
      if (!old) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      await record(client, who.accountId, "search_term.delete", id, `Search term removed: ${pair(old)}`);
      await client.query("COMMIT");
      return (reply as FastifyReply).code(204).send();
    });
  });
}
