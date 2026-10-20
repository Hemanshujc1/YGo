import { createHmac, randomBytes, randomInt, timingSafeEqual, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool, PoolClient } from "pg";
import {
  ErrorEnvelope,
  type ErrorCode,
  RequestCodeBody,
  Session,
  VerifyCodeBody,
  type Account,
} from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import type { Mailer } from "../adapters/mailer";

const CODE_TTL_MS = 5 * 60_000;
const LOCK_MS = 15 * 60_000;
const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_MS = 90 * 24 * 60 * 60_000;

interface AuthOptions {
  pool: Pool;
  mailer: Mailer;
  clock: Clock;
  secret: string;
}

type AuthApp = FastifyInstance;

function digest(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function sameDigest(expected: string, candidate: string): boolean {
  const left = Buffer.from(expected, "hex");
  const right = Buffer.from(candidate, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function accessToken(secret: string, accountId: string, sessionId: string, now: Date): string {
  const payload = Buffer.from(JSON.stringify({
    sub: accountId,
    sid: sessionId,
    exp: Math.floor(now.getTime() / 1000) + ACCESS_TTL_SECONDS,
  })).toString("base64url");
  return `${payload}.${digest(secret, payload)}`;
}

async function lockKey(client: PoolClient, key: string, namespace: number): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [key, namespace]);
}

function sendError(reply: FastifyReply, status: 400 | 429 | 503, code: ErrorCode) {
  return reply.code(status).send({ error: { code } });
}

export function registerAuthRoutes(app: AuthApp, { pool, mailer, clock, secret }: AuthOptions): void {
  app.post(
    "/v1/auth/code",
    { schema: { body: RequestCodeBody, response: { 400: ErrorEnvelope, 429: ErrorEnvelope, 503: ErrorEnvelope } } },
    async (request, reply) => {
      const { email } = request.body as typeof RequestCodeBody._output;
      const now = clock.now();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await lockKey(client, email, 1);
        const current = await client.query<{ locked_until: Date | null; code_hash: string; expires_at: Date }>(
          "SELECT locked_until, code_hash, expires_at FROM login_codes WHERE email = $1",
          [email],
        );
        if (current.rows[0]?.locked_until && current.rows[0].locked_until > now) {
          await client.query("ROLLBACK");
          return sendError(reply, 429, "CODE_LOCKED");
        }
        await client.query("DELETE FROM login_code_history WHERE expires_at <= $1", [now]);

        const code = randomInt(1_000_000).toString().padStart(6, "0");
        try {
          await mailer.send({
            to: email,
            subject: "Your YGo sign-in code",
            text: `Your YGo sign-in code is ${code}. It expires in 5 minutes. If you didn't ask for it, you can ignore this email.`,
          });
        } catch {
          await client.query("ROLLBACK");
          return sendError(reply, 503, "UNAVAILABLE");
        }
        if (current.rows[0] && current.rows[0].expires_at > now) {
          await client.query(
            "INSERT INTO login_code_history (email, code_hash, expires_at) VALUES ($1, $2, $3)",
            [email, current.rows[0].code_hash, current.rows[0].expires_at],
          );
        }
        await client.query(
          `INSERT INTO login_codes (email, code_hash, expires_at, wrong_tries, locked_until)
           VALUES ($1, $2, $3, 0, NULL)
           ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash,
             expires_at = EXCLUDED.expires_at,
             wrong_tries = CASE WHEN login_codes.locked_until IS NOT NULL THEN 0 ELSE login_codes.wrong_tries END,
             locked_until = NULL`,
          [email, digest(secret, code), new Date(now.getTime() + CODE_TTL_MS)],
        );
        await client.query("COMMIT");
        return (reply as FastifyReply).code(204).send();
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.post(
    "/v1/auth/verify",
    { schema: { body: VerifyCodeBody, response: { 200: Session, 400: ErrorEnvelope, 429: ErrorEnvelope, 503: ErrorEnvelope } } },
    async (request, reply) => {
      const { email, code } = request.body as typeof VerifyCodeBody._output;
      const now = clock.now();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await lockKey(client, email, 1);
        const result = await client.query<{
          code_hash: string;
          expires_at: Date;
          wrong_tries: number;
          locked_until: Date | null;
        }>("SELECT * FROM login_codes WHERE email = $1 FOR UPDATE", [email]);
        const login = result.rows[0];
        if (login?.locked_until && login.locked_until > now) {
          await client.query("ROLLBACK");
          return sendError(reply, 429, "CODE_LOCKED");
        }
        if (!login || login.expires_at <= now) {
          await client.query("ROLLBACK");
          return sendError(reply, 400, "CODE_EXPIRED");
        }
        if (!sameDigest(login.code_hash, digest(secret, code))) {
          const oldCodes = await client.query<{ code_hash: string }>(
            "SELECT code_hash FROM login_code_history WHERE email = $1 AND expires_at > $2",
            [email, now],
          );
          let replaced = false;
          for (const old of oldCodes.rows) replaced = sameDigest(old.code_hash, digest(secret, code)) || replaced;
          if (replaced) {
            await client.query("ROLLBACK");
            return sendError(reply, 400, "CODE_EXPIRED");
          }
          const tries = login.wrong_tries + 1;
          if (tries >= 5) {
            await client.query("UPDATE login_codes SET wrong_tries = $2, locked_until = $3 WHERE email = $1", [email, tries, new Date(now.getTime() + LOCK_MS)]);
            await client.query("COMMIT");
            return sendError(reply, 429, "CODE_LOCKED");
          }
          await client.query("UPDATE login_codes SET wrong_tries = $2 WHERE email = $1", [email, tries]);
          await client.query("COMMIT");
          return sendError(reply, 400, "CODE_WRONG");
        }

        const accountResult = await client.query<Account>(
          `INSERT INTO accounts (email) VALUES ($1)
           ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
           RETURNING id, email, name, phone`,
          [email],
        );
        const account = accountResult.rows[0];
        if (!account) throw new Error("Account insert returned no row");
        const sessionId = randomUUID();
        const refreshToken = randomBytes(32).toString("base64url");
        await client.query(
          "INSERT INTO sessions (id, account_id, refresh_token_hash, expires_at) VALUES ($1, $2, $3, $4)",
          [sessionId, account.id, digest(secret, refreshToken), new Date(now.getTime() + REFRESH_TTL_MS)],
        );
        await client.query("DELETE FROM login_codes WHERE email = $1", [email]);
        await client.query("COMMIT");
        return reply.code(200).send({
          accessToken: accessToken(secret, account.id, sessionId, now),
          refreshToken,
          account,
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );
}
