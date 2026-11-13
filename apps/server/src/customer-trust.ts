import type { Pool, PoolClient } from "pg";
import type { AdminCustomersResponse, CustomerTrust, PageQuery } from "@ygo/contracts";
import { customerFailureCountsSql } from "./customer-refusals";
import { digest, type AuthKeys } from "./tokens";

type Db = Pool | PoolClient;

const customerRowsSql = `SELECT a.id, a.email, a.name, a.phone,
  CASE WHEN a.phone_verified THEN 'sms-verified'
       WHEN a.phone_visit_confirmed_at IS NOT NULL THEN 'visit-confirmed'
       ELSE 'unverified' END AS "phoneState",
  cb.account_id IS NOT NULL AS blocked, cb.reason AS "blockReason",
  COALESCE(counts.failed, 0) AS "failedDeliveries", COALESCE(counts.refused, 0) AS refusals,
  COALESCE(counts.flagged, false) AS flagged
FROM accounts a LEFT JOIN customer_blocks cb ON cb.account_id = a.id
LEFT JOIN (${customerFailureCountsSql}) counts ON counts.account_id = a.id
WHERE a.role = 'customer'`;

type CustomerListOptions = PageQuery & { search?: string; flaggedOnly?: boolean };

/** One stable Customer directory page. Filters and the exact count are applied before its LIMIT/OFFSET. */
export async function listCustomers(db: Db, options: CustomerListOptions, now: Date): Promise<AdminCustomersResponse> {
  const { search, flaggedOnly = false, page, pageSize } = options;
  const pattern = search === undefined ? null : `%${search.trim().replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  const result = await db.query<{ items: CustomerTrust[]; page: number; totalRecords: number }>(
    `WITH customer_rows AS MATERIALIZED (${customerRowsSql}),
       filtered AS MATERIALIZED (
         SELECT * FROM customer_rows
         WHERE ($2::text IS NULL OR email ILIKE $2 ESCAPE '\\' OR name ILIKE $2 ESCAPE '\\' OR phone ILIKE $2 ESCAPE '\\')
           AND (NOT $3::boolean OR flagged)
       ),
       page_info AS (
         SELECT count(*)::int AS total,
           CASE WHEN count(*) = 0 THEN 1
                ELSE LEAST($4::int, CEIL(count(*)::numeric / $5::int)::int) END AS page
         FROM filtered
       )
     SELECT COALESCE(jsonb_agg(to_jsonb(page_row) ORDER BY lower(page_row.email), page_row.id)
              FILTER (WHERE page_row.id IS NOT NULL), '[]'::jsonb) AS items,
       page_info.page, page_info.total AS "totalRecords"
     FROM page_info
     LEFT JOIN LATERAL (
       SELECT * FROM filtered
       ORDER BY lower(email), id
       LIMIT $5 OFFSET ((page_info.page - 1) * $5)
     ) page_row ON true
     GROUP BY page_info.page, page_info.total`,
    [now, pattern, flaggedOnly, page, pageSize],
  );
  const listed = result.rows[0] ?? { items: [], page: 1, totalRecords: 0 };
  return { items: listed.items, pagination: { page: listed.page, pageSize, totalRecords: listed.totalRecords } };
}

async function customerById(db: Db, accountId: string, now: Date): Promise<CustomerTrust | null> {
  const result = await db.query<CustomerTrust>(`WITH customer_rows AS (${customerRowsSql}) SELECT * FROM customer_rows WHERE id = $2`, [now, accountId]);
  return result.rows[0] ?? null;
}

export async function blockCustomer(db: Db, accountId: string, reason: string, actorId: string, keys: AuthKeys, now: Date): Promise<CustomerTrust | null> {
  const account = await db.query<{ email: string; phone: string | null }>("SELECT email, phone FROM accounts WHERE id = $1 AND role = 'customer'", [accountId]);
  const row = account.rows[0];
  if (!row) return null;
  await db.query("INSERT INTO customer_blocks (account_id, phone_digest, email_digest, reason, blocked_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (account_id) DO UPDATE SET reason = EXCLUDED.reason, blocked_at = EXCLUDED.blocked_at", [accountId, digest(keys.blockDigest, row.phone ?? ""), digest(keys.blockDigest, row.email), reason, now]);
  await db.query("INSERT INTO admin_actions (actor_id, action, target_id, target_type, reason) VALUES ($1, 'customer.block', $2, 'account', $3)", [actorId, accountId, reason]);
  return customerById(db, accountId, now);
}

export async function unblockCustomer(db: Db, accountId: string, reason: string, actorId: string): Promise<boolean> {
  const deleted = await db.query("DELETE FROM customer_blocks WHERE account_id = $1", [accountId]);
  if (!deleted.rowCount) return false;
  await db.query("INSERT INTO admin_actions (actor_id, action, target_id, target_type, reason) VALUES ($1, 'customer.unblock', $2, 'account', $3)", [actorId, accountId, reason]);
  return true;
}
