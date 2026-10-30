import type { OrderStatus } from "@ygo/contracts";
import type { PoolClient } from "pg";

export type OrderActor = { id: string; role: "customer" | "owner" | "staff" } | { id: null; role: "system" };

/** Each move an order may make, and who may make it (#9). Later tickets add theirs here. */
const MOVES: Partial<Record<OrderStatus, Partial<Record<OrderStatus, ReadonlyArray<OrderActor["role"]>>>>> = {
  // Free while the shop hasn't answered (ORD-5).
  placed: { cancelled_by_customer: ["customer"] },
};

export const canMove = (from: OrderStatus, to: OrderStatus, role: OrderActor["role"]) => MOVES[from]?.[to]?.includes(role) ?? false;

/** The ORD-7 row for one status change; `from` is null for the order's first status. */
export async function recordStatus(
  client: PoolClient, orderId: string, from: OrderStatus | null, to: OrderStatus, actor: OrderActor, at: Date, reasonCode: string | null = null,
): Promise<void> {
  await client.query(
    "INSERT INTO order_status_history (order_id, from_status, to_status, actor_id, actor_role, at, reason_code) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [orderId, from, to, actor.id, actor.role, at, reasonCode]);
}

/**
 * Moves an order the caller has locked (`FOR UPDATE`) and records it, or returns false for a move the table
 * doesn't allow. The status and its history row are written in the caller's transaction, so both land or neither.
 */
export async function moveOrder(
  client: PoolClient, order: { id: string; status: OrderStatus }, to: OrderStatus, actor: OrderActor, at: Date, reasonCode: string | null = null,
): Promise<boolean> {
  if (!canMove(order.status, to, actor.role)) return false;
  await client.query("UPDATE orders SET status = $2, status_changed_at = $3 WHERE id = $1", [order.id, to, at]);
  await recordStatus(client, order.id, order.status, to, actor, at, reasonCode);
  return true;
}
