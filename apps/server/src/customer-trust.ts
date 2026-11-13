import type { Pool, PoolClient } from "pg";
import type { CustomerTrust } from "@ygo/contracts";
import { customerFailedDeliveries, CUSTOMER_TRUST_FLAG_THRESHOLD } from "./customer-refusals";
import { digest, type AuthKeys } from "./tokens";

type Db = Pool | PoolClient;

export async function listCustomers(db: Db, search: string | undefined, now: Date, flaggedOnly = false): Promise<CustomerTrust[]> {
  const pattern = search === undefined ? null : `%${search.trim().replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  const result = await db.query<{
    id: string; email: string; name: string | null; phone: string | null; phoneState: CustomerTrust["phoneState"];
    blocked: boolean; blockReason: string | null;
  }>(
    `SELECT a.id, a.email, a.name, a.phone,
       CASE WHEN a.phone_verified THEN 'sms-verified'
            WHEN a.phone_visit_confirmed_at IS NOT NULL THEN 'visit-confirmed'
            ELSE 'unverified' END AS "phoneState",
       cb.account_id IS NOT NULL AS blocked, cb.reason AS "blockReason"
     FROM accounts a LEFT JOIN customer_blocks cb ON cb.account_id = a.id
     WHERE a.role = 'customer' AND ($1::text IS NULL OR a.email ILIKE $1 ESCAPE '\\' OR a.name ILIKE $1 ESCAPE '\\' OR a.phone ILIKE $1 ESCAPE '\\')
     ORDER BY lower(a.email) LIMIT 50`,
    [pattern],
  );
  const customers = await Promise.all(result.rows.map(async (row) => {
    const counts = await customerFailedDeliveries(db, row.id, now);
    return { ...row, failedDeliveries: counts.failed, refusals: counts.refused, flagged: counts.failed >= CUSTOMER_TRUST_FLAG_THRESHOLD || counts.refused >= CUSTOMER_TRUST_FLAG_THRESHOLD };
  }));
  return flaggedOnly ? customers.filter((customer) => customer.flagged) : customers;
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
