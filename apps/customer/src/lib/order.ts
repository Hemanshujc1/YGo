import type { ApiResult } from "@ygo/api-client";
import { type CartResponse, type ErrorCode, type OrderResponse, type OrderStatus, TERMINAL_ORDER_STATUSES } from "@ygo/contracts";
import { strings } from "../strings";

/** Who has to act, as the Customer sees it (design system section 6). */
export type Treatment = "needsYou" | "waiting" | "inProgress" | "completed" | "ended";

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

/** How Place order went: placed, no answer, the cart changed (with the cart as it is now), the address gone, or a refusal. */
export type Placed =
  | { kind: "placed"; order: OrderResponse }
  | { kind: "offline" }
  | { kind: "changed"; cart: CartResponse | null }
  | { kind: "addressGone" }
  | { kind: "error"; code: ErrorCode };

/** Places the cart C07 shows, at the revision and total on screen, for the chosen address (#424). */
export async function placeOrder(
  client: { placeOrder(shopId: string, body: { revision: number; total: string; addressId: string }): Promise<ApiResult<OrderResponse>> },
  shopId: string,
  cart: CartResponse & { quote: NonNullable<CartResponse["quote"]> },
  addressId: string,
): Promise<Placed> {
  let answer;
  try {
    answer = await client.placeOrder(shopId, { revision: cart.revision, total: cart.quote.total, addressId });
  } catch {
    return { kind: "offline" };
  }
  if (answer.ok) return { kind: "placed", order: answer.data };
  if (answer.code === "CART_CHANGED") return { kind: "changed", cart: answer.cart ?? null };
  // The address was removed or lost its pin on another phone.
  if (answer.code === "NOT_FOUND") return { kind: "addressGone" };
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
  /** Why Cancel didn't go through. */
  notice: string | null;
};

type Client = {
  order(id: string): Promise<ApiResult<OrderResponse>>;
  cancelOrder(id: string): Promise<ApiResult<OrderResponse>>;
};

/** Passed in, so the tests run the clock themselves. */
export type Timers = { set(run: () => void, ms: number): unknown; clear(handle: unknown): void };

const phoneTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * One order on C09/C19. While started it reads the order every `every` ms, and stops on its own
 * once the status is final (owner's improvement on #52); `seed` is the order placement answered with.
 */
export function createOrder(client: Client, id: string, seed?: OrderResponse, timers: Timers = phoneTimers, every = pollEvery) {
  let view: OrderView = { status: seed ? "ready" : "loading", order: seed ?? null, message: null, refreshing: false, cancelling: false, notice: null };
  let running = false;
  let timer: unknown;
  /** Raised by each read and by Cancel, so an older answer never replaces a newer one. */
  let ticket = 0;
  const listeners = new Set<() => void>();

  const set = (next: Partial<OrderView>) => {
    view = { ...view, ...next };
    for (const listener of listeners) listener();
  };
  const final = () => view.order !== null && isFinal(view.order.status);
  const unschedule = () => {
    if (timer !== undefined) timers.clear(timer);
    timer = undefined;
  };
  const schedule = () => {
    unschedule();
    if (running && !final()) timer = timers.set(() => {
      timer = undefined;
      void read();
    }, every);
  };

  async function read(pull = false) {
    const mine = ++ticket;
    unschedule();
    if (pull) set({ refreshing: true });
    else if (!view.order) set({ status: "loading", message: null });
    const answer = await client.order(id).catch(() => "offline" as const);
    if (mine !== ticket) return;
    if (answer !== "offline" && answer.ok) set({ status: "ready", order: answer.data, message: null, refreshing: false });
    else {
      const message = answer === "offline" ? strings.area.offline : strings.errors[answer.code];
      set({ status: view.order ? "ready" : "failed", message, refreshing: false });
    }
    schedule();
  }

  return {
    get: () => view,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    /** The screen is in front: read now and keep reading, unless the order has ended. */
    start() {
      running = true;
      if (!final()) void read();
    },

    /** The screen closed or the app went to the background. */
    stop() {
      running = false;
      unschedule();
    },

    /** Pull to refresh, and Try again after a failed read. */
    refresh: () => read(true),
    retry: () => read(),

    /** Free while the shop hasn't answered (ORD-5); the Customer confirmed it first. */
    async cancel() {
      if (view.cancelling) return;
      // An older read landing after this must not bring back the placed status.
      ticket += 1;
      set({ cancelling: true, notice: null });
      const answer = await client.cancelOrder(id).catch(() => "offline" as const);
      set({ cancelling: false });
      if (answer !== "offline" && answer.ok) {
        set({ status: "ready", order: answer.data });
        schedule();
      } else if (answer !== "offline" && answer.code === "ORDER_STATUS_CHANGED") {
        // The shop answered first; asking it to cancel comes later (#59).
        set({ notice: strings.order.answered });
        await read();
      } else {
        set({ notice: answer === "offline" ? strings.order.cancelOffline : strings.errors[answer.code] });
        // A read dropped while Cancel was on its way didn't set the next one.
        schedule();
      }
    },
  };
}

export type Order = ReturnType<typeof createOrder>;
