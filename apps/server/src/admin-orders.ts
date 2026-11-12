import { AdminOrderBreakdown, TERMINAL_ORDER_STATUSES, type AdminOrderDetail, type AdminOrderRow, type AdminOrdersQuery, type AdminOrdersResponse, type ForcedOrderStatus, type OrderStatus } from "@ygo/contracts";
import type { Pool, PoolClient } from "pg";
import { ADMIN_FORCED } from "./notifications";
import { orderTiming } from "./order-timing";
import { forcedMoves, moveOrder } from "./orders";

type Db = Pool | PoolClient;

const iso = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
/** Microseconds, so a page boundary can't fall between two orders the same millisecond apart. */
const cursorOf = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const FINAL = TERMINAL_ORDER_STATUSES.map((status) => `'${status}'`).join(", ");

/**
 * Orders in scope (ADM-4, ADM-7, #66). $1 is the Area Manager's id: null is Admin, who sees every shop; an Area Manager sees only
 * the shops assigned to them (ADM-12).
 */
const scope = `FROM orders o JOIN shops s ON s.id = o.shop_id JOIN accounts c ON c.id = o.account_id LEFT JOIN accounts d ON d.id = o.deliverer_id
  WHERE ($1::uuid IS NULL OR s.area_manager_id = $1)`;

/**
 * Unanswered (ADM-7): still `placed` once the re-alert time ($2, `orderTiming.reRingSeconds`) has passed since `status_changed_at`, which is
 * what the re-ring and the expiry job count from (#57). Compared with $3, the server's clock passed in by the caller, never the browser's.
 */
const unansweredSql = `o.status = 'placed' AND o.status_changed_at + make_interval(secs => $2) <= $3::timestamptz`;

const summarySql = `o.id, o.number, o.shop_id AS "shopId", s.shop_name AS "shopName", c.name AS "customerName", o.fulfilment, o.status,
  ${iso("o.placed_at")} AS "placedAt", ${iso("o.status_changed_at")} AS "statusChangedAt", COALESCE((SELECT r.total::text FROM order_revisions r WHERE r.order_id = o.id AND r.status = 'confirmed' ORDER BY r.revision DESC LIMIT 1), o.total::text) AS total,
  GREATEST(0, floor(extract(epoch FROM $3::timestamptz - o.status_changed_at)))::int AS "statusAgeSeconds",
  (${unansweredSql}) AS unanswered`;

export type AdminOrdersPage = Omit<AdminOrdersResponse, "serverTime" | "unansweredAfterSeconds">;

/** One page, newest placed first. Ordered by `placed_at` then id, both fixed at placement, so a status change never moves a row between pages. */
export async function listAdminOrders(db: Db, areaManagerId: string | null, query: AdminOrdersQuery, now: Date): Promise<AdminOrdersPage> {
  const values: unknown[] = [areaManagerId, orderTiming.reRingSeconds, now];
  const where: string[] = [];
  if (query.group === "active") where.push(`o.status NOT IN (${FINAL})`);
  if (query.group === "final") where.push(`o.status IN (${FINAL})`);
  if (query.group === "unanswered") where.push(unansweredSql);
  if (query.shopId) {
    values.push(query.shopId);
    where.push(`o.shop_id = $${values.length}`);
  }
  if (query.cursor) {
    const [placedAt, id] = query.cursor.split("|");
    values.push(placedAt, id);
    where.push(`(o.placed_at, o.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
  }
  values.push(query.limit + 1);
  const { rows } = await db.query<AdminOrderRow>(
    `SELECT ${summarySql}, ${cursorOf("o.placed_at")} || '|' || o.id AS cursor
     ${scope} ${where.map((clause) => `AND ${clause}`).join(" ")}
     ORDER BY o.placed_at DESC, o.id DESC LIMIT $${values.length}`, values);
  const orders = rows.slice(0, query.limit);
  const { rows: [counts] } = await db.query<{ active: number; unanswered: number }>(
    `SELECT count(*) FILTER (WHERE o.status NOT IN (${FINAL}))::int AS active, count(*) FILTER (WHERE ${unansweredSql})::int AS unanswered
     ${scope}`, [areaManagerId, orderTiming.reRingSeconds, now]);
  return { orders, nextCursor: rows.length > query.limit ? orders[orders.length - 1]?.cursor ?? null : null, counts: counts ?? { active: 0, unanswered: 0 } };
}

/**
 * The statuses Admin may force this order into. They come only from the `admin` entries of the move table in `orders.ts`, so a system-only
 * move (a partial acceptance's timeout, a delivery's start) is never offered. Not collected closes a pickup only.
 */
export function forcedMovesFor(status: OrderStatus, fulfilment: string): ForcedOrderStatus[] {
  return forcedMoves(status).filter((to) => to !== "not_collected" || fulfilment === "pickup") as ForcedOrderStatus[];
}

/**
 * One money column as the customer sees it: the latest confirmed revision's own value (a fee or discount it dropped is null or 0, never the
 * placement one), else the one frozen at placement (#572).
 */
const current = (column: string, cast = "text") => `CASE WHEN EXISTS (SELECT 1 FROM order_revisions r WHERE r.order_id = o.id AND r.status = 'confirmed')
  THEN (SELECT r.${column}${cast === "text" ? "::text" : ""} FROM order_revisions r WHERE r.order_id = o.id AND r.status = 'confirmed' ORDER BY r.revision DESC LIMIT 1)
  ELSE o.${column}${cast === "text" ? "::text" : ""} END`;

type DetailRow = AdminOrderDetail["order"] & AdminOrderDetail["money"] & { quote: unknown; delivererName: string | null };

/** One order for A15, or null when it does not exist or is outside the caller's scope. Only Admin is offered a forced move (ADM-12). */
export async function adminOrderDetail(db: Db, areaManagerId: string | null, id: string, now: Date): Promise<AdminOrderDetail | null> {
  const { rows: [row] } = await db.query<DetailRow>(
    `SELECT ${summarySql}, ${current("product_value")} AS "productValue", ${current("shop_discount")} AS "shopDiscount", ${current("delivery_fee")} AS "deliveryFee",
       ${current("small_cart_fee")} AS "smallCartFee", ${current("pickup_fee")} AS "pickupFee", ${current("quote", "jsonb")} AS quote, d.name AS "delivererName"
     ${scope} AND o.id = $4`, [areaManagerId, orderTiming.reRingSeconds, now, id]);
  if (!row) return null;
  // The lines the customer sees: the latest confirmed revision's (a line it removed has count 0), else those frozen at placement.
  const columns = (t: string) => `name, brand, ${t}.count, trim_scale(${t}.part_quantity)::text AS "partQuantity", trim_scale(${t}.pack_quantity)::text AS "packQuantity", base_unit AS "baseUnit",
       ${t}.unit_price::text AS "unitPrice", ${t}.line_total::text AS "lineTotal"`;
  const { rows: revised } = await db.query<AdminOrderDetail["lines"][number]>(
    `SELECT ${columns("l")} FROM order_revision_lines l
     WHERE l.revision_id = (SELECT r.id FROM order_revisions r WHERE r.order_id = $1 AND r.status = 'confirmed' ORDER BY r.revision DESC LIMIT 1) AND l.count > 0 ORDER BY l.position`, [id]);
  const lines = revised.length > 0 ? revised : (await db.query<AdminOrderDetail["lines"][number]>(
    `SELECT ${columns("l")} FROM order_lines l WHERE l.order_id = $1 ORDER BY l.position`, [id])).rows;
  const { rows: timeline } = await db.query<AdminOrderDetail["timeline"][number]>(
    `SELECT ${iso("h.at")} AS at, h.from_status AS "from", h.to_status AS "to", h.actor_role AS "actorRole", a.name AS "actorName", h.reason_code AS "reasonCode"
     FROM order_status_history h LEFT JOIN accounts a ON a.id = h.actor_id WHERE h.order_id = $1 ORDER BY h.at, h.id`, [id]);
  const { rows: forcedActions } = await db.query<AdminOrderDetail["forcedActions"][number]>(
    `SELECT ${iso("x.created_at")} AS at, a.name AS "adminName", x.from_status AS "from", x.to_status AS "to", x.reason
     FROM admin_actions x LEFT JOIN accounts a ON a.id = x.actor_id
     WHERE x.target_type = 'order' AND x.target_id = $1 AND x.action = 'order.force_transition' ORDER BY x.created_at, x.id`, [id]);
  // Offline deliveries the server refused or held: Admin settles them with a forced move (#616).
  const { rows: issues } = await db.query<{ action: string; code: string; at: Date; clockSuspect: boolean }>(
    'SELECT action, code, created_at AS at, clock_suspect AS "clockSuspect" FROM offline_delivery_issues WHERE order_id = $1 ORDER BY created_at, action_id', [id]);
  const { quote, delivererName, productValue, shopDiscount, deliveryFee, smallCartFee, pickupFee, ...order } = row;
  const breakdown = AdminOrderBreakdown.safeParse(quote);
  return {
    order,
    lines,
    money: { productValue, shopDiscount, deliveryFee, smallCartFee, pickupFee, total: order.total },
    breakdown: breakdown.success ? breakdown.data : null,
    timeline,
    offlineDeliveryIssues: issues.map((issue) => ({ ...issue, at: issue.at.toISOString() })),
    forcedActions: areaManagerId === null ? forcedActions : [],
    people: { customerName: order.customerName, delivererName },
    forcedMoves: forcedMovesFor(order.status, order.fulfilment),
  };
}

export type ForceResult = "done" | "not_found" | "status_changed" | "not_allowed";

/**
 * Forces an order into a closing status (ADM-4, ORD-1) inside the caller's transaction. The order row is locked and re-read; the move must be on
 * the allowlist for its current status. The status, its history row (actor Admin, reason code `admin_forced`), the customer's queued notification
 * and the audit record are all written on this one client, so they land together at the caller's commit or not at all; the push job sends the
 * notification only after that. No line, price or quote of the order is touched (MNY-7).
 */
export async function forceOrderTransition(
  client: PoolClient, orderId: string, body: { from: OrderStatus; to: ForcedOrderStatus; reason: string }, adminId: string, now: Date,
): Promise<ForceResult> {
  const { rows: [order] } = await client.query<{ id: string; status: OrderStatus; fulfilment: string }>(
    "SELECT id, status, fulfilment FROM orders WHERE id = $1 FOR UPDATE", [orderId]);
  if (!order) return "not_found";
  if (order.status !== body.from) return "status_changed";
  if (!forcedMovesFor(order.status, order.fulfilment).includes(body.to)) return "not_allowed";
  if (!await moveOrder(client, order, body.to, { id: adminId, role: "admin" }, now, ADMIN_FORCED)) return "not_allowed";
  await client.query(
    "INSERT INTO admin_actions (actor_id, action, target_id, target_type, reason, from_status, to_status) VALUES ($1, 'order.force_transition', $2, 'order', $3, $4, $5)",
    [adminId, orderId, body.reason, body.from, body.to]);
  return "done";
}
