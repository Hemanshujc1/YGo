import type { OrderStatus } from "@ygo/contracts";
import type { PoolClient } from "pg";
import { notifyOrderStatus } from "./notifications";

export type OrderActor = { id: string; role: "customer" | "owner" | "staff" | "admin" } | { id: null; role: "system" };

/**
 * Each move an order may make, and who may make it (#9). Later tickets add theirs here.
 * `admin` is the forced-transition allowlist of ADM-4 (#66): it only ever cancels or closes an order. It never moves one
 * forward (that needs the shop's stock check, a deliverer, the handover code or payment), and it never touches
 * `awaiting_customer_confirm`, whose way out is the customer's own answer (ORD-3). A final status has no moves at all.
 */
const MOVES: Partial<Record<OrderStatus, Partial<Record<OrderStatus, ReadonlyArray<OrderActor["role"]>>>>> = {
  // Free while the shop hasn't answered (ORD-5); the shop's Owner or Staff answers it (#425).
  // Only the timed job (#57, ORD-2) expires an order: `system` is never the role of a signed-in request.
  placed: {
    cancelled_by_customer: ["customer"],
    accepted: ["owner", "staff"],
    rejected_by_shop: ["owner", "staff", "admin"],
    expired: ["system", "admin"],
    awaiting_customer_confirm: ["owner", "staff"],
    cancelled_by_shop: ["system", "admin"],
  },
  // `cancelled_by_customer` here is only the shop agreeing to the Customer's ask (ORD-5, #59): that route checks an `asked`
  // request first. The Customer never cancels an accepted order directly.
  accepted: {
    preparing: ["owner", "staff"],
    ready: ["owner", "staff"],
    cancelled_by_customer: ["owner", "staff"],
    cancelled_by_shop: ["owner", "staff", "system", "admin"],
    awaiting_customer_confirm: ["owner", "staff"],
  },
  preparing: {
    ready: ["owner", "staff"],
    cancelled_by_customer: ["owner", "staff"],
    cancelled_by_shop: ["owner", "staff", "system", "admin"],
    awaiting_customer_confirm: ["owner", "staff"],
  },
  // A pickup nobody collected is closed by the timed job at its cutoff (FUL-7, #65): `system` is never the role of a signed-in request.
  ready: { out_for_delivery: ["owner", "staff"], picked_up: ["owner", "staff"], cancelled_by_shop: ["owner", "staff", "admin"], not_collected: ["system", "admin"] },
  out_for_delivery: { arrived: ["owner", "staff"] },
  arrived: { delivered: ["owner", "staff"], delivery_failed: ["owner", "staff", "admin"] },
  awaiting_customer_confirm: {
    placed: ["customer"],
    accepted: ["customer"],
    preparing: ["customer"],
    cancelled_by_customer: ["customer", "system"],
  },
};

/** The moves Admin may force from one status (ADM-4, A15): the modal lists exactly these. */
export const forcedMoves = (from: OrderStatus): OrderStatus[] =>
  Object.entries(MOVES[from] ?? {}).filter(([, roles]) => roles?.includes("admin")).map(([to]) => to as OrderStatus);

export const canMove = (from: OrderStatus, to: OrderStatus, role: OrderActor["role"]) => MOVES[from]?.[to]?.includes(role) ?? false;

/** The ORD-7 row for one status change; `from` is null for the order's first status. */
export async function recordStatus(
  client: PoolClient, orderId: string, from: OrderStatus | null, to: OrderStatus, actor: OrderActor, at: Date, reasonCode: string | null = null,
): Promise<void> {
  await client.query(
    "INSERT INTO order_status_history (order_id, from_status, to_status, actor_id, actor_role, at, reason_code) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [orderId, from, to, actor.id, actor.role, at, reasonCode]);
  // Every status change passes here, so whoever should hear of it is told in the same transaction (#505).
  await notifyOrderStatus(client, orderId, to, at, reasonCode, from);
}

/**
 * Moves an order the caller has locked (`FOR UPDATE`) and records it, or returns false for a move the table
 * doesn't allow. The status and its history row are written in the caller's transaction, so both land or neither.
 */
export async function moveOrder(
  client: PoolClient, order: { id: string; status: OrderStatus }, to: OrderStatus, actor: OrderActor, at: Date, reasonCode: string | null = null,
): Promise<boolean> {
  if (!canMove(order.status, to, actor.role)) return false;
  if (order.status === "awaiting_customer_confirm" && to !== "awaiting_customer_confirm") {
    const { rows } = await client.query("SELECT 1 FROM order_revisions WHERE order_id = $1 AND status = 'proposed'", [order.id]);
    if (rows.length > 0) return false;
  }
  await client.query("UPDATE orders SET status = $2, status_changed_at = $3 WHERE id = $1", [order.id, to, at]);
  // An ask to cancel nobody answered ends when the order leaves accepted and preparing (ORD-5, #59); accepted to preparing keeps it.
  // The agree route settles its own first.
  if (to !== "accepted" && to !== "preparing") {
    await client.query("UPDATE order_cancel_requests SET status = 'closed_unanswered', settled_at = $2 WHERE order_id = $1 AND status = 'asked'", [order.id, at]);
  }
  await recordStatus(client, order.id, order.status, to, actor, at, reasonCode);
  return true;
}
