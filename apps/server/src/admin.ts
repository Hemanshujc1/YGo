import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import type { AdminRole } from "@ygo/contracts";
import type { Clock } from "./adapters/clock";
import { withTransaction } from "./db";
import { signedIn, type AuthKeys, type SignedIn } from "./tokens";

/** Everyone who may sign in to the Admin web, with their role (#343). Accounts are created with one; Admin wins if both. */
export const ADMIN_WEB_MEMBERS = `(SELECT account_id, 'admin' AS role FROM admin_memberships
  UNION ALL SELECT account_id, 'area_manager' AS role FROM area_manager_memberships
  WHERE account_id NOT IN (SELECT account_id FROM admin_memberships))`;

/** Check current Admin or Area Manager membership after validating the session. */
export async function adminWebSignedIn(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: { pool: Pool; clock: Clock; keys: AuthKeys },
): Promise<(SignedIn & { role: AdminRole }) | undefined> {
  const who = await signedIn(request, reply, auth);
  if (!who) return undefined;
  const member = await auth.pool.query<{ role: AdminRole }>(
    `SELECT m.role FROM sessions s JOIN ${ADMIN_WEB_MEMBERS} m ON m.account_id = s.account_id
     WHERE s.id = $1 AND s.kind = 'admin_web'`,
    [who.sessionId],
  );
  const role = member.rows[0]?.role;
  if (role) return { ...who, role };
  reply.code(403).send({ error: { code: "FORBIDDEN" } });
  return undefined;
}

/** Check current Admin membership after validating the session on every Admin request. Area Managers are refused. */
export async function adminSignedIn(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: { pool: Pool; clock: Clock; keys: AuthKeys },
): Promise<SignedIn | undefined> {
  const who = await adminWebSignedIn(request, reply, auth);
  if (!who || who.role === "admin") return who;
  reply.code(403).send({ error: { code: "FORBIDDEN" } });
  return undefined;
}

/** Lock current membership for a save; the callback commits, otherwise cleanup rolls back. */
export async function withAdminTransaction<T>(
  pool: Pool,
  accountId: string,
  reply: FastifyReply,
  save: (client: PoolClient) => Promise<T>,
): Promise<T | FastifyReply> {
  return withTransaction(pool, async (client) => {
    const member = await client.query("SELECT 1 FROM admin_memberships WHERE account_id = $1 FOR KEY SHARE", [accountId]);
    if (!member.rowCount) return reply.code(403).send({ error: { code: "FORBIDDEN" } });
    return save(client);
  });
}
