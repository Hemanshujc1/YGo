import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import {
  ADMIN_REFRESH_HEADER,
  Email,
  IdentityChallenge,
  IdentityChallengeBody,
  IdentitySignInResponse,
  VerifyIdentityBody,
  ErrorEnvelope,
  BrowserSession,
  type ErrorCode,
  RefreshBody,
  RequestCodeBody,
  Session,
  VerifyCodeBody,
  type Account,
} from "@ygo/contracts";
import type { IdentityVerifier } from "../adapters/identity-verifier";
import type { Clock } from "../adapters/clock";
import type { Mailer } from "../adapters/mailer";
import {
  GRACE_MS,
  REFRESH_TTL_MS,
  accessToken,
  deriveKeys,
  digest,
  sameDigest,
  mobileSignedIn,
  successorToken,
} from "../tokens";

const CODE_TTL_MS = 5 * 60_000;
const LOCK_MS = 15 * 60_000;
const MIN_SEND_INTERVAL_MS = 30_000;
const SEND_WINDOW_MS = 60 * 60_000;
const ADMIN_IDLE_MS = 30 * 60_000;
const ADMIN_COOKIE = "__Secure-ygo-admin-refresh";

interface AuthOptions {
  pool: Pool;
  mailer: Mailer;
  identityVerifier?: IdentityVerifier;
  clock: Clock;
  secret: string;
  adminCookieDomain?: string;
}

type AuthApp = FastifyInstance;

async function lockKey(client: PoolClient, key: string, namespace: number): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [key, namespace]);
}

function sendError(reply: FastifyReply, status: 400 | 401 | 429 | 503, code: ErrorCode) {
  return reply.code(status).send({ error: { code } });
}

function adminCookie(token: string, domain?: string): string {
  return `${ADMIN_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/v1/admin/auth; Max-Age=${token ? 1800 : 0}${domain ? `; Domain=${domain}` : ""}`;
}

function cookieToken(request: FastifyRequest): string | undefined {
  return request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${ADMIN_COOKIE}=`))?.slice(ADMIN_COOKIE.length + 1);
}

function rateLimitAddress(address: string): string {
  const raw = address.split("%")[0] ?? address;
  if (isIP(raw) === 4) return raw;
  const mappedV4 = /^::ffff:(.+)$/i.exec(raw)?.[1];
  if (mappedV4 && isIP(mappedV4) === 4) return mappedV4;
  const [before, after] = raw.toLowerCase().split("::");
  const left = before ? before.split(":") : [];
  const right = after ? after.split(":") : [];
  const tail = right.length ? right : left;
  const dotted = tail.at(-1)?.includes(".") ? tail.pop() : undefined;
  if (dotted) {
    const octets = dotted.split(".").map(Number);
    tail.push(((octets[0] ?? 0) << 8 | (octets[1] ?? 0)).toString(16));
    tail.push(((octets[2] ?? 0) << 8 | (octets[3] ?? 0)).toString(16));
  }
  const groups = [...left, ...right];
  const expanded = raw.includes("::")
    ? [...left, ...Array(Math.max(0, 8 - groups.length)).fill("0"), ...right]
    : groups;
  return `${expanded.slice(0, 4).map((group) => group.padStart(4, "0")).join(":")}/64`;
}

export function registerAuthRoutes(app: AuthApp, { pool, mailer, clock, secret, adminCookieDomain, identityVerifier }: AuthOptions): void {
  const keys = deriveKeys(secret);
  const setAdminCookie = (reply: FastifyReply, token: string) => reply.header("set-cookie", adminCookie(token, adminCookieDomain));
  async function issueSession(client: PoolClient, account: Account, now: Date, browser: boolean) {
    const sessionId = randomUUID();
    const refreshToken = randomBytes(32).toString("base64url");
    await client.query(
      "INSERT INTO sessions (id, account_id, expires_at, kind) VALUES ($1, $2, $3, $4)",
      [sessionId, account.id, new Date(now.getTime() + (browser ? ADMIN_IDLE_MS : REFRESH_TTL_MS)), browser ? "admin_web" : "mobile"],
    );
    await client.query(
      "INSERT INTO refresh_tokens (token_hash, session_id, generation) VALUES ($1, $2, 0)",
      [digest(keys.refreshHash, refreshToken), sessionId],
    );
    return { accessToken: accessToken(keys, account.id, sessionId, now), refreshToken };
  }

  app.post("/v1/auth/identity/challenge", {
    schema: { body: IdentityChallengeBody, response: { 200: IdentityChallenge, 429: ErrorEnvelope, 503: ErrorEnvelope } },
  }, async (request, reply) => {
    if (!identityVerifier) return sendError(reply, 503, "UNAVAILABLE");
    const { provider } = request.body as typeof IdentityChallengeBody._output;
    const now = clock.now();
    const address = rateLimitAddress(request.ip);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockKey(client, address, 3);
      await client.query("DELETE FROM identity_challenges WHERE expires_at <= $1", [now]);
      const count = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM identity_challenges WHERE address = $1", [address]);
      if ((count.rows[0]?.count ?? 0) >= 30) {
        await client.query("ROLLBACK");
        return sendError(reply, 429, "TOO_MANY_REQUESTS");
      }
      const nonce = randomBytes(32).toString("hex");
      await client.query("INSERT INTO identity_challenges (nonce, provider, address, expires_at) VALUES ($1, $2, $3, $4)",
        [nonce, provider, address, new Date(now.getTime() + CODE_TTL_MS)]);
      await client.query("COMMIT");
      return { nonce };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  });

  app.post("/v1/auth/identity", {
    schema: { body: VerifyIdentityBody, response: { 200: IdentitySignInResponse, 401: ErrorEnvelope, 503: ErrorEnvelope } },
  }, async (request, reply) => {
    if (!identityVerifier) return sendError(reply, 503, "UNAVAILABLE");
    const { provider, identityToken, nonce } = request.body as VerifyIdentityBody;
    // Consume before verification: failures cannot be retried to probe the verifier.
    const challenge = await pool.query(
      "UPDATE identity_challenges SET used = true WHERE nonce = $1 AND provider = $2 AND NOT used AND expires_at > $3 RETURNING nonce",
      [nonce, provider, clock.now()],
    );
    if (!challenge.rowCount) return sendError(reply, 401, "UNAUTHENTICATED");
    let identity;
    try { identity = await identityVerifier.verify(provider, identityToken, nonce); }
    catch { return sendError(reply, 503, "UNAVAILABLE"); }
    const email = Email.safeParse(identity?.email);
    if (!identity || !email.success) return sendError(reply, 401, "UNAUTHENTICATED");
    if (identity.emailCodeRequired) return { emailVerificationRequired: email.data };
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockKey(client, email.data, 1);
      const result = await client.query<Account>(
        `INSERT INTO accounts (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
         RETURNING id, email, name, phone, theme`, [email.data],
      );
      const account = result.rows[0];
      if (!account) throw new Error("Account insert returned no row");
      const signed = await issueSession(client, account, clock.now(), false);
      await client.query("COMMIT");
      request.log.info({ provider, outcome: "signed_in" }, "Auth identity");
      return { ...signed, account };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  });

  const requestCode = (browser: boolean) => async (request: FastifyRequest, reply: FastifyReply) => {
      request.log.info({ flow: browser ? "admin" : "mobile", stage: "code" }, "Auth attempt");
      const { email } = request.body as typeof RequestCodeBody._output;
      const now = clock.now();
      const address = rateLimitAddress(request.ip);
      const reservationId = randomUUID();
      const client = await pool.connect();
      let clientReleased = false;
      try {
        await client.query("BEGIN");
        await lockKey(client, email, 1);
        await lockKey(client, address, 2);
        const current = await client.query<{ locked_until: Date | null; code_hash: string; expires_at: Date }>(
          "SELECT locked_until, code_hash, expires_at FROM login_codes WHERE email = $1",
          [email],
        );
        if (current.rows[0]?.locked_until && current.rows[0].locked_until > now) {
          await client.query("ROLLBACK");
          return sendError(reply, 429, "CODE_LOCKED");
        }
        await client.query("DELETE FROM login_code_history WHERE email = $1 AND expires_at <= $2", [email, now]);
        await client.query(
          "DELETE FROM email_code_sends WHERE (email = $1 OR address = $2) AND sent_at <= $3",
          [email, address, new Date(now.getTime() - SEND_WINDOW_MS)],
        );
        const counts = await client.query<{ email_count: string; address_count: string; last_sent: Date | null }>(
          `SELECT
             count(*) FILTER (WHERE email = $1)::text AS email_count,
             count(*) FILTER (WHERE address = $2)::text AS address_count,
             max(sent_at) FILTER (WHERE email = $1) AS last_sent
           FROM email_code_sends
           WHERE sent_at > $3 AND (email = $1 OR address = $2)`,
          [email, address, new Date(now.getTime() - SEND_WINDOW_MS)],
        );
        const limit = counts.rows[0];
        if (!limit) throw new Error("Send limit query returned no row");
        const { email_count, address_count, last_sent } = limit;
        if (last_sent && now.getTime() - last_sent.getTime() < MIN_SEND_INTERVAL_MS) {
          await client.query("ROLLBACK");
          return sendError(reply, 429, "TOO_MANY_REQUESTS");
        }
        if (Number(email_count) >= 5 || Number(address_count) >= 20) {
          await client.query("ROLLBACK");
          return sendError(reply, 429, "TOO_MANY_REQUESTS");
        }

        const code = randomInt(1_000_000).toString().padStart(6, "0");
        const mailText = `Your YGo sign-in code is ${code}. It expires in 5 minutes. If you didn't ask for it, you can ignore this email.`;
        await client.query(
          "INSERT INTO email_code_sends (id, email, address, sent_at) VALUES ($1, $2, $3, $4)",
          [reservationId, email, address, now],
        );
        await client.query("COMMIT");
        client.release();
        clientReleased = true;
        if (browser) {
          const member = await pool.query(
            "SELECT 1 FROM accounts a JOIN admin_memberships m ON m.account_id = a.id WHERE a.email = $1",
            [email],
          );
          if (!member.rowCount) {
            request.log.info({ flow: "admin", outcome: "no_membership" }, "Auth code request");
            return reply.code(204).send();
          }
        }
        try {
          await mailer.send({
            to: email,
            subject: "Your YGo sign-in code",
            text: mailText,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown mailer error";
          const safeMessage = message.split(mailText).join("[redacted]").split(email).join("[redacted]").split(code).join("[redacted]");
          request.log.error({ err: { name: error instanceof Error ? error.name : "Error", message: safeMessage } }, "Email sign-in code delivery failed");
          const failedClient = await pool.connect();
          try {
            await failedClient.query("BEGIN");
            await failedClient.query("DELETE FROM email_code_sends WHERE id = $1", [reservationId]);
            await failedClient.query("COMMIT");
          } catch (deleteError) {
            await failedClient.query("ROLLBACK");
            throw deleteError;
          } finally {
            failedClient.release();
          }
          if (browser) return reply.code(204).send();
          return sendError(reply, 503, "UNAVAILABLE");
        }
        const activateClient = await pool.connect();
        try {
          await activateClient.query("BEGIN");
          await lockKey(activateClient, email, 1);
          const latest = await activateClient.query<{ code_hash: string; expires_at: Date }>(
            "SELECT code_hash, expires_at FROM login_codes WHERE email = $1 FOR UPDATE",
            [email],
          );
          if (latest.rows[0] && latest.rows[0].expires_at > now) {
            await activateClient.query(
              "INSERT INTO login_code_history (email, code_hash, expires_at) VALUES ($1, $2, $3)",
              [email, latest.rows[0].code_hash, latest.rows[0].expires_at],
            );
          }
          await activateClient.query(
          `INSERT INTO login_codes (email, code_hash, expires_at, wrong_tries, locked_until)
           VALUES ($1, $2, $3, 0, NULL)
           ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash,
             expires_at = EXCLUDED.expires_at,
             wrong_tries = CASE
               WHEN login_codes.locked_until > $4 THEN login_codes.wrong_tries
               WHEN login_codes.expires_at <= $4 THEN 0
               ELSE login_codes.wrong_tries
             END,
             locked_until = CASE WHEN login_codes.locked_until > $4 THEN login_codes.locked_until ELSE NULL END`,
            [email, digest(keys.loginCode, code), new Date(now.getTime() + CODE_TTL_MS), now],
          );
          await activateClient.query("COMMIT");
        } catch (error) {
          await activateClient.query("ROLLBACK");
          throw error;
        } finally {
          activateClient.release();
        }
        request.log.info({ flow: browser ? "admin" : "mobile", outcome: "code_sent" }, "Auth code request");
        return reply.code(204).send();
      } catch (error) {
        if (!clientReleased) await client.query("ROLLBACK");
        throw error;
      } finally {
        if (!clientReleased) client.release();
      }
  };
  const codeSchema = { body: RequestCodeBody, response: { 400: ErrorEnvelope, 429: ErrorEnvelope, 503: ErrorEnvelope } };
  app.post("/v1/auth/code", { schema: codeSchema }, requestCode(false));
  app.post("/v1/admin/auth/code", { schema: codeSchema }, requestCode(true));

  const verifyCode = (browser: boolean) => async (request: FastifyRequest, reply: FastifyReply) => {
      request.log.info({ flow: browser ? "admin" : "mobile", stage: "verify" }, "Auth attempt");
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
        const codeHash = digest(keys.loginCode, code);
        if (!sameDigest(login.code_hash, codeHash)) {
          const oldCodes = await client.query<{ code_hash: string }>(
            "SELECT code_hash FROM login_code_history WHERE email = $1 AND expires_at > $2",
            [email, now],
          );
          let replaced = false;
          for (const old of oldCodes.rows) replaced = sameDigest(old.code_hash, codeHash) || replaced;
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

        const accountResult = browser
          ? await client.query<Account>(
              `SELECT a.id, a.email, a.name, a.phone, a.theme FROM accounts a
               JOIN admin_memberships m ON m.account_id = a.id WHERE a.email = $1`,
              [email],
            )
          : await client.query<Account>(
              `INSERT INTO accounts (email) VALUES ($1)
               ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
               RETURNING id, email, name, phone, theme`,
              [email],
            );
        const account = accountResult.rows[0];
        if (browser && !account) {
          await client.query("ROLLBACK");
          return sendError(reply, 401, "UNAUTHENTICATED");
        }
        if (!account) throw new Error("Account insert returned no row");
        const signed = await issueSession(client, account, now, browser);
        await client.query("DELETE FROM login_codes WHERE email = $1", [email]);
        await client.query("COMMIT");
        request.log.info({ flow: browser ? "admin" : "mobile", outcome: "signed_in" }, "Auth verify");
        if (browser) {
          setAdminCookie(reply, signed.refreshToken);
          return reply.code(200).send({ accessToken: signed.accessToken, account });
        }
        return reply.code(200).send({ ...signed, account });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
  };
  app.post("/v1/auth/verify", { schema: { body: VerifyCodeBody, response: { 200: Session, 400: ErrorEnvelope, 429: ErrorEnvelope, 503: ErrorEnvelope } } }, verifyCode(false));
  app.post("/v1/admin/auth/verify", { schema: { body: VerifyCodeBody, response: { 200: BrowserSession, 400: ErrorEnvelope, 401: ErrorEnvelope, 429: ErrorEnvelope } } }, verifyCode(true));

  const refresh = (browser: boolean) => async (request: FastifyRequest, reply: FastifyReply) => {
      request.log.info({ flow: browser ? "admin" : "mobile", stage: "refresh" }, "Auth attempt");
      if (browser && request.headers[ADMIN_REFRESH_HEADER] !== "1") {
        return reply.code(403).send({ error: { code: "FORBIDDEN" } });
      }
      const refreshToken = browser ? cookieToken(request) : (request.body as typeof RefreshBody._output).refreshToken;
      if (!refreshToken || refreshToken.length > 512) return sendError(reply, 401, "UNAUTHENTICATED");
      const now = clock.now();
      const hash = digest(keys.refreshHash, refreshToken);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // An unknown token, fabricated or never issued, changes nothing (#153, Q3).
        const found = await client.query<{ session_id: string }>(
          "SELECT session_id FROM refresh_tokens WHERE token_hash = $1",
          [hash],
        );
        const sessionId = found.rows[0]?.session_id;
        // Concurrent refreshes of one session run one at a time from here.
        const session = sessionId
          ? (await client.query<{ account_id: string; expires_at: Date; kind: string }>(
              "SELECT account_id, expires_at, kind FROM sessions WHERE id = $1 FOR UPDATE",
              [sessionId],
            )).rows[0]
          : undefined;
        // Read again under the lock: a refresh that held it may have replaced this token.
        const token = session
          ? (await client.query<{ generation: number; replaced_at: Date | null }>(
              "SELECT generation, replaced_at FROM refresh_tokens WHERE token_hash = $1",
              [hash],
            )).rows[0]
          : undefined;
        if (browser && sessionId && session?.kind === "admin_web" && session.expires_at <= now) {
          await client.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
          await client.query("COMMIT");
          setAdminCookie(reply, "");
          return sendError(reply, 401, "UNAUTHENTICATED");
        }
        if (!sessionId || !session || !token || session.expires_at <= now) {
          await client.query("ROLLBACK");
          return sendError(reply, 401, "UNAUTHENTICATED");
        }
        if (session.kind !== (browser ? "admin_web" : "mobile")) {
          await client.query("ROLLBACK");
          return reply.code(403).send({ error: { code: "FORBIDDEN" } });
        }
        if (browser) {
          const member = await client.query("SELECT 1 FROM admin_memberships WHERE account_id = $1", [session.account_id]);
          if (!member.rowCount) {
            await client.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
            await client.query("COMMIT");
            setAdminCookie(reply, "");
            return reply.code(403).send({ error: { code: "FORBIDDEN" } });
          }
        }

        const generation = token.generation + 1;
        const next = successorToken(keys, sessionId, generation, refreshToken);
        if (token.replaced_at === null) {
          await client.query("UPDATE refresh_tokens SET replaced_at = $2 WHERE token_hash = $1", [hash, now]);
          await client.query(
            "INSERT INTO refresh_tokens (token_hash, session_id, generation) VALUES ($1, $2, $3)",
            [digest(keys.refreshHash, next), sessionId, generation],
          );
          await client.query("UPDATE sessions SET expires_at = $2 WHERE id = $1", [
            sessionId,
            new Date(now.getTime() + (browser ? ADMIN_IDLE_MS : REFRESH_TTL_MS)),
          ]);
        } else if (now.getTime() - token.replaced_at.getTime() > GRACE_MS) {
          // A replaced token used after the grace window may have been stolen.
          await client.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
          await client.query("COMMIT");
          return sendError(reply, 401, "UNAUTHENTICATED");
        } else {
          // A retry within the window gets the same successor, if it is still current.
          const current = await client.query(
            `SELECT 1 FROM refresh_tokens
             WHERE token_hash = $1 AND session_id = $2 AND generation = $3 AND replaced_at IS NULL`,
            [digest(keys.refreshHash, next), sessionId, generation],
          );
          if (!current.rowCount) {
            await client.query("ROLLBACK");
            return sendError(reply, 401, "UNAUTHENTICATED");
          }
        }
        const accountResult = await client.query<Account>(
          "SELECT id, email, name, phone, theme FROM accounts WHERE id = $1",
          [session.account_id],
        );
        const account = accountResult.rows[0];
        if (!account) throw new Error("Session has no account");
        await client.query("COMMIT");
        request.log.info({ flow: browser ? "admin" : "mobile", outcome: "refreshed" }, "Auth refresh");
        if (browser) {
          setAdminCookie(reply, next);
          return reply.code(200).send({ accessToken: accessToken(keys, account.id, sessionId, now), account });
        }
        return reply.code(200).send({ accessToken: accessToken(keys, account.id, sessionId, now), refreshToken: next, account });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
  };
  app.post("/v1/auth/refresh", { schema: { body: RefreshBody, response: { 200: Session, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope } } }, refresh(false));
  app.post("/v1/admin/auth/refresh", { schema: { response: { 200: BrowserSession, 401: ErrorEnvelope, 403: ErrorEnvelope } } }, refresh(true));

  app.post(
    "/v1/admin/auth/sign-out",
    { schema: { response: { 401: ErrorEnvelope, 403: ErrorEnvelope } } },
    async (request, reply) => {
      if (request.headers[ADMIN_REFRESH_HEADER] !== "1") return reply.code(403).send({ error: { code: "FORBIDDEN" } });
      const token = cookieToken(request);
      if (!token || token.length > 512) return sendError(reply, 401, "UNAUTHENTICATED");
      const found = await pool.query<{ session_id: string }>(
        `SELECT r.session_id FROM refresh_tokens r JOIN sessions s ON s.id = r.session_id
         WHERE r.token_hash = $1 AND s.kind = 'admin_web'`,
        [digest(keys.refreshHash, token)],
      );
      const sessionId = found.rows[0]?.session_id;
      if (!sessionId) return sendError(reply, 401, "UNAUTHENTICATED");
      await pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
      setAdminCookie(reply, "");
      request.log.info({ flow: "admin", outcome: "signed_out" }, "Auth sign-out");
      return (reply as FastifyReply).code(204).send();
    },
  );

  app.post(
    "/v1/auth/sign-out",
    { schema: { response: { 401: ErrorEnvelope, 403: ErrorEnvelope } } },
    async (request, reply) => {
      const who = await mobileSignedIn(request, reply, { pool, clock, keys });
      if (!who) return reply;
      await pool.query("DELETE FROM sessions WHERE id = $1", [who.sessionId]);
      return (reply as FastifyReply).code(204).send();
    },
  );
}
