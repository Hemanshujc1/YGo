import type { ApiResult } from "@ygo/api-client";
import { type CartResponse, type ErrorCode, type FeedQuery, type OrderResponse, type OrderStatus, type PlaceOrderBody, TERMINAL_ORDER_STATUSES } from "@ygo/contracts";
import type { Treatment } from "@ygo/mobile";
import { createPoller, phoneTimers, type Timers } from "@ygo/mobile/poller";
import { strings } from "../strings";

export type { Timers };

/** Who has to act, as the Customer sees it (design system section 6). */
export const treatments: Record<OrderStatus, Treatment> = {
  placed: "waiting",
  scheduled_pending_review: "inProgress",
  awaiting_customer_confirm: "needsYou",
  accepted: "inProgress",
  scheduled_confirmed: "inProgress",
  preparing: "inProgress",
  ready: "inProgress",
  out_for_delivery: "inProgress",
  arrived: "needsYou",
  delivered: "completed",
  picked_up: "completed",
  rejected_by_shop: "ended",
  expired: "ended",
  not_collected: "ended",
  cancelled_by_customer: "ended",
  cancelled_by_shop: "ended",
  delivery_failed: "ended",
};

export const isFinal = (status: OrderStatus) => TERMINAL_ORDER_STATUSES.includes(status);

/**
 * The status C18 and C19 show: a placed order the shop can no longer answer reads as "Shop did not answer"
 * until #57 moves it to Expired (owner's answer 4 on #426).
 */
export const shownStatus = (order: Pick<OrderResponse, "status" | "answerExpired">): OrderStatus => (order.answerExpired ? "expired" : order.status);

/** The status word the Customer reads: a pickup that is ready is ready to collect, not "Ready" (FUL-7, #65). */
export const statusWord = (fulfilment: OrderResponse["fulfilment"], status: OrderStatus): string =>
  fulfilment === "pickup" && status === "ready" ? strings.order.pickupReady : strings.order.statuses[status];

/** How Place order went: placed, no answer, the cart changed (with the cart as it is now), the address gone, or a refusal. */
export type Placed =
  | { kind: "placed"; order: OrderResponse }
  | { kind: "offline" }
  | { kind: "changed"; cart: CartResponse | null }
  | { kind: "gone" }
  | { kind: "error"; code: ErrorCode };

/**
 * Places the cart C07 shows, at the revision and total on screen: for delivery to the chosen address (#424), or as a pickup, which sends the place the
 * cart was priced for and the pickup's own total (FUL-7, #65).
 */
export async function placeOrder(
  client: { placeOrder(shopId: string, body: PlaceOrderBody): Promise<ApiResult<OrderResponse>> },
  shopId: string,
  cart: CartResponse,
  to: string | { pickup: FeedQuery },
): Promise<Placed> {
  let answer;
  try {
    // The route asked for is not in this cart (a mode switched off since it was read): the cart as it is now is the answer.
    if (typeof to === "string") {
      if (!cart.quote) return { kind: "changed", cart };
      answer = await client.placeOrder(shopId, { revision: cart.revision, total: cart.quote.total, addressId: to });
    } else if (cart.pickup) answer = await client.placeOrder(shopId, { revision: cart.revision, total: cart.pickup.total, fulfilment: "pickup", ...to.pickup });
    else return { kind: "changed", cart };
  } catch {
    return { kind: "offline" };
  }
  if (answer.ok) return { kind: "placed", order: answer.data };
  if (answer.code === "CART_CHANGED") return { kind: "changed", cart: answer.cart ?? null };
  // The address or the cart is gone, as when either was removed or placed from another phone.
  if (answer.code === "NOT_FOUND") return { kind: "gone" };
  return { kind: "error", code: answer.code };
}

/** C09 and C19 refresh this often while the screen is in front (owner's answer 9 on #427). */
export const pollEvery = 10_000;

export type OrderView = {
  status: "loading" | "ready" | "failed";
  order: OrderResponse | null;
  /** Why the order couldn't be read. */
  message: string | null;
  /** A pull to refresh is on its way. */
  refreshing: boolean;
  cancelling: boolean;
  /** The ask to cancel is on its way (ORD-5, #59). */
  asking: boolean;
  confirmingItems: boolean;
  /** Confirming a partial acceptance proposal is on its way (C10, #64, #528). */
  confirmingTotal: boolean;
  /** Declining a partial acceptance proposal is on its way (C10, #64, #528). */
  decliningTotal: boolean;
  /** Why Cancel didn't go through. */
  notice: string | null;
};

type Client = {
  order(id: string): Promise<ApiResult<OrderResponse>>;
  cancelOrder(id: string): Promise<ApiResult<OrderResponse>>;
  askToCancelOrder(id: string): Promise<ApiResult<OrderResponse>>;
  confirmOrderItems(id: string): Promise<ApiResult<OrderResponse>>;
  confirmOrderTotal(id: string): Promise<ApiResult<OrderResponse>>;
  declineOrderTotal(id: string): Promise<ApiResult<OrderResponse>>;
};

/**
 * One order on C09/C19. While started it reads the order every `every` ms, and stops on its own
 * once the status is final (owner's improvement on #52); `seed` is the order placement answered with.
 */
export function createOrder(client: Client, id: string, seed?: OrderResponse, timers: Timers = phoneTimers, every = pollEvery) {
  let view: OrderView = {
    status: seed ? "ready" : "loading",
    order: seed ?? null,
    message: null,
    refreshing: false,
    cancelling: false,
    asking: false,
    confirmingItems: false,
    confirmingTotal: false,
    decliningTotal: false,
    notice: null,
  };
  // Each read and Cancel takes a ticket, so an older answer never replaces a newer one.
  const poller = createPoller(() => void read(), every, timers);
  const listeners = new Set<() => void>();

  const set = (next: Partial<OrderView>) => {
    view = { ...view, ...next };
    for (const listener of listeners) listener();
  };
  const final = () => view.order !== null && isFinal(shownStatus(view.order));
  const schedule = () => poller.schedule(!final());

  async function read(pull = false) {
    // Cancel's answer is the newest word on the order; a read waits until it lands.
    if (view.cancelling || view.asking || view.confirmingItems || view.confirmingTotal || view.decliningTotal) return;
    const latest = poller.ticket();
    poller.unschedule();
    if (pull) set({ refreshing: true });
    else if (!view.order) set({ status: "loading", message: null });
    const answer = await client.order(id).catch(() => "offline" as const);
    if (!latest()) return;
    if (answer !== "offline" && answer.ok) set({ status: "ready", order: answer.data, message: null, refreshing: false });
    else {
      const message = answer === "offline" ? strings.area.offline : strings.errors[answer.code];
      set({ status: view.order ? "ready" : "failed", message, refreshing: false });
    }
    schedule();
  }

  /** Confirm or Decline was refused as too late or out of date: the server decides, so say what the order now is (#578). */
  async function settleChangedTotal(code: "CONFIRMATION_EXPIRED" | "ORDER_STATUS_CHANGED") {
    await read();
    const words = strings.order.changedTotal;
    const status = view.order?.status;
    set({ notice: status === "cancelled_by_customer" ? words.timeUpBody : status === "awaiting_customer_confirm" ? (code === "ORDER_STATUS_CHANGED" ? words.changedAgain : words.timeUpPending) : words.noLongerWaiting });
  }

  return {
    get: () => view,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    /** The screen is in front: read now and keep reading, unless the order has ended. */
    start() {
      poller.start();
      if (!final()) void read();
    },

    /** The screen closed or the app went to the background. */
    stop() {
      poller.stop();
    },

    /** Pull to refresh, and Try again after a failed read. */
    refresh: () => read(true),
    retry: () => read(),

    /** Free while the shop hasn't answered (ORD-5); the Customer confirmed it first. */
    async cancel() {
      if (view.cancelling) return;
      // An older read landing after this must not bring back the placed status.
      poller.ticket();
      poller.unschedule();
      set({ cancelling: true, notice: null });
      const answer = await client.cancelOrder(id).catch(() => "offline" as const);
      // A pull to refresh dropped by the ticket above is over too.
      set({ cancelling: false, refreshing: false });
      if (answer !== "offline" && answer.ok) {
        set({ status: "ready", order: answer.data });
        schedule();
      } else if (answer !== "offline" && (answer.code === "ORDER_STATUS_CHANGED" || answer.code === "ORDER_EXPIRED")) {
        // The shop answered first, or its time ran out before the next read showed it; asking it to cancel comes later (#59).
        set({ notice: answer.code === "ORDER_EXPIRED" ? strings.errors.ORDER_EXPIRED : strings.order.answered });
        await read();
      } else {
        set({ notice: answer === "offline" ? strings.order.cancelOffline : strings.errors[answer.code] });
        // A read dropped while Cancel was on its way didn't set the next one.
        schedule();
      }
    },

    /** After acceptance the shop must agree (ORD-5, #59). Never sent twice: a stale or offline answer is shown, the order read again, and the Customer asks again by hand. */
    async ask() {
      if (view.asking) return;
      poller.ticket();
      poller.unschedule();
      set({ asking: true, notice: null });
      const answer = await client.askToCancelOrder(id).catch(() => "offline" as const);
      set({ asking: false, refreshing: false });
      if (answer !== "offline" && answer.ok) {
        set({ status: "ready", order: answer.data });
        schedule();
        return;
      }
      // The notice stays whatever the read says; a failed read only sets `message`.
      set({ notice: answer === "offline" ? strings.order.askOffline : strings.errors[answer.code] });
      await read();
    },

    async confirmItems() {
      if (view.confirmingItems || view.order?.status !== "arrived") return;
      poller.ticket();
      poller.unschedule();
      set({ confirmingItems: true, notice: null });
      const answer = await client.confirmOrderItems(id).catch(() => "offline" as const);
      set({ confirmingItems: false, refreshing: false });
      if (answer !== "offline" && answer.ok) {
        set({ status: "ready", order: answer.data });
        schedule();
      } else {
        set({ notice: answer === "offline" ? strings.order.itemsOffline : strings.errors[answer.code] });
        if (answer !== "offline" && answer.code === "ORDER_STATUS_CHANGED") await read();
        else schedule();
      }
    },

    /** C10: Customer confirms partial acceptance proposal (ORD-4, #64, #528). */
    async confirmTotal() {
      if (view.confirmingTotal || view.decliningTotal || view.order?.status !== "awaiting_customer_confirm") return;
      poller.ticket();
      poller.unschedule();
      set({ confirmingTotal: true, notice: null });
      const answer = await client.confirmOrderTotal(id).catch(() => "offline" as const);
      set({ confirmingTotal: false, refreshing: false });
      if (answer !== "offline" && answer.ok) {
        set({ status: "ready", order: answer.data, notice: null });
        schedule();
      } else if (answer !== "offline" && (answer.code === "CONFIRMATION_EXPIRED" || answer.code === "ORDER_STATUS_CHANGED")) {
        await settleChangedTotal(answer.code);
      } else {
        // Network or server error: keep screen, show inline error with retry, keep countdown running.
        set({ notice: answer === "offline" ? strings.order.changedTotal.confirmFailed : strings.errors[answer.code] });
        schedule();
      }
    },

    /** C10: Customer declines partial acceptance proposal; cancels order at no cost with reason declined_total (ORD-4, #64, #528). */
    async declineTotal() {
      if (view.confirmingTotal || view.decliningTotal || view.order?.status !== "awaiting_customer_confirm") return;
      poller.ticket();
      poller.unschedule();
      set({ decliningTotal: true, notice: null });
      const answer = await client.declineOrderTotal(id).catch(() => "offline" as const);
      set({ decliningTotal: false, refreshing: false });
      if (answer !== "offline" && answer.ok) {
        set({ status: "ready", order: answer.data, notice: null });
        schedule();
      } else if (answer !== "offline" && (answer.code === "CONFIRMATION_EXPIRED" || answer.code === "ORDER_STATUS_CHANGED")) {
        await settleChangedTotal(answer.code);
      } else {
        set({ notice: answer === "offline" ? strings.order.changedTotal.declineFailed : strings.errors[answer.code] });
        schedule();
      }
    },
  };
}

export type Order = ReturnType<typeof createOrder>;
