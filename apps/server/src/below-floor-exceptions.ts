import type { BelowFloorException, BelowFloorExceptionCounts, BelowFloorExceptionsQuery } from "@ygo/contracts";
import type { Pool, PoolClient } from "pg";

type Db = Pool | PoolClient;

const iso = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
/** Microseconds, so a page boundary can't fall between two revisions the same millisecond apart. */
const cursorOf = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * Every below-floor exception revision (MNY-4, ADM-7, #529).
 * Caller scope: `areaManagerId` null is Admin, who sees every shop; an Area Manager sees only their assigned shops.
 * Only confirmed revisions with below_floor_exception = true count (ORD-4, D-5).
 */
const fromSql = `FROM order_revisions r
  JOIN orders o ON o.id = r.order_id
  JOIN shops s ON s.id = o.shop_id
  LEFT JOIN below_floor_exception_reviews rev ON rev.revision_id = r.id
  LEFT JOIN accounts ra ON ra.id = rev.reviewed_by
  WHERE r.below_floor_exception = true
    AND r.status = 'confirmed'
    AND ($1::uuid IS NULL OR s.area_manager_id = $1)`;

const rowSql = `SELECT r.id AS "revisionId",
  r.order_id AS "orderId",
  o.number AS "orderNumber",
  o.shop_id AS "shopId",
  s.shop_name AS "shopName",
  ${iso("o.placed_at")} AS "placedAt",
  o.status,
  COALESCE(
    (SELECT prev.total::text FROM order_revisions prev
     WHERE prev.order_id = r.order_id AND prev.status = 'confirmed' AND prev.revision < r.revision
     ORDER BY prev.revision DESC LIMIT 1),
    o.total::text
  ) AS "originalTotal",
  r.total::text AS "revisedTotal",
  r.below_floor_shortfall::text AS shortfall,
  r.platform_contribution::text AS "platformContribution",
  r.below_floor_reason AS reason,
  CASE WHEN rev.revision_id IS NULL THEN NULL
       ELSE json_build_object('at', ${iso("rev.reviewed_at")}, 'by', ra.name)
  END AS reviewed`;

const cursorSql = `${cursorOf("r.created_at")} || '|' || r.id AS cursor`;

export type BelowFloorExceptionPage = { exceptions: BelowFloorException[]; nextCursor: string | null };

/** One page, newest first. Order by created_at DESC, revision_id DESC. */
export async function listBelowFloorExceptions(
  db: Db,
  areaManagerId: string | null,
  query: BelowFloorExceptionsQuery,
): Promise<BelowFloorExceptionPage> {
  const values: unknown[] = [areaManagerId];
  const where: string[] = [query.status === "open" ? "rev.revision_id IS NULL" : "rev.revision_id IS NOT NULL"];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    where.push(sql.replace("?", `$${values.length}`));
  };
  if (query.shopId) add("o.shop_id = ?", query.shopId);
  if (areaManagerId === null && query.areaManagerId) add("s.area_manager_id = ?", query.areaManagerId);
  if (query.cursor) {
    const [at, id] = query.cursor.split("|");
    values.push(at, id);
    where.push(`(r.created_at, r.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
  }
  values.push(query.limit + 1);

  const { rows } = await db.query<BelowFloorException & { cursor: string }>(
    `${rowSql}, ${cursorSql} ${fromSql} AND ${where.join(" AND ")} ORDER BY r.created_at DESC, r.id DESC LIMIT $${values.length}`,
    values,
  );
  const page = rows.slice(0, query.limit);
  const exceptions = page.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "cursor")) as BelowFloorException);
  return { exceptions, nextCursor: rows.length > query.limit ? page[page.length - 1]?.cursor ?? null : null };
}

/**
 * Counts across the caller's full scope (independent of tab, cursor or filters).
 * Never stored (R-8).
 */
export async function belowFloorExceptionCounts(
  db: Db,
  areaManagerId: string | null,
): Promise<BelowFloorExceptionCounts> {
  const overall = await db.query<{ total: number; open: number }>(
    `SELECT count(*)::int AS total, (count(*) FILTER (WHERE rev.revision_id IS NULL))::int AS open
     ${fromSql}`,
    [areaManagerId],
  );
  const shops = await db.query<BelowFloorExceptionCounts["shops"][number]>(
    `SELECT o.shop_id AS "shopId",
       (array_agg(s.shop_name ORDER BY r.created_at DESC))[1] AS name,
       count(*)::int AS total,
       (count(*) FILTER (WHERE rev.revision_id IS NULL))::int AS open
     ${fromSql}
     GROUP BY o.shop_id
     ORDER BY total DESC, name, o.shop_id`,
    [areaManagerId],
  );
  const areaManagers = areaManagerId === null ? await db.query<BelowFloorExceptionCounts["areaManagers"][number]>(
    `SELECT s.area_manager_id AS "accountId",
       max(am.name) AS name,
       count(*)::int AS total,
       (count(*) FILTER (WHERE rev.revision_id IS NULL))::int AS open
     FROM order_revisions r
     JOIN orders o ON o.id = r.order_id
     JOIN shops s ON s.id = o.shop_id
     LEFT JOIN below_floor_exception_reviews rev ON rev.revision_id = r.id
     LEFT JOIN accounts am ON am.id = s.area_manager_id
     WHERE r.below_floor_exception = true
       AND r.status = 'confirmed'
       AND ($1::uuid IS NULL OR s.area_manager_id = $1)
       AND s.area_manager_id IS NOT NULL
     GROUP BY s.area_manager_id
     ORDER BY total DESC, name, s.area_manager_id`,
    [areaManagerId],
  ) : { rows: [] };

  return {
    open: overall.rows[0]?.open ?? 0,
    total: overall.rows[0]?.total ?? 0,
    shops: shops.rows,
    areaManagers: areaManagers.rows,
  };
}

/**
 * Marks one below-floor exception revision reviewed, once. A second mark changes nothing and keeps the first reviewer and time.
 * The revision row is locked first (FOR UPDATE OF r), so two marks at once settle on one row.
 * Returns null (answering 404) if not found, not confirmed, not below_floor_exception, or out of caller's scope.
 */
export async function reviewBelowFloorException(
  client: PoolClient,
  areaManagerId: string | null,
  revisionId: string,
  reviewerId: string,
  at: Date,
): Promise<BelowFloorException | null> {
  const found = await client.query(
    `SELECT 1 FROM order_revisions r
     JOIN orders o ON o.id = r.order_id
     JOIN shops s ON s.id = o.shop_id
     WHERE r.id = $1
       AND r.below_floor_exception = true
       AND r.status = 'confirmed'
       AND ($2::uuid IS NULL OR s.area_manager_id = $2)
     FOR UPDATE OF r`,
    [revisionId, areaManagerId],
  );
  if (!found.rowCount) return null;

  await client.query(
    `INSERT INTO below_floor_exception_reviews (revision_id, reviewed_by, reviewed_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (revision_id) DO NOTHING`,
    [revisionId, reviewerId, at],
  );

  const { rows: [row] } = await client.query<BelowFloorException>(
    `${rowSql} ${fromSql} AND r.id = $2`,
    [areaManagerId, revisionId],
  );
  return row ?? null;
}
