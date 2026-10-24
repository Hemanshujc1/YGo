import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { Account } from "@ygo/contracts";
import type { Clock } from "./adapters/clock";

export const ACCESS_TTL_SECONDS = 15 * 60;
/** A session ends 90 days after its last refresh; each refresh restarts it (#153, Q4). */
export const REFRESH_TTL_MS = 90 * 24 * 60 * 60_000;
/** How long a replaced refresh token is still answered with its successor (#153, Q3). */
export const GRACE_MS = 60_000;

/** One key per job, so a value made for one job never passes for another (#153, Q3). */
export interface AuthKeys {
  access: Buffer;
  loginCode: Buffer;
  refreshHash: Buffer;
  successor: Buffer;
}

export function deriveKeys(secret: string): AuthKeys {
  const derive = (label: string) => Buffer.from(hkdfSync("sha256", secret, "", label, 32));
  return {
    access: derive("ygo access-token v1"),
    loginCode: derive("ygo login-code v1"),
    refreshHash: derive("ygo refresh-hash v1"),
    successor: derive("ygo refresh-successor v1"),
  };
}

export function digest(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

export function sameDigest(expected: string, candidate: string): boolean {
  const left = Buffer.from(expected, "hex");
  const right = Buffer.from(candidate, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The refresh token that replaces `token`, issued at `generation`. It is worked
 * out rather than random, so a retried refresh gets the same answer. Every part
 * is fixed-length: the label, the 16-byte session ID, the 8-byte generation and
 * the 32-byte token.
 */
export function successorToken(keys: AuthKeys, sessionId: string, generation: number, token: string): string {
  const generationBytes = Buffer.alloc(8);
  generationBytes.writeBigUInt64BE(BigInt(generation));
  return createHmac("sha256", keys.successor)
    .update("ygo-refresh-v1")
    .update(Buffer.from(sessionId.replaceAll("-", ""), "hex"))
    .update(generationBytes)
    .update(Buffer.from(token, "base64url"))
    .digest("base64url");
}

export function accessToken(keys: AuthKeys, accountId: string, sessionId: string, now: Date): string {
  const payload = Buffer.from(JSON.stringify({
    sub: accountId,
    sid: sessionId,
    exp: Math.floor(now.getTime() / 1000) + ACCESS_TTL_SECONDS,
  })).toString("base64url");
  return `${payload}.${digest(keys.access, payload)}`;
}

interface Claims {
  sub: string;
  sid: string;
  exp: number;
}

/** The claims of a correctly signed, unexpired access token; otherwise undefined. */
function readAccessToken(keys: AuthKeys, token: string, now: Date): Claims | undefined {
  const dot = token.lastIndexOf(".");
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (dot < 1 || !/^[0-9a-f]{64}$/.test(signature) || !sameDigest(digest(keys.access, payload), signature)) {
    return undefined;
  }
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof claims !== "object" || claims === null) return undefined;
  const { sub, sid, exp, ...rest } = claims as Record<string, unknown>;
  const valid =
    Object.keys(rest).length === 0 &&
    Account.shape.id.safeParse(sub).success &&
    Account.shape.id.safeParse(sid).success &&
    typeof exp === "number" &&
    Number.isSafeInteger(exp) &&
    exp * 1000 > now.getTime();
  return valid ? { sub: sub as string, sid: sid as string, exp } : undefined;
}

export interface SignedIn {
  accountId: string;
  sessionId: string;
}

/**
 * The signed-in check (#153, Q5): a valid access token whose session still
 * exists, hasn't expired and belongs to the token's account. Otherwise it
 * answers 401 UNAUTHENTICATED and returns undefined.
 */
export async function signedIn(
  request: FastifyRequest,
  reply: FastifyReply,
  { pool, clock, keys }: { pool: Pool; clock: Clock; keys: AuthKeys },
): Promise<SignedIn | undefined> {
  const now = clock.now();
  const header = request.headers.authorization;
  const claims = header?.startsWith("Bearer ") ? readAccessToken(keys, header.slice(7), now) : undefined;
  if (claims) {
    const session = await pool.query(
      "SELECT 1 FROM sessions WHERE id = $1 AND account_id = $2 AND expires_at > $3",
      [claims.sid, claims.sub, now],
    );
    if (session.rowCount) return { accountId: claims.sub, sessionId: claims.sid };
  }
  reply.code(401).send({ error: { code: "UNAUTHENTICATED" } });
  return undefined;
}

/** Customer and shared mobile account routes accept only mobile sessions (#246). */
export async function mobileSignedIn(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: { pool: Pool; clock: Clock; keys: AuthKeys },
): Promise<SignedIn | undefined> {
  const who = await signedIn(request, reply, auth);
  if (!who) return undefined;
  const session = await auth.pool.query("SELECT 1 FROM sessions WHERE id = $1 AND kind = 'mobile'", [who.sessionId]);
  if (session.rowCount) return who;
  reply.code(403).send({ error: { code: "FORBIDDEN" } });
  return undefined;
}
