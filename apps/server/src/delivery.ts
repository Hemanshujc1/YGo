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
