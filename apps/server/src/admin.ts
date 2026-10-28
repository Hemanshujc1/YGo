import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import type { AdminRole } from "@ygo/contracts";
import type { Clock } from "./adapters/clock";
import { withTransaction } from "./db";
import { signedIn, type AuthKeys, type SignedIn } from "./tokens";

/** Everyone who may sign in to the Admin web, with their role (#343). The database allows an account only one (migration 0021). */
export const ADMIN_WEB_MEMBERS = `(SELECT account_id, 'admin' AS role FROM admin_memberships
  UNION ALL SELECT account_id, 'area_manager' AS role FROM area_manager_memberships)`;

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

/**
 * Lock current Admin membership for a save; the callback commits, otherwise cleanup rolls back.
 * Admin only: it locks `admin_memberships`, so an Area Manager always gets 403 here (#343).
 * A route that Area Managers may also use (#299) needs its own check and lock on
 * `area_manager_memberships`, with the shop-assignment test inside the same transaction.
 */
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
