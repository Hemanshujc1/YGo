import type { ApiResult } from "@ygo/api-client";
import type { OrderLine, OrderStatus, RejectReason, ShopOrderResponse, ShopOrdersResponse, ShortLine } from "@ygo/contracts";
import { formatMoney, formatNumber } from "@ygo/format";
import type { Treatment } from "@ygo/mobile";
import { packLabel } from "@ygo/mobile/pack-label";
import { createPoller, phoneTimers, type Timers } from "@ygo/mobile/poller";
import { strings } from "../strings";

const words = strings.orders;

/** Who has to act, as the shop sees it (design system section 6). */
export const treatments: Record<OrderStatus, Treatment> = {
  placed: "needsYou",
  scheduled_pending_review: "needsYou",
  awaiting_customer_confirm: "waiting",
  accepted: "inProgress",
  scheduled_confirmed: "inProgress",
  preparing: "inProgress",
  ready: "inProgress",
  out_for_delivery: "inProgress",
  arrived: "inProgress",
  delivered: "completed",
  picked_up: "completed",
  rejected_by_shop: "ended",
  expired: "ended",
  not_collected: "ended",
  cancelled_by_customer: "ended",
  cancelled_by_shop: "ended",
  delivery_failed: "ended",
};

/** S04 and S05 read again this often while in front (#431). */
export const pollEvery = 15_000;

export const money = (amount: string) => formatMoney(Number(amount));
export const pack = (quantity: string, baseUnit: OrderLine["baseUnit"]) => packLabel(quantity, baseUnit, words.units);

/** "2 × 1 kg", or "500 g of a 1 kg pack" for the part of a pack bought (#377). */
export const lineLabel = (line: OrderLine) => {
  const size = pack(line.quantity, line.baseUnit);
  return [line.brand, line.part ? words.part(pack(line.part, line.baseUnit), size) : `${line.count} × ${size}`].filter(Boolean).join(" · ");
};

/**
 * "Toor Dal 1 kg: 1 left, order needs 2"; `available` is in the base unit, so a whole-pack line rounds it down to packs,
 * and a part line reads "Toor Dal: 300 g left, order needs 500 g" (ShortLine in @ygo/contracts).
 */
export function shortLabel(line: ShortLine): string {
  if (line.part) return words.short(line.name, pack(line.available, line.baseUnit), pack(line.part, line.baseUnit));
  const left = Math.floor(Number(line.available) / Number(line.quantity));
  return words.short(`${line.name} ${pack(line.quantity, line.baseUnit)}`, formatNumber(left), formatNumber(line.count));
}

/** How far the server's clock is ahead of the phone's, from an answer's `now` and the phone's time it landed. */
export const clockOffset = (serverNow: string, phoneNow: number) => Date.parse(serverNow) - phoneNow;

/** Whole seconds until `expiresAt` by the server's clock, never below 0. */
export const secondsLeft = (expiresAt: string, offset: number, phoneNow: number) =>
  Math.max(0, Math.ceil((Date.parse(expiresAt) - (phoneNow + offset)) / 1000));

/** "7:42". */
export const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

const failure = (answer: ApiResult<unknown> | "offline") => (answer === "offline" ? words.offline : answer.ok ? null : strings.errors[answer.code]);

function listeners() {
  const all = new Set<() => void>();
  return {
    notify: () => all.forEach((listener) => listener()),
    subscribe(listener: () => void) {
      all.add(listener);
      return () => void all.delete(listener);
    },
  };
}

export type ListView = { status: "loading" | "ready" | "failed"; orders: ShopOrdersResponse | null; message: string | null; refreshing: boolean };

/** S04: reads the three groups now and every `every` ms while started. */
export function createShopOrders(client: { shopOrders(): Promise<ApiResult<ShopOrdersResponse>> }, timers: Timers = phoneTimers, every = pollEvery) {
  let view: ListView = { status: "loading", orders: null, message: null, refreshing: false };
  const { notify, subscribe } = listeners();
  const set = (next: Partial<ListView>) => {
    view = { ...view, ...next };
    notify();
  };
  const poller = createPoller(() => void read(), every, timers);

  async function read(pull = false) {
    const latest = poller.ticket();
    poller.unschedule();
    if (pull) set({ refreshing: true });
    else if (!view.orders) set({ status: "loading", message: null });
    const answer = await client.shopOrders().catch(() => "offline" as const);
    if (!latest()) return;
    if (answer !== "offline" && answer.ok) set({ status: "ready", orders: answer.data, message: null, refreshing: false });
    else set({ status: view.orders ? "ready" : "failed", message: failure(answer), refreshing: false });
    poller.schedule();
  }

  return {
    get: () => view,
    subscribe,
    start() {
      poller.start();
      void read();
    },
    stop: poller.stop,
    refresh: () => read(true),
    retry: () => read(),
  };
}

export type OrderView = {
  status: "loading" | "ready" | "failed";
  order: ShopOrderResponse | null;
  /** ms the server's clock is ahead of the phone's, from the last answer. */
  offset: number;
  message: string | null;
  refreshing: boolean;
  answering: "accept" | "reject" | null;
  /** Why Accept or Reject didn't go through. */
  notice: string | null;
  shortLines: ShortLine[];
  /** The server said the time is up, whatever the phone's clock shows. */
  expired: boolean;
};

type OrderClient = {
  shopOrder(id: string): Promise<ApiResult<ShopOrderResponse>>;
  acceptOrder(id: string): Promise<ApiResult<ShopOrderResponse>>;
  rejectOrder(id: string, body: { reason: RejectReason }): Promise<ApiResult<ShopOrderResponse>>;
};

/** S05: one order, read every `every` ms while started and still New; Accept and Reject answer it. */
export function createShopOrder(client: OrderClient, id: string, timers: Timers = phoneTimers, every = pollEvery, now = Date.now) {
  let view: OrderView = {
    status: "loading", order: null, offset: 0, message: null, refreshing: false, answering: null, notice: null, shortLines: [], expired: false,
  };
  const { notify, subscribe } = listeners();
  const set = (next: Partial<OrderView>) => {
    view = { ...view, ...next };
    notify();
  };
  const poller = createPoller(() => void read(), every, timers);
  const placed = () => view.order === null || view.order.status === "placed";
  const landed = (order: ShopOrderResponse) => set({ status: "ready", order, offset: clockOffset(order.now, now()), message: null, refreshing: false });

  async function read(pull = false) {
    // The answer to Accept or Reject is the newest word on the order; a read waits until it lands.
    if (view.answering) return;
    const latest = poller.ticket();
    poller.unschedule();
    if (pull) set({ refreshing: true });
    else if (!view.order) set({ status: "loading", message: null });
    const answer = await client.shopOrder(id).catch(() => "offline" as const);
    if (!latest()) return;
    if (answer !== "offline" && answer.ok) landed(answer.data);
    else set({ status: view.order ? "ready" : "failed", message: failure(answer), refreshing: false });
    poller.schedule(placed());
  }

  /** True when the order was answered, so S05 goes back to S04. */
  async function answer(kind: "accept" | "reject", send: () => Promise<ApiResult<ShopOrderResponse>>): Promise<boolean> {
    if (view.answering) return false;
    // An older read landing after this must not bring back the placed status.
    poller.ticket();
    poller.unschedule();
    set({ answering: kind, notice: null, shortLines: [], refreshing: false });
    const result = await send().catch(() => "offline" as const);
    set({ answering: null });
    if (result !== "offline" && result.ok) {
      landed(result.data);
      return true;
    }
    if (result !== "offline" && result.code === "ORDER_STATUS_CHANGED") {
      // The customer cancelled, or another phone of the shop answered first (owner's answer 7 on #431).
      await read();
      set({ notice: view.order?.status === "cancelled_by_customer" ? words.cancelledByCustomer : words.answered });
      return false;
    }
    if (result !== "offline" && result.code === "ORDER_EXPIRED") {
      set({ notice: strings.errors.ORDER_EXPIRED, expired: true });
      await read();
      return false;
    }
    set({ notice: failure(result), shortLines: result !== "offline" && !result.ok ? result.shortLines ?? [] : [] });
    // A read dropped while the answer was on its way didn't set the next one.
    poller.schedule(placed());
    return false;
  }

  return {
    get: () => view,
    subscribe,
    start() {
      poller.start();
      if (placed()) void read();
    },
    stop: poller.stop,
    refresh: () => read(true),
    retry: () => read(),
    accept: () => answer("accept", () => client.acceptOrder(id)),
    reject: (reason: RejectReason) => answer("reject", () => client.rejectOrder(id, { reason })),
  };
}

export type ShopOrder = ReturnType<typeof createShopOrder>;
