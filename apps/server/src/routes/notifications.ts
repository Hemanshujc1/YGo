import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { APP_NAME_HEADER, AppName, ErrorEnvelope, type Notification, NotificationParams, NotificationsResponse, PushTokenBody, RingAttemptParams } from "@ygo/contracts";
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
    const body = request.body as PushTokenBody;
    await pool.query(
      `INSERT INTO push_tokens (token, session_id, app, platform, updated_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (token) DO UPDATE SET session_id = EXCLUDED.session_id, app = EXCLUDED.app, platform = EXCLUDED.platform, updated_at = EXCLUDED.updated_at`,
      [body.token, who.sessionId, who.app, body.platform ?? null, clock.now()]);
    return (reply as FastifyReply).code(204).send();
  });

  // Acknowledges receipt of a new-order ring attempt on Android (#508); cancels any pending floor push for it.
  app.post("/v1/me/ring-attempts/:id/ack", { schema: { params: RingAttemptParams, response: errors } }, async (request, reply) => {
    const who = await caller(request, reply);
    if (!who) return reply;
    if (who.app !== "shopkeeper") return reply.code(403).send({ error: { code: "FORBIDDEN" } });
    const id = (request.params as RingAttemptParams).id;
    // The caller must be a member of the shop for the order.
    const { rows } = await pool.query<{ orderId: string }>(
      `SELECT a.order_id AS "orderId"
       FROM ring_attempts a
       JOIN orders o ON o.id = a.order_id
       JOIN shop_members m ON m.shop_id = o.shop_id AND m.account_id = $2
       WHERE a.id = $1`, [id, who.accountId]);
    if (rows.length === 0) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    await pool.query("UPDATE ring_attempts SET acknowledged_at = COALESCE(acknowledged_at, $2) WHERE id = $1", [id, clock.now()]);
    await pool.query("DELETE FROM push_queue WHERE ring_attempt_id = $1 AND floor = true", [id]);
    return (reply as FastifyReply).code(204).send();
  });

  app.get("/v1/me/notifications", { schema: { response: { 200: NotificationsResponse, ...errors } } }, async (request, reply) => {
    const who = await caller(request, reply);
    if (!who) return reply;
    // One statement, so the bell's flag and the rows can't disagree; an unread row beyond the 50 still lights it.
    const { rows } = await pool.query<Omit<Notification, "createdAt"> & { createdAt: Date; unread: boolean }>(
      `SELECT id, kind, title, body, order_id AS "orderId", statement_id AS "statementId", created_at AS "createdAt", read_at IS NOT NULL AS read,
         EXISTS (SELECT 1 FROM notifications u WHERE u.account_id = $1 AND u.app = $2 AND u.read_at IS NULL) AS unread
       FROM notifications WHERE account_id = $1 AND app = $2 ORDER BY created_at DESC, id LIMIT ${SHOWN}`, [who.accountId, who.app]);
    return {
      notifications: rows.map(({ id, kind, title, body, orderId, statementId, createdAt, read }) => ({ id, kind, title, body, orderId, statementId, createdAt: createdAt.toISOString(), read })),
      unread: rows[0]?.unread ?? false,
    };
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
