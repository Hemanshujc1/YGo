import { randomInt } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool } from "pg";
import { ErrorEnvelope, InviteStaffBody, JoinShopBody, JoinShopResponse, OrderParams, StaffInviteResponse, StaffInvitesResponse } from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { withTransaction } from "../db";
import { deriveKeys, digest, mobileSignedIn, sameDigest } from "../tokens";
import { ownerShop } from "./shop-agreement";

/** A join code is valid for 24 hours (owner's answer 4 on #58); 5 wrong tries lock the invited number's open codes. */
const CODE_HOURS = 24;
const MAX_FAILED_TRIES = 5;
/** 32 characters with no I, O, 0 or 1, so a code read aloud or off a screen is not mistyped. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");

/**
 * Staff are brought in, joined and removed here (#58). A phone number alone grants nothing (ACC-6): the invited person's
 * account must hold that number and type the one-time code. Deactivating deletes the shop link, so every shop route
 * refuses the person at once (ACC-11); the staff_invites row keeps the account for a re-invite (ACC-7).
 */
export function registerShopStaffRoutes(app: FastifyInstance, { pool, clock, secret }: { pool: Pool; clock: Clock; secret: string }): void {
  const keys = deriveKeys(secret);
  const auth = { pool, clock, keys };
  const errors = { 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope, 429: ErrorEnvelope };

  /** The signed-in Owner's shop, or null once refused: no Owner link 404, shop not yet Approved 409. */
  const owner = async (accountId: string, reply: FastifyReply, client: Pick<Pool, "query">, lock = false) => {
    const shop = await ownerShop(client as Pool, accountId, lock);
    if (!shop) void reply.code(404).send({ error: { code: "NOT_FOUND" } });
    else if (shop.state !== "approved" && shop.state !== "live") void reply.code(409).send({ error: { code: "SHOP_NOT_APPROVED" } });
    else return shop;
    return null;
  };

  app.get("/v1/me/staff-invites", { schema: { response: { 200: StaffInvitesResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const shop = await owner(who.accountId, reply, pool);
    if (!shop) return reply;
    const { rows } = await pool.query(
      `SELECT i.phone, a.name, i.can_deliver AS "canDeliver", i.status, to_char(i.code_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt"
       FROM staff_invites i LEFT JOIN accounts a ON a.id = i.account_id
       WHERE i.shop_id = $1 AND i.status IN ('invited', 'deactivated') ORDER BY i.created_at, i.id`, [shop.id]);
    return { invites: rows };
  });

  // Inviting again re-issues the code: a lost or locked code is replaced, and a deactivated person's link is restored on joining.
  app.post("/v1/me/staff-invites", { schema: { body: InviteStaffBody, response: { 200: StaffInviteResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { phone, canDeliver } = request.body as InviteStaffBody;
    return withTransaction(pool, async (client) => {
      const shop = await owner(who.accountId, reply, client, true);
      if (!shop) return reply;
      const { rows: [linked] } = await client.query<{ shopId: string }>(
        `SELECT m.shop_id AS "shopId" FROM accounts a JOIN shop_members m ON m.account_id = a.id WHERE a.phone = $1`, [phone]);
      if (linked) return reply.code(409).send({ error: { code: linked.shopId === shop.id ? "STAFF_ALREADY_MEMBER" : "STAFF_AT_ANOTHER_SHOP" } });
      const code = newCode();
      const now = clock.now();
      const expiresAt = new Date(now.getTime() + CODE_HOURS * 60 * 60_000);
      await client.query(
        `INSERT INTO staff_invites (shop_id, phone, account_id, can_deliver, status, code_digest, code_expires_at, created_at)
         VALUES ($1, $2, (SELECT id FROM accounts WHERE phone = $2), $3, 'invited', $4, $5, $6)
         ON CONFLICT (shop_id, phone) DO UPDATE SET status = 'invited', can_deliver = EXCLUDED.can_deliver,
           code_digest = EXCLUDED.code_digest, code_expires_at = EXCLUDED.code_expires_at, failed_attempts = 0`,
        [shop.id, phone, canDeliver, digest(keys.staffCode, code), expiresAt, now]);
      await client.query("COMMIT");
      return { code, expiresAt: expiresAt.toISOString() };
    });
  });

  app.post("/v1/me/shop-staff/:id/deactivate", { schema: { params: OrderParams, response: errors } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as OrderParams;
    return withTransaction(pool, async (client) => {
      const shop = await owner(who.accountId, reply, client, true);
      if (!shop) return reply;
      const { rows: [member] } = await client.query<{ canDeliver: boolean }>(
        `DELETE FROM shop_members WHERE account_id = $1 AND shop_id = $2 AND role = 'staff' RETURNING can_deliver AS "canDeliver"`, [id, shop.id]);
      if (!member) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      // Orders already assigned to this person stay assigned; the Owner reassigns them from the order (owner's answer on #58).
      await client.query(
        `INSERT INTO staff_invites (shop_id, phone, account_id, can_deliver, status, created_at)
         SELECT $1, phone, id, $3, 'deactivated', $4 FROM accounts WHERE id = $2 AND phone IS NOT NULL
         ON CONFLICT (shop_id, phone) DO UPDATE SET status = 'deactivated', account_id = EXCLUDED.account_id,
           can_deliver = EXCLUDED.can_deliver, code_digest = NULL, code_expires_at = NULL, failed_attempts = 0`,
        [shop.id, id, member.canDeliver, clock.now()]);
      await client.query("COMMIT");
      return (reply as FastifyReply).code(204).send();
    });
  });

  // The invited person's own account joins with the code (S21). The code must belong to an invitation for the number
  // this account holds, so a code seen by someone else is of no use to them.
  app.post("/v1/me/shop-join", { schema: { body: JoinShopBody, response: { 200: JoinShopResponse, ...errors } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { code } = request.body as JoinShopBody;
    return withTransaction(pool, async (client) => {
      const { rows: [account] } = await client.query<{ phone: string | null; shopId: string | null }>(
        `SELECT a.phone, m.shop_id AS "shopId" FROM accounts a LEFT JOIN shop_members m ON m.account_id = a.id WHERE a.id = $1 FOR UPDATE OF a`, [who.accountId]);
      if (account?.shopId) return reply.code(409).send({ error: { code: "ALREADY_LINKED" } });
      const { rows: open } = account?.phone ? await client.query<{ id: string; shopId: string; canDeliver: boolean; codeDigest: string; expiresAt: Date; failed: number }>(
        `SELECT id, shop_id AS "shopId", can_deliver AS "canDeliver", code_digest AS "codeDigest", code_expires_at AS "expiresAt", failed_attempts AS failed
         FROM staff_invites WHERE phone = $1 AND status = 'invited' FOR UPDATE`, [account.phone]) : { rows: [] };
      if (open.some((invite) => invite.failed >= MAX_FAILED_TRIES)) return reply.code(429).send({ error: { code: "CODE_LOCKED" } });
      const match = open.find((invite) => sameDigest(invite.codeDigest, digest(keys.staffCode, code)));
      if (!match) {
        if (open.length) await client.query("UPDATE staff_invites SET failed_attempts = failed_attempts + 1 WHERE id = ANY($1)", [open.map((invite) => invite.id)]);
        await client.query("COMMIT");
        return reply.code(400).send({ error: { code: "CODE_WRONG" } });
      }
      if (match.expiresAt <= clock.now()) return reply.code(400).send({ error: { code: "CODE_EXPIRED" } });
      await client.query("INSERT INTO shop_members (account_id, shop_id, role, can_deliver) VALUES ($1, $2, 'staff', $3)", [who.accountId, match.shopId, match.canDeliver]);
      await client.query(
        "UPDATE staff_invites SET status = 'active', account_id = $2, code_digest = NULL, code_expires_at = NULL, failed_attempts = 0 WHERE id = $1", [match.id, who.accountId]);
      const { rows: [shop] } = await client.query<{ shopName: string | null }>('SELECT shop_name AS "shopName" FROM shops WHERE id = $1', [match.shopId]);
      await client.query("COMMIT");
      return { shopName: shop?.shopName ?? null };
    });
  });
}
