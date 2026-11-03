import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { APP_NAME_HEADER, AppName, ErrorEnvelope, type Notification, NotificationParams, NotificationsResponse, PushTokenBody } from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { deriveKeys, mobileSignedIn } from "../tokens";

/** C22 and S41 show this many, newest first, with no paging yet (owner's answer 6 on #55). */
const SHOWN = 50;

/**
 * The phone's token and the C22/S41 lists (#505). Each belongs to the app that calls, from its app header, so an
 * account signed in to both apps hears customer news in one and shop news in the other.
 */
export function registerNotificationRoutes(app: FastifyInstance, { pool, clock, secret }: { pool: Pool; clock: Clock; secret: string }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const errors = { 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope };

  /** The signed-in mobile caller and its app, or undefined once the reply is sent. */
  const caller = async (request: FastifyRequest, reply: FastifyReply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return undefined;
    const name = AppName.safeParse(request.headers[APP_NAME_HEADER]);
    if (name.success) return { ...who, app: name.data };
    reply.code(400).send({ error: { code: "VALIDATION_FAILED" } });
    return undefined;
  };

  // Sent after sign-in and at each app start; a token sent again moves to this session (owner's answer 9 on #55).
  app.put("/v1/me/push-token", { schema: { body: PushTokenBody, response: errors } }, async (request, reply) => {
    const who = await caller(request, reply);
    if (!who) return reply;
    await pool.query(
      `INSERT INTO push_tokens (token, session_id, app, updated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (token) DO UPDATE SET session_id = EXCLUDED.session_id, app = EXCLUDED.app, updated_at = EXCLUDED.updated_at`,
      [(request.body as PushTokenBody).token, who.sessionId, who.app, clock.now()]);
    return (reply as FastifyReply).code(204).send();
  });

  app.get("/v1/me/notifications", { schema: { response: { 200: NotificationsResponse, ...errors } } }, async (request, reply) => {
    const who = await caller(request, reply);
    if (!who) return reply;
    const { rows } = await pool.query<Omit<Notification, "createdAt"> & { createdAt: Date }>(
      `SELECT id, kind, title, body, order_id AS "orderId", created_at AS "createdAt", read_at IS NOT NULL AS read
       FROM notifications WHERE account_id = $1 AND app = $2 ORDER BY created_at DESC, id LIMIT ${SHOWN}`, [who.accountId, who.app]);
    const { rows: [unread] } = await pool.query<{ any: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM notifications WHERE account_id = $1 AND app = $2 AND read_at IS NULL) AS any", [who.accountId, who.app]);
    return { notifications: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })), unread: unread?.any ?? false };
  });

  // A tap reads one (owner's answer 5 on #55); reading it again changes nothing.
  app.post("/v1/me/notifications/:id/read", { schema: { params: NotificationParams, response: errors } }, async (request, reply) => {
    const who = await caller(request, reply);
    if (!who) return reply;
    const { rowCount } = await pool.query(
      "UPDATE notifications SET read_at = COALESCE(read_at, $3) WHERE id = $1 AND account_id = $2 AND app = $4",
      [(request.params as NotificationParams).id, who.accountId, clock.now(), who.app]);
    return rowCount ? (reply as FastifyReply).code(204).send() : reply.code(404).send({ error: { code: "NOT_FOUND" } });
  });

  app.post("/v1/me/notifications/read-all", { schema: { response: errors } }, async (request, reply) => {
    const who = await caller(request, reply);
    if (!who) return reply;
    await pool.query("UPDATE notifications SET read_at = $3 WHERE account_id = $1 AND app = $2 AND read_at IS NULL", [who.accountId, who.app, clock.now()]);
    return (reply as FastifyReply).code(204).send();
  });
}
