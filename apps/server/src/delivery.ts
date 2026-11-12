import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";

export const HANDOVER_CODE_MAX_ATTEMPTS = 6;
export const HANDOVER_CODE_ATTEMPTS_BEFORE_COOLDOWN = 3;
export const HANDOVER_CODE_COOLDOWN_MS = 2 * 60_000;
export const ITEMS_CHECK_SECONDS = 60;

type SavedCode = { salt: string; hash: string; ciphertext: string };

export function createHandoverCode(secret: string): SavedCode & { code: string } {
  const code = String(randomInt(0, 10_000)).padStart(4, "0");
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(code, salt, 32).toString("base64url");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv);
  const ciphertext = Buffer.concat([cipher.update(code, "utf8"), cipher.final()]);
  const encrypted = [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
  return { code, salt, hash, ciphertext: encrypted };
}

export function revealHandoverCode(secret: string, encrypted: string): string {
  const [ivText, tagText, bodyText] = encrypted.split(".");
  if (!ivText || !tagText || !bodyText) throw new Error("Invalid handover code ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(bodyText, "base64url")), decipher.final()]).toString("utf8");
}

/** An order's saved code and what has been tried against it. */
export type HandoverCodeState = { id: string; handoverCodeHash: string | null; handoverCodeSalt: string | null; handoverCodeAttempts: number; handoverCodeBlockedUntil: Date | null };

/**
 * Checks the Customer's 4-digit code against the order's, counting each miss (DLV-2: 3 tries, then a cooldown, then 6 in all). Returns undefined when it matches, else the refusal.
 * A refusal has already written its count and committed it, so it stays when the caller's transaction ends; the caller returns the code at once.
 * An order accepted before codes existed gets one made now and counts nothing against the shop.
 */
export async function checkHandoverCode(client: PoolClient, order: HandoverCodeState, code: string, now: Date, secret: string): Promise<"HANDOVER_CODE_WRONG" | "HANDOVER_CODE_LOCKED" | undefined> {
  if (order.handoverCodeBlockedUntil && order.handoverCodeBlockedUntil > now) return "HANDOVER_CODE_LOCKED";
  if (order.handoverCodeAttempts >= HANDOVER_CODE_MAX_ATTEMPTS) return "HANDOVER_CODE_LOCKED";
  if (!order.handoverCodeHash || !order.handoverCodeSalt) {
    const generated = createHandoverCode(secret);
    await client.query(`UPDATE orders SET handover_code_hash = $2, handover_code_salt = $3, handover_code_ciphertext = $4
      WHERE id = $1 AND handover_code_hash IS NULL`, [order.id, generated.hash, generated.salt, generated.ciphertext]);
    await client.query("COMMIT");
    return "HANDOVER_CODE_WRONG";
  }
  if (matchesHandoverCode(code, order.handoverCodeSalt, order.handoverCodeHash)) return undefined;
  const attempts = order.handoverCodeAttempts + 1;
  const blockedUntil = attempts === HANDOVER_CODE_ATTEMPTS_BEFORE_COOLDOWN ? new Date(now.getTime() + HANDOVER_CODE_COOLDOWN_MS) : order.handoverCodeBlockedUntil;
  await client.query("UPDATE orders SET handover_code_attempts = $2, handover_code_blocked_until = $3 WHERE id = $1", [order.id, attempts, blockedUntil]);
  await client.query("COMMIT");
  return attempts === HANDOVER_CODE_ATTEMPTS_BEFORE_COOLDOWN || attempts >= HANDOVER_CODE_MAX_ATTEMPTS ? "HANDOVER_CODE_LOCKED" : "HANDOVER_CODE_WRONG";
}

export function matchesHandoverCode(input: string, salt: string, expected: string): boolean {
  const actual = scryptSync(input, salt, 32);
  const target = Buffer.from(expected, "base64url");
  return actual.length === target.length && timingSafeEqual(actual, target);
}

/** Convert the accepted reservation to one immutable sale movement per order line. */
export async function recordDeliverySale(client: PoolClient, orderId: string, accountId: string, at: Date): Promise<void> {
  await client.query(`INSERT INTO stock_movements (listing_id, actor_id, client_id, kind, quantity, created_at)
    SELECT listing_id, $2, $1, 'sale', -stock_quantity, $3 FROM order_lines WHERE order_id = $1
    ON CONFLICT (listing_id, client_id) DO NOTHING`, [orderId, accountId, at]);
}
