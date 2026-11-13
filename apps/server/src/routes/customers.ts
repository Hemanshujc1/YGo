import type { FastifyInstance } from "fastify";
import { AdminCustomersQuery, AdminCustomersResponse, CustomerBlockBody, CustomerParams, CustomerSignupSettingBody, CustomerSignupSettings, CustomerTrust, ErrorEnvelope, type AdminCustomersQuery as Query, type CustomerBlockBody as BlockBody, type CustomerParams as Params, type CustomerSignupSettingBody as SignupBody } from "@ygo/contracts";
import type { Pool } from "pg";
import type { Clock } from "../adapters/clock";
import { adminSignedIn, withAdminTransaction } from "../admin";
import { blockCustomer, listCustomers, unblockCustomer } from "../customer-trust";
import { deriveKeys } from "../tokens";

export function registerCustomerRoutes(app: FastifyInstance, { pool, clock, secret }: { pool: Pool; clock: Clock; secret: string }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const response = { 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope };
  app.get("/v1/admin/customers", { schema: { querystring: AdminCustomersQuery, response: { 200: AdminCustomersResponse, ...response } } }, async (request, reply) => {
    if (!await adminSignedIn(request, reply, auth)) return reply;
    const query = request.query as Query;
    return { customers: await listCustomers(pool, query.search, clock.now(), query.flagged === "true") };
  });
  app.post("/v1/admin/customers/:id/block", { schema: { params: CustomerParams, body: CustomerBlockBody, response: { 200: CustomerTrust, ...response } } }, async (request, reply) => {
    const who = await adminSignedIn(request, reply, auth);
    if (!who) return reply;
    return withAdminTransaction(pool, who.accountId, reply, async (client) => {
      const customer = await blockCustomer(client, (request.params as Params).id, (request.body as BlockBody).reason, who.accountId, auth.keys, clock.now());
      if (!customer) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      await client.query("COMMIT");
      return reply.code(200).send(customer);
    });
  });
  app.post("/v1/admin/customers/:id/unblock", { schema: { params: CustomerParams, body: CustomerBlockBody, response: { 204: {}, ...response } } }, async (request, reply) => {
    const who = await adminSignedIn(request, reply, auth);
    if (!who) return reply;
    return withAdminTransaction(pool, who.accountId, reply, async (client) => {
      const found = await unblockCustomer(client, (request.params as Params).id, (request.body as BlockBody).reason, who.accountId);
      if (!found) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      await client.query("COMMIT");
      return reply.code(204).send();
    });
  });
  app.get("/v1/admin/customer-signups", { schema: { response: { 200: CustomerSignupSettings, ...response } } }, async (request, reply) => {
    if (!await adminSignedIn(request, reply, auth)) return reply;
    const result = await pool.query<{ enabled: boolean }>("SELECT enabled FROM customer_signup_settings WHERE id = 1");
    return reply.code(200).send(result.rows[0] ?? { enabled: true });
  });
  app.put("/v1/admin/customer-signups", { schema: { body: CustomerSignupSettingBody, response: { 200: CustomerSignupSettings, ...response } } }, async (request, reply) => {
    const who = await adminSignedIn(request, reply, auth);
    if (!who) return reply;
    return withAdminTransaction(pool, who.accountId, reply, async (client) => {
      const body = request.body as SignupBody;
      const result = await client.query<{ enabled: boolean }>("UPDATE customer_signup_settings SET enabled = $1, updated_at = $2 WHERE id = 1 RETURNING enabled", [body.enabled, clock.now()]);
      await client.query("INSERT INTO admin_actions (actor_id, action, target_id, target_type, reason) VALUES ($1, 'customer.signups', $2, 'system', $3)", [who.accountId, who.accountId, body.reason]);
      await client.query("COMMIT");
      return reply.code(200).send(result.rows[0] ?? { enabled: body.enabled });
    });
  });
}
