import type { ApiResult } from "@ygo/api-client";
import type {
  OrderLine,
  OrderStatus,
  PartialAcceptLine,
  PartialAcceptOrderBody,
  PartialAcceptPreviewResponse,
  RejectReason,
  ShopOrderResponse,
  ShopOrderSummary,
  ShopOrdersResponse,
  ShortLine,
} from "@ygo/contracts";
import { formatNumber } from "@ygo/format";
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

/** The oldest New order with time left, pinned on S03 (#507): one whose time ran out gives way before the next read. */
export const waitingOrder = (orders: ShopOrdersResponse | null, offset: number, phoneNow: number) =>
  orders?.new.find((order) => !order.expiresAt || secondsLeft(order.expiresAt, offset, phoneNow) > 0) ?? null;

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

/** The encrypted copy of My deliveries and its orders (#617), read when the phone cannot reach the server. Each call may fail; the screen then simply has no copy. */
export type DeliveryCache = {
  saveList(list: ShopOrderSummary[]): Promise<void>;
  list(): Promise<ShopOrderSummary[] | null>;
  saveOrder(order: ShopOrderResponse, offset: number): Promise<void>;
  order(id: string): Promise<{ order: ShopOrderResponse; offset: number } | null>;
};

export type ListView = {
  status: "loading" | "ready" | "failed";
  orders: ShopOrdersResponse | null;
  /** ms the server's clock is ahead of the phone's, from the last answer, for the countdown pinned on S03 (#507). */
  offset: number;
  message: string | null;
  refreshing: boolean;
  /** My deliveries as last read online, shown while the server can't be reached. */
  cached: ShopOrderSummary[] | null;
};

/** S04, and the order pinned on S03 (#507): reads the three groups now and every `every` ms while started. */
export function createShopOrders(client: { shopOrders(): Promise<ApiResult<ShopOrdersResponse>> }, timers: Timers = phoneTimers, every = pollEvery, now = Date.now, cache?: Pick<DeliveryCache, "saveList"> & Partial<Pick<DeliveryCache, "list">>) {
  let view: ListView = { status: "loading", orders: null, offset: 0, message: null, refreshing: false, cached: null };
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
    if (answer !== "offline" && answer.ok) {
      set({ status: "ready", orders: answer.data, offset: clockOffset(answer.data.now, now()), message: null, refreshing: false, cached: null });
      if (answer.data.canDeliver) void cache?.saveList(answer.data.myDeliveries).catch(() => undefined);
    } else {
      // No answer at all (not a refusal): the shop's own deliveries still show from the encrypted copy.
      const saved = answer === "offline" ? await cache?.list?.().catch(() => null) ?? null : null;
      if (!latest()) return;
      set({ status: view.orders || saved ? "ready" : "failed", message: failure(answer), refreshing: false, cached: saved });
    }
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
  answering: "accept" | "reject" | "agree" | "keep" | "cancel" | "partial_accept" | null;
  /** Why Accept, Reject, Agree, Keep or Cancel didn't go through. */
  notice: string | null;
  shortLines: ShortLine[];
  /** The server said the time is up, whatever the phone's clock shows. */
  expired: boolean;
  /** The order is the encrypted copy from the last online read, as the server can't be reached (#617). */
  cached: boolean;
  /** The latest read got no answer: the phone has no internet now, even though this order was read earlier while online (#617). */
  offline: boolean;
};

type OrderClient = {
  shopOrder(id: string): Promise<ApiResult<ShopOrderResponse>>;
  acceptOrder(id: string): Promise<ApiResult<ShopOrderResponse>>;
  rejectOrder(id: string, body: { reason: RejectReason }): Promise<ApiResult<ShopOrderResponse>>;
  previewPartialAccept?: (id: string, body: PartialAcceptOrderBody) => Promise<ApiResult<PartialAcceptPreviewResponse>>;
  partialAcceptOrder?: (id: string, body: PartialAcceptOrderBody) => Promise<ApiResult<ShopOrderResponse>>;
  answerCancelRequest(id: string, answer: "agree" | "keep"): Promise<ApiResult<ShopOrderResponse>>;
  cancelShopOrder(id: string, body: { reason: RejectReason }): Promise<ApiResult<ShopOrderResponse>>;
};

/** S05: one order, read every `every` ms while started and still New, accepted or preparing; Accept and Reject answer it. */
export function createShopOrder(client: OrderClient, id: string, timers: Timers = phoneTimers, every = pollEvery, now = Date.now, cache?: DeliveryCache) {
  let view: OrderView = {
    status: "loading", order: null, offset: 0, message: null, refreshing: false, answering: null, notice: null, shortLines: [], expired: false, cached: false, offline: false,
  };
  const { notify, subscribe } = listeners();
  const set = (next: Partial<OrderView>) => {
    view = { ...view, ...next };
    notify();
  };
  const poller = createPoller(() => void read(), every, timers);
  // Still New and in time, or accepted, preparing, or awaiting customer confirm: only then is the order read again.
  const waiting = () => view.order === null || (view.order.status === "placed" && !view.expired) || view.order.status === "accepted" || view.order.status === "preparing" || view.order.status === "awaiting_customer_confirm";

  // The server marks no order expired when its time runs out, so the store does, by the server's clock.
  let expiry: unknown;
  const disarm = () => {
    if (expiry !== undefined) timers.clear(expiry);
    expiry = undefined;
  };
  function arm() {
    disarm();
    const { order } = view;
    if (view.expired || order?.status !== "placed" || !order.expiresAt) return;
    const left = Date.parse(order.expiresAt) - (now() + view.offset);
    if (left > 0) expiry = timers.set(arm, left);
    else {
      poller.unschedule();
      set({ expired: true });
    }
  }

  const landed = (order: ShopOrderResponse, also: Partial<OrderView> = {}) => {
    const offset = clockOffset(order.now, now());
    set({ status: "ready", order, offset, message: null, refreshing: false, cached: false, offline: false, ...also });
    void cache?.saveOrder(order, offset).catch(() => undefined);
    arm();
  };

  async function read(pull = false, forAnswer = false) {
    // The answer to Accept or Reject is the newest word on the order; a read waits until it lands.
    if (view.answering && !forAnswer) return;
    // Time is up: nothing reads the order again, whether a poll, a pull, Try again, a resume or an answer.
    if (view.expired) return;
    const latest = poller.ticket();
    poller.unschedule();
    if (pull) set({ refreshing: true });
    else if (!view.order) set({ status: "loading", message: null });
    const answer = await client.shopOrder(id).catch(() => "offline" as const);
    if (!latest()) return;
    if (answer !== "offline" && answer.ok) landed(answer.data);
    else {
      // No answer at all: a delivery of this shop shows from the encrypted copy, its clock as it was when read.
      const saved = !view.order && answer === "offline" ? await cache?.order(id).catch(() => null) ?? null : null;
      if (!latest()) return;
      if (saved) set({ status: "ready", order: saved.order, offset: saved.offset, message: failure(answer), refreshing: false, cached: true, offline: true });
      else set({ status: view.order ? "ready" : "failed", message: failure(answer), refreshing: false, offline: answer === "offline" });
    }
    poller.schedule(waiting());
  }

  /** True when the order was answered, so S05 goes back to S04. */
  async function answer(kind: "accept" | "reject", send: () => Promise<ApiResult<ShopOrderResponse>>): Promise<boolean> {
    // Time is up: the buttons are off, and nothing is sent.
    if (view.answering || view.expired) return false;
    // An older read landing after this must not bring back the placed status.
    poller.ticket();
    poller.unschedule();
    set({ answering: kind, notice: null, shortLines: [], refreshing: false });
    const result = await send().catch(() => "offline" as const);
    // The buttons stay off until the answer and anything read for it have landed.
    if (result !== "offline" && result.ok) {
      landed(result.data, { answering: null });
      return true;
    }
    if (result !== "offline" && result.code === "ORDER_STATUS_CHANGED") {
      // The customer cancelled, or another phone of the shop answered first (owner's answer 7 on #431).
      await read(false, true);
      const status = view.order?.status;
      const notice = status === "cancelled_by_customer" ? words.cancelledByCustomer
        // Still New here means the read failed, so the order's new state is unknown.
        : status === "placed" ? view.message ?? strings.errors.ORDER_STATUS_CHANGED
        : words.answered;
      set({ answering: null, notice });
      return false;
    }
    if (result !== "offline" && result.code === "ORDER_EXPIRED") {
      // No read after this: the server would still say New.
      disarm();
      set({ answering: null, notice: strings.errors.ORDER_EXPIRED, expired: true });
      return false;
    }
    set({ answering: null, notice: failure(result), shortLines: result !== "offline" && !result.ok ? result.shortLines ?? [] : [] });
    // A read dropped while the answer was on its way didn't set the next one.
    poller.schedule(waiting());
    return false;
  }

  /**
   * Agree, Keep and Cancel an accepted order (ORD-5, #59). A refused or offline answer is shown, the order is read again and
   * nothing is sent twice; the notice stays even when that read fails. True when the order changed.
   */
  async function settle(kind: "agree" | "keep" | "cancel", send: () => Promise<ApiResult<ShopOrderResponse>>): Promise<boolean> {
    if (view.answering) return false;
    poller.ticket();
    poller.unschedule();
    set({ answering: kind, notice: null, shortLines: [], refreshing: false });
    const result = await send().catch(() => "offline" as const);
    if (result !== "offline" && result.ok) {
      landed(result.data, { answering: null });
      poller.schedule(waiting());
      return true;
    }
    set({ notice: failure(result) });
    await read(false, true);
    set({ answering: null });
    return false;
  }

  return {
    get: () => view,
    subscribe,
    start() {
      poller.start();
      // Back in front: an order whose time ran out meanwhile is marked expired, not read.
      arm();
      if (waiting()) void read();
    },
    stop() {
      disarm();
      poller.stop();
    },
    refresh: () => read(true),
    retry: () => read(),
    accept: () => answer("accept", () => client.acceptOrder(id)),
    reject: (reason: RejectReason) => answer("reject", () => client.rejectOrder(id, { reason })),
    previewPartialAccept: (lines: PartialAcceptLine[]): Promise<ApiResult<PartialAcceptPreviewResponse>> =>
      client.previewPartialAccept ? client.previewPartialAccept(id, { lines }) : Promise.resolve({ ok: false as const, status: 500, code: "INTERNAL" as const }),
    partialAccept: async (lines: PartialAcceptLine[]): Promise<boolean> => {
      if (!client.partialAcceptOrder || view.answering || view.expired) return false;
      poller.ticket();
      poller.unschedule();
      set({ answering: "partial_accept", notice: null, shortLines: [], refreshing: false });
      const result = await client.partialAcceptOrder(id, { lines }).catch(() => "offline" as const);
      if (result !== "offline" && result.ok) {
        landed(result.data, { answering: null });
        poller.schedule(waiting());
        return true;
      }
      if (result !== "offline" && result.code === "ORDER_STATUS_CHANGED") {
        await read(false, true);
        const status = view.order?.status;
        const notice = status === "cancelled_by_customer" ? words.cancelledByCustomer
          : status === "placed" || status === "accepted" || status === "preparing" ? view.message ?? strings.errors.ORDER_STATUS_CHANGED
          : words.answered;
        set({ answering: null, notice });
        return false;
      }
      if (result !== "offline" && result.code === "ORDER_EXPIRED") {
        disarm();
        set({ answering: null, notice: strings.errors.ORDER_EXPIRED, expired: true });
        return false;
      }
      if (result !== "offline" && result.code === "PROPOSAL_OPEN") {
        await read(false, true);
        set({ answering: null, notice: strings.errors.PROPOSAL_OPEN });
        return false;
      }
      set({ answering: null, notice: failure(result), shortLines: result !== "offline" && !result.ok ? result.shortLines ?? [] : [] });
      poller.schedule(waiting());
      return false;
    },
    agree: () => settle("agree", () => client.answerCancelRequest(id, "agree")),
    keep: () => settle("keep", () => client.answerCancelRequest(id, "keep")),
    cancel: (reason: RejectReason) => settle("cancel", () => client.cancelShopOrder(id, { reason })),
  };
}

export type ShopOrder = ReturnType<typeof createShopOrder>;
