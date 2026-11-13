import type { Pool, PoolClient } from "pg";
import type { Statement, StatementBalance, StatementSummary } from "@ygo/contracts";
import { formatDayMonth, formatDayMonthYear, formatMoney } from "@ygo/format";
import { notifyShopOwner } from "./notifications";
import { resolveRateCard } from "./routes/rate-cards";

type Db = Pool | PoolClient;

/** Weeks run Monday to Sunday in India (#629). */
const IST = "'Asia/Kolkata'";
/** The moment the week starting on date `$n` ends: the next Monday at 00:00 in India. */
const weekEnd = (n: number) => `(($${n}::date + 7)::timestamp AT TIME ZONE ${IST})`;

/**
 * Every completed order not yet on a statement, with what it owes YGo (#629, MNY-8, MNY-15). Only delivered and picked-up orders are charged.
 * The amounts come from the order's final price, never worked out again: the latest confirmed revision's commission, coupon and contribution,
 * else the placement quote's. Fees stand as quoted on a revision (ORD-4), so the fee shares and booking fees are always the placement quote's.
 * What is owed is the platform contribution, which equals commission + fee shares + booking fees − YGo-funded coupon (a check on statement_lines).
 * `completed_at` is the order's status time, which the move to delivered or picked up writes together with its history row; an offline delivery
 * carries the time it happened on the phone (#616).
 */
const unstated = `SELECT o.id AS order_id, o.shop_id, o.number AS order_number, o.fulfilment, o.status_changed_at AS completed_at, o.shop_name AS order_shop_name,
    COALESCE(r.total, o.total) AS order_total,
    COALESCE(r.commission, (o.quote->>'commission')::numeric) AS commission,
    COALESCE((o.quote->'deliveryFee'->>'platformShare')::numeric, 0) + COALESCE((o.quote->'smallCartFee'->>'platformShare')::numeric, 0) AS fee_share,
    COALESCE((o.quote->'pickup'->>'customerFee')::numeric, 0) + COALESCE((o.quote->'pickup'->>'shopFee')::numeric, 0) AS booking_fees,
    COALESCE(r.platform_coupon, o.platform_coupon) AS platform_coupon,
    COALESCE(r.platform_contribution, (o.quote->>'platformContribution')::numeric) AS owed
  FROM orders o
  LEFT JOIN LATERAL (SELECT total, commission, platform_coupon, platform_contribution FROM order_revisions
    WHERE order_id = o.id AND status = 'confirmed' ORDER BY revision DESC LIMIT 1) r ON true
  WHERE o.status IN ('delivered', 'picked_up') AND NOT EXISTS (SELECT 1 FROM statement_lines l WHERE l.order_id = o.id)`;

/**
 * The issue-statements job (#629): makes every week's statements that ended and is not yet done, oldest first, and returns how many it made.
 * On the first run that is only the week that ended last Sunday. Each shop gets a statement for a week with every unstated order completed before
 * that week ended; one completed in an earlier week is marked late. A shop with none gets nothing. Each finished week is recorded, with or without
 * statements, so a rerun makes nothing and a missed Monday makes only the missing weeks.
 *
 * Two runs never overlap: the lock is taken before the transaction opens, so the second run's snapshot sees the first one's work. The whole run then
 * reads one snapshot (REPEATABLE READ): an order completed during it is left for the next statement, never put on two. It only adds rows, so
 * a shop or order changed meanwhile does not stop it.
 */
export async function issueStatements(pool: Pool, now: Date): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('issue_statements'))");
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const made = await issueDueWeeks(client, now);
    await client.query("COMMIT");
    await client.query("SELECT pg_advisory_unlock(hashtext('issue_statements'))");
    client.release();
    return made;
  } catch (error) {
    // Closing the connection rolls the run back and frees the lock, and the run's own error stays the one reported.
    client.release(error as Error);
    throw error;
  }
}

async function issueDueWeeks(client: PoolClient, now: Date): Promise<number> {
  const { rows: weeks } = await client.query<{ week: string }>(
    `WITH bounds AS (SELECT date_trunc('week', $1::timestamptz AT TIME ZONE ${IST})::date - 7 AS last_ended, (SELECT max(period_start) FROM statement_weeks) AS done)
     SELECT to_char(w, 'YYYY-MM-DD') AS week FROM bounds, generate_series(COALESCE(done + 7, last_ended), last_ended, interval '7 days') AS w ORDER BY w`, [now]);
  let made = 0;
  for (const { week } of weeks) {
    const { rows: shops } = await client.query<{ shopId: string }>(
      `SELECT DISTINCT shop_id AS "shopId" FROM (${unstated}) c WHERE c.completed_at < ${weekEnd(1)} ORDER BY 1`, [week]);
    for (const { shopId } of shops) await issueOne(client, shopId, week, now);
    await client.query("INSERT INTO statement_weeks (period_start, processed_at, statement_count) VALUES ($1, $2, $3)", [week, now, shops.length]);
    made += shops.length;
  }
  return made;
}

async function issueOne(client: PoolClient, shopId: string, week: string, now: Date): Promise<void> {
  // The grace period is the shop's rate card's at issue; a Live shop always has one. Without it the run fails and the alarm fires, rather than guess a date.
  const grace = (await resolveRateCard(client, shopId))?.values.statementGraceDays?.value;
  if (typeof grace !== "number") throw new Error(`Shop ${shopId} has no statement grace period`);
  const { rows: [statement] } = await client.query<{ id: string; number: number; periodEnd: string; total: string; dueOn: string }>(
    `INSERT INTO statements (shop_id, period_start, period_end, issued_at, grace_days, due_on, shop_name, shop_address, shop_pincode, order_count, total)
     SELECT s.id, $2::date, $2::date + 6, $3, $4::integer, ($3::timestamptz AT TIME ZONE ${IST})::date + $4::integer,
       COALESCE(s.shop_name, (array_agg(c.order_shop_name ORDER BY c.completed_at DESC))[1]), s.address, s.pincode, count(*), sum(c.owed)
     FROM shops s JOIN (${unstated}) c ON c.shop_id = s.id WHERE s.id = $1 AND c.completed_at < ${weekEnd(2)} GROUP BY s.id
     RETURNING id, number, to_char(period_end, 'YYYY-MM-DD') AS "periodEnd", total::text, to_char(due_on, 'YYYY-MM-DD') AS "dueOn"`,
    [shopId, week, now, grace]);
  if (!statement) throw new Error("Statement insert returned no row");
  await client.query(
    `INSERT INTO statement_lines (order_id, statement_id, order_number, completed_at, late, fulfilment, order_total, commission, fee_share, booking_fees, platform_coupon, owed)
     SELECT c.order_id, $3, c.order_number, c.completed_at, c.completed_at < ($2::date::timestamp AT TIME ZONE ${IST}), c.fulfilment,
       c.order_total, c.commission, c.fee_share, c.booking_fees, c.platform_coupon, c.owed
     FROM (${unstated}) c WHERE c.shop_id = $1 AND c.completed_at < ${weekEnd(2)}`, [shopId, week, statement.id]);
  // The key names the statement, so the Owner hears of it once (NOT-6) even if this step were ever run again.
  await notifyShopOwner(client, shopId, "statement_issued", "Weekly statement ready",
    `Statement #${statement.number} for ${formatDayMonth(week)} – ${formatDayMonth(statement.periodEnd)}: ${formatMoney(statement.total)}, due by ${formatDayMonthYear(statement.dueOn)}.`,
    now, `statement:${statement.id}`, statement.id);
}

const iso = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const summarySql = `s.id, s.number, s.shop_id AS "shopId", s.shop_name AS "shopName", to_char(s.period_start, 'YYYY-MM-DD') AS "periodStart",
  to_char(s.period_end, 'YYYY-MM-DD') AS "periodEnd", ${iso("s.issued_at")} AS "issuedAt", to_char(s.due_on, 'YYYY-MM-DD') AS "dueOn",
  s.order_count AS "orderCount", s.total::text AS total`;

/** A page of statements, newest first, of one shop or of all, and of one week or of all (S15, A18). */
export async function listStatements(db: Db, filter: { shopId?: string; week?: string }, page: { before?: number; limit: number }): Promise<{ statements: StatementSummary[]; nextBefore: number | null }> {
  const { rows } = await db.query<StatementSummary>(
    `SELECT ${summarySql} FROM statements s
     WHERE ($1::uuid IS NULL OR s.shop_id = $1) AND ($2::date IS NULL OR s.period_start = $2) AND ($3::integer IS NULL OR s.number < $3)
     ORDER BY s.number DESC LIMIT $4`, [filter.shopId ?? null, filter.week ?? null, page.before ?? null, page.limit + 1]);
  const statements = rows.slice(0, page.limit);
  return { statements, nextBefore: rows.length > page.limit ? statements[statements.length - 1]?.number ?? null : null };
}

/** One whole statement, or null when it does not exist or is not the given shop's. */
export async function statementDetail(db: Db, id: string, shopId?: string): Promise<Statement | null> {
  const { rows: [statement] } = await db.query<Omit<Statement, "lines">>(
    `SELECT ${summarySql}, s.shop_address AS "shopAddress", s.shop_pincode AS "shopPincode" FROM statements s WHERE s.id = $1 AND ($2::uuid IS NULL OR s.shop_id = $2)`,
    [id, shopId ?? null]);
  if (!statement) return null;
  const { rows: lines } = await db.query<Statement["lines"][number]>(
    `SELECT order_id AS "orderId", order_number AS "orderNumber", ${iso("completed_at")} AS "completedAt", late, fulfilment, order_total::text AS "orderTotal",
       commission::text, fee_share::text AS "feeShare", booking_fees::text AS "bookingFees", platform_coupon::text AS "platformCoupon", owed::text
     FROM statement_lines WHERE statement_id = $1 ORDER BY completed_at, order_number`, [id]);
  return { ...statement, lines };
}

export type ShopBalance = StatementBalance & { shopId: string; shopName: string };

/**
 * What shops owe YGo now, in two parts (MNY-8): the statements made so far, and completed orders not on one yet. Payments and adjustments come with #79.
 * With `shopId`, that shop alone, even when it owes nothing; without, every shop that owes anything, most owed first.
 */
export async function shopBalances(db: Db, shopId?: string): Promise<ShopBalance[]> {
  const { rows } = await db.query<ShopBalance>(
    `SELECT s.id AS "shopId", COALESCE(s.shop_name, '') AS "shopName", round(COALESCE(st.owed, 0), 2)::text AS "onStatements",
       round(COALESCE(u.owed, 0), 2)::text AS "thisWeek", round(COALESCE(st.owed, 0) + COALESCE(u.owed, 0), 2)::text AS total
     FROM shops s
     LEFT JOIN (SELECT shop_id, sum(total) AS owed FROM statements GROUP BY shop_id) st ON st.shop_id = s.id
     LEFT JOIN (SELECT shop_id, sum(owed) AS owed FROM (${unstated}) c GROUP BY shop_id) u ON u.shop_id = s.id
     WHERE ($1::uuid IS NULL AND (st.owed IS NOT NULL OR u.owed IS NOT NULL)) OR s.id = $1
     ORDER BY COALESCE(st.owed, 0) + COALESCE(u.owed, 0) DESC, s.shop_name`, [shopId ?? null]);
  return rows;
}
