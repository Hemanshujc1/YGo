import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import {
  AdminStatementsQuery, AdminStatementsResponse, ErrorEnvelope, OwnerStatementsResponse, ShopBalancesResponse, Statement, StatementParams, StatementsQuery,
} from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { adminSignedIn } from "../admin";
import { listStatements, shopBalances, statementDetail } from "../statements";
import { deriveKeys, mobileSignedIn } from "../tokens";

/**
 * Weekly statements and balances (#629, MNY-8, ADM-6): the Owner sees their own shop's (S15), Admin sees every shop's (A18). Staff are refused,
 * and so are Area Managers. Nothing here changes a statement; the issue-statements job makes them.
 */
export function registerStatementRoutes(app: FastifyInstance, { pool, clock, secret }: { pool: Pool; clock: Clock; secret: string }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const errors = { 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope };

  /** The Owner's shop, or the reply already sent: 404 with no shop, 403 for Staff. */
  async function ownerShop(request: FastifyRequest, reply: FastifyReply): Promise<string | undefined> {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return undefined;
    const { rows: [member] } = await pool.query<{ shopId: string; role: string }>(
      'SELECT shop_id AS "shopId", role FROM shop_members WHERE account_id = $1', [who.accountId]);
    if (!member) { reply.code(404).send({ error: { code: "NOT_FOUND" } }); return undefined; }
    if (member.role !== "owner") { reply.code(403).send({ error: { code: "FORBIDDEN" } }); return undefined; }
    return member.shopId;
  }

  app.get("/v1/me/statements", { schema: { querystring: StatementsQuery, response: { 200: OwnerStatementsResponse, ...errors } } }, async (request, reply) => {
    const shopId = await ownerShop(request, reply);
    if (!shopId) return reply;
    const [balance] = await shopBalances(pool, shopId);
    if (!balance) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    const { onStatements, thisWeek, total } = balance;
    return { balance: { onStatements, thisWeek, total }, ...await listStatements(pool, { shopId }, request.query as StatementsQuery) };
  });

  app.get("/v1/me/statements/:id", { schema: { params: StatementParams, response: { 200: Statement, ...errors } } }, async (request, reply) => {
    const shopId = await ownerShop(request, reply);
    if (!shopId) return reply;
    // Another shop's statement is reported as missing, so its id says nothing.
    return await statementDetail(pool, (request.params as StatementParams).id, shopId) ?? reply.code(404).send({ error: { code: "NOT_FOUND" } });
  });

  app.get("/v1/admin/statements", { schema: { querystring: AdminStatementsQuery, response: { 200: AdminStatementsResponse, ...errors } } }, async (request, reply) => {
    if (!await adminSignedIn(request, reply, auth)) return reply;
    const { week, ...page } = request.query as AdminStatementsQuery;
    return listStatements(pool, { week }, page);
  });

  app.get("/v1/admin/statements/:id", { schema: { params: StatementParams, response: { 200: Statement, ...errors } } }, async (request, reply) => {
    if (!await adminSignedIn(request, reply, auth)) return reply;
    return await statementDetail(pool, (request.params as StatementParams).id) ?? reply.code(404).send({ error: { code: "NOT_FOUND" } });
  });

  app.get("/v1/admin/shop-balances", { schema: { response: { 200: ShopBalancesResponse, ...errors } } }, async (request, reply) => {
    if (!await adminSignedIn(request, reply, auth)) return reply;
    return { balances: await shopBalances(pool) };
  });
}
