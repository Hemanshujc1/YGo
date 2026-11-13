import type { Pool, PoolClient } from "pg";
import type { CustomerTrust } from "@ygo/contracts";
import { digest, type AuthKeys } from "./tokens";

type Db = Pool | PoolClient;

export async function listCustomers(db: Db, search: string, now: Date): Promise<CustomerTrust[]> {
  const pattern = `%${search.trim().replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  const result = await db.query<{
    id: string; email: string; name: string | null; phone: string | null; phoneState: CustomerTrust["phoneState"];
    blocked: boolean; blockReason: string | null; failedDeliveries: number; refusals: number;
  }>(
    `SELECT a.id, a.email, a.name, a.phone,
       CASE WHEN a.phone_verified THEN 'sms-verified'
            WHEN a.phone_visit_confirmed_at IS NOT NULL THEN 'visit-confirmed'
            ELSE 'unverified' END AS "phoneState",
       cb.account_id IS NOT NULL AS blocked, cb.reason AS "blockReason",
       count(o.id) FILTER (WHERE o.status = 'delivery_failed' AND NOT EXISTS (SELECT 1 FROM order_status_history h WHERE h.order_id = o.id AND h.to_status = 'delivery_failed' AND h.reason_code = 'admin_forced') AND o.status_changed_at >= $2::timestamptz - interval '30 days' AND o.status_changed_at <= $2)::int AS "failedDeliveries",
       count(o.id) FILTER (WHERE o.status = 'delivery_failed' AND o.failed_delivery_reason = 'customer_refused' AND NOT EXISTS (SELECT 1 FROM order_status_history h WHERE h.order_id = o.id AND h.to_status = 'delivery_failed' AND h.reason_code = 'admin_forced') AND o.status_changed_at >= $2::timestamptz - interval '30 days' AND o.status_changed_at <= $2)::int AS refusals
     FROM accounts a LEFT JOIN customer_blocks cb ON cb.account_id = a.id
       LEFT JOIN orders o ON o.account_id = a.id
     WHERE a.role = 'customer' AND (a.email ILIKE $1 ESCAPE '\\' OR a.name ILIKE $1 ESCAPE '\\' OR a.phone ILIKE $1 ESCAPE '\\')
     GROUP BY a.id, cb.account_id, cb.reason ORDER BY lower(a.email) LIMIT 50`,
    [pattern, now],
  );
  return result.rows;
}

export async function blockCustomer(db: Db, accountId: string, reason: string, actorId: string, keys: AuthKeys, now: Date): Promise<CustomerTrust | null> {
  const account = await db.query<{ email: string; phone: string | null }>("SELECT email, phone FROM accounts WHERE id = $1 AND role = 'customer'", [accountId]);
  const row = account.rows[0];
  if (!row) return null;
  await db.query("INSERT INTO customer_blocks (account_id, phone_digest, email_digest, reason, blocked_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (account_id) DO UPDATE SET reason = EXCLUDED.reason, blocked_at = EXCLUDED.blocked_at", [accountId, digest(keys.blockDigest, row.phone ?? ""), digest(keys.blockDigest, row.email), reason, now]);
  await db.query("INSERT INTO admin_actions (actor_id, action, target_id, target_type, reason) VALUES ($1, 'customer.block', $2, 'account', $3)", [actorId, accountId, reason]);
  const listed = await listCustomers(db, row.email, now);
  return listed.find((customer) => customer.id === accountId) ?? null;
}

export async function unblockCustomer(db: Db, accountId: string, reason: string, actorId: string): Promise<boolean> {
  const deleted = await db.query("DELETE FROM customer_blocks WHERE account_id = $1", [accountId]);
  if (!deleted.rowCount) return false;
  await db.query("INSERT INTO admin_actions (actor_id, action, target_id, target_type, reason) VALUES ($1, 'customer.unblock', $2, 'account', $3)", [actorId, accountId, reason]);
  return true;
}
