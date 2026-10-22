import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import type { Clock } from "./adapters/clock";
import { signedIn, type AuthKeys, type SignedIn } from "./tokens";

/** Check current membership after validating the session on every Admin request. */
export async function adminSignedIn(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: { pool: Pool; clock: Clock; keys: AuthKeys },
): Promise<SignedIn | undefined> {
  const who = await signedIn(request, reply, auth);
  if (!who) return undefined;
  const session = await auth.pool.query("SELECT 1 FROM sessions WHERE id = $1 AND kind = 'admin_web'", [who.sessionId]);
  if (!session.rowCount) {
    reply.code(403).send({ error: { code: "FORBIDDEN" } });
    return undefined;
  }
  const membership = await auth.pool.query("SELECT 1 FROM admin_memberships WHERE account_id = $1", [who.accountId]);
  if (membership.rowCount) return who;
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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const member = await client.query("SELECT 1 FROM admin_memberships WHERE account_id = $1 FOR KEY SHARE", [accountId]);
    if (!member.rowCount) return reply.code(403).send({ error: { code: "FORBIDDEN" } });
    return await save(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}
