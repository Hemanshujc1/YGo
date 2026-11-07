import type { ProofException, ProofExceptionCounts, ProofExceptionsQuery } from "@ygo/contracts";
import type { Pool, PoolClient } from "pg";

type Db = Pool | PoolClient;

const iso = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
/** Microseconds, so a page boundary can't fall between two deliveries the same millisecond apart. */
const cursorOf = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * Every proof exception (DLV-4) as Admin reads it, scoped by the caller: `areaManagerId` null is Admin, who sees every shop;
 * an Area Manager sees only the shops assigned to them (#299). Counts are worked out from the orders, never stored (R-8).
 */
const fromSql = `FROM orders o JOIN shops s ON s.id = o.shop_id
  LEFT JOIN accounts d ON d.id = o.deliverer_id
  LEFT JOIN proof_exception_reviews r ON r.order_id = o.id
  LEFT JOIN accounts ra ON ra.id = r.reviewed_by
  WHERE o.proof_exception AND o.status = 'delivered' AND ($1::uuid IS NULL OR s.area_manager_id = $1)`;

const rowSql = `SELECT o.id AS "orderId", o.number AS "orderNumber", json_build_object('id', o.shop_id, 'name', o.shop_name) AS shop,
  json_build_object('id', o.deliverer_id, 'name', d.name) AS deliverer, o.proof_exception_reason AS reason,
  ${iso("o.status_changed_at")} AS "recordedAt",
  CASE WHEN r.order_id IS NULL THEN NULL ELSE json_build_object('at', ${iso("r.reviewed_at")}, 'by', ra.name) END AS reviewed,
  CASE WHEN o.delivery_photo_key IS NULL THEN NULL ELSE json_build_object('expiresAt', ${iso("o.delivery_photo_expires_at")}) END AS photo`;
/** Where a page ends: the closing time to the microsecond, then the order id. */
const cursorSql = `${cursorOf("o.status_changed_at")} || '|' || o.id AS cursor`;

export type ProofExceptionPage = { exceptions: ProofException[]; nextCursor: string | null };

/** One page, newest first. The filters narrow the list; they never widen what the caller may see. */
export async function listProofExceptions(db: Db, areaManagerId: string | null, query: ProofExceptionsQuery): Promise<ProofExceptionPage> {
  const values: unknown[] = [areaManagerId];
  const where: string[] = [query.status === "open" ? "r.order_id IS NULL" : "r.order_id IS NOT NULL"];
  const add = (sql: string, value: unknown) => { values.push(value); where.push(sql.replace("?", `$${values.length}`)); };
  if (query.shopId) add("o.shop_id = ?", query.shopId);
  if (query.delivererId) add("o.deliverer_id = ?", query.delivererId);
  if (query.cursor) {
    const [at, id] = query.cursor.split("|");
    values.push(at, id);
    where.push(`(o.status_changed_at, o.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
  }
  values.push(query.limit + 1);
  // One more than a page, to know whether another page follows; the cursor is read from the last row kept.
  const { rows } = await db.query<ProofException & { cursor: string }>(
    `${rowSql}, ${cursorSql} ${fromSql} AND ${where.join(" AND ")} ORDER BY o.status_changed_at DESC, o.id DESC LIMIT $${values.length}`, values);
  const page = rows.slice(0, query.limit);
  const exceptions = page.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "cursor")) as ProofException);
  return { exceptions, nextCursor: rows.length > query.limit ? page[page.length - 1]?.cursor ?? null : null };
}

/**
 * The proof photo's key for one proof exception the caller may see, or null when the order is not theirs, is no proof
 * exception, or its photo is gone. `{ key: null }` is an order of theirs whose photo is gone, or past its 30 days though not yet swept (#560).
 */
export async function proofPhotoOf(client: PoolClient, areaManagerId: string | null, orderId: string, now: Date): Promise<{ key: string | null } | null> {
  const { rows: [row] } = await client.query<{ key: string | null }>(
    `SELECT CASE WHEN o.delivery_photo_expires_at > $3 THEN o.delivery_photo_key END AS key FROM orders o JOIN shops s ON s.id = o.shop_id
     WHERE o.id = $2 AND o.proof_exception AND o.status = 'delivered' AND ($1::uuid IS NULL OR s.area_manager_id = $1)`, [areaManagerId, orderId, now]);
  return row ?? null;
}

/** Per shop and per deliverer (each deliverer once, across the shops the caller may see), over every proof exception the caller may see; `open` is those not yet reviewed. */
export async function proofExceptionCounts(db: Db, areaManagerId: string | null): Promise<ProofExceptionCounts> {
  const shops = await db.query<ProofExceptionCounts["shops"][number]>(
    `SELECT o.shop_id AS "shopId", (array_agg(o.shop_name ORDER BY o.status_changed_at DESC))[1] AS name,
       count(*)::int AS total, (count(*) FILTER (WHERE r.order_id IS NULL))::int AS open
     ${fromSql} GROUP BY o.shop_id ORDER BY total DESC, name, o.shop_id`, [areaManagerId]);
  const deliverers = await db.query<ProofExceptionCounts["deliverers"][number]>(
    `SELECT o.deliverer_id AS "accountId", max(d.name) AS name,
       count(*)::int AS total, (count(*) FILTER (WHERE r.order_id IS NULL))::int AS open
     ${fromSql} AND o.deliverer_id IS NOT NULL GROUP BY o.deliverer_id ORDER BY total DESC, name, o.deliverer_id`, [areaManagerId]);
  return { shops: shops.rows, deliverers: deliverers.rows };
}

/**
 * Marks one proof exception reviewed, once: a second mark changes nothing and keeps the first reviewer and time.
 * The order is locked first, so two marks at once settle on one row. Null when the order is not a proof exception
 * or is not the caller's to see, so the two answer the same.
 */
export async function reviewProofException(client: PoolClient, areaManagerId: string | null, orderId: string, reviewerId: string, at: Date): Promise<ProofException | null> {
  const found = await client.query(
    `SELECT 1 FROM orders o JOIN shops s ON s.id = o.shop_id
     WHERE o.id = $2 AND o.proof_exception AND o.status = 'delivered' AND ($1::uuid IS NULL OR s.area_manager_id = $1) FOR UPDATE OF o`, [areaManagerId, orderId]);
  if (!found.rowCount) return null;
  await client.query("INSERT INTO proof_exception_reviews (order_id, reviewed_by, reviewed_at) VALUES ($1, $2, $3) ON CONFLICT (order_id) DO NOTHING", [orderId, reviewerId, at]);
  const { rows: [row] } = await client.query<ProofException>(`${rowSql} ${fromSql} AND o.id = $2`, [areaManagerId, orderId]);
  return row ?? null;
}
