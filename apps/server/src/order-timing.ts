import { ORDER_ANSWER_SECONDS } from "@ygo/contracts";

/**
 * The two order timers of ORD-2, set once at start-up from `ORDER_REALERT_SECONDS` and `ORDER_EXPIRE_SECONDS`:
 * the new-order alarm rings again after `reRingSeconds` and an unanswered order expires after `expireSeconds`.
 * Held in one place because the push queue, the order routes and the expiry job all read them (#57).
 *
 * The apps still count down from `ORDER_ANSWER_SECONDS` in `@ygo/contracts` (600). Changing
 * `ORDER_EXPIRE_SECONDS` therefore needs an app update that changes that constant, until the order
 * responses carry the server's deadline.
 */
export const orderTiming = { reRingSeconds: 120, expireSeconds: ORDER_ANSWER_SECONDS, confirmSeconds: 300 };

export function setOrderTiming(timing: { reRingSeconds?: number; expireSeconds?: number; confirmSeconds?: number }): void {
  if (timing.reRingSeconds !== undefined) orderTiming.reRingSeconds = timing.reRingSeconds;
  if (timing.expireSeconds !== undefined) orderTiming.expireSeconds = timing.expireSeconds;
  if (timing.confirmSeconds !== undefined) orderTiming.confirmSeconds = timing.confirmSeconds;
}
