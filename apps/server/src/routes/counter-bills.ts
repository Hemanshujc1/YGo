import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { AdminCounterBill, AdminCounterBillParams, AdminCounterBillsResponse, ErrorEnvelope, ResolveCounterBillBody, ShopApplicationParams } from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { adminSignedIn, withAdminTransaction } from "../admin";
import { listCounterBills, resolveCounterBill } from "../counter-bill-admin";
import { deriveKeys } from "../tokens";

/** Admin's held and flagged counter bills (#470). Admin only: an Area Manager gets 403, as on every stock or money screen. */
export function registerCounterBillRoutes(app: FastifyInstance, { pool, clock, secret }: { pool: Pool; clock: Clock; secret: string }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const response = { 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope };
  const base = "/v1/admin/shops/:id/counter-bills";

  app.get(base, { schema: { params: ShopApplicationParams, response: { 200: AdminCounterBillsResponse, ...response } } }, async (request, reply) => {
    const who = await adminSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as { id: string };
    if (!(await pool.query("SELECT 1 FROM shops WHERE id = $1 AND state <> 'draft'", [id])).rowCount) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    return { bills: await listCounterBills(pool, id) };
  });

  app.post(`${base}/:billId/resolutions`, { schema: { params: AdminCounterBillParams, body: ResolveCounterBillBody, response: { 201: AdminCounterBill, ...response } } }, async (request, reply) => {
    const who = await adminSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id, billId } = request.params as AdminCounterBillParams;
    const body = request.body as ResolveCounterBillBody;
    return withAdminTransaction(pool, who.accountId, reply, async (client) => {
      // The shop's row lock first, the order a sync batch takes its locks in.
      if (!(await client.query("SELECT 1 FROM shops WHERE id = $1 AND state <> 'draft' FOR UPDATE", [id])).rowCount) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      const done = await resolveCounterBill(client, id, billId, who.accountId, body, clock.now());
      if ("code" in done) return reply.code(done.code === "NOT_FOUND" ? 404 : 409).send({ error: { code: done.code } });
      await client.query("COMMIT");
      return reply.code(201).send(done.bill);
    });
  });
}
