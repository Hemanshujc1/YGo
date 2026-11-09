import type { ApiResult } from "@ygo/api-client";
import type { OrderSummary, OrdersResponse } from "@ygo/contracts";
import { createPoller, phoneTimers, type Timers } from "@ygo/mobile/poller";
import { AppState, type AppStateStatus } from "react-native";
import { api, session } from "../api";
import { push } from "./push";

export type ChangedTotalBannerView = {
  order: OrderSummary | null;
};

/** Finds the active order with status `awaiting_customer_confirm` having the earliest `confirmByAt` (#528). */
export function earliestAwaitingOrder(orders: readonly OrderSummary[] | undefined | null): OrderSummary | null {
  if (!orders || orders.length === 0) return null;
  const waiting = orders.filter(
    (o) => o.status === "awaiting_customer_confirm" && o.confirmByAt !== null,
  );
  if (waiting.length === 0) return null;
  return waiting.reduce((earliest, current) => {
    if (!earliest.confirmByAt) return current;
    if (!current.confirmByAt) return earliest;
    return Date.parse(current.confirmByAt) < Date.parse(earliest.confirmByAt) ? current : earliest;
  });
}

export function createChangedTotalBannerStore(
  client: { orders(): Promise<ApiResult<OrdersResponse>> },
  authSession: { get(): { status: string }; subscribe(listener: () => void): () => void },
  onPushReceived?: (cb: () => void) => () => void,
  timers: Timers = phoneTimers,
  pollEvery = 10_000,
) {
  let view: ChangedTotalBannerView = { order: null };
  const listeners = new Set<() => void>();
  const poller = createPoller(() => void read(), pollEvery, timers);
  let unsubs: Array<() => void> = [];
  let started = false;

  const isSignedIn = () => authSession.get().status === "signed-in";

  const set = (next: ChangedTotalBannerView) => {
    view = next;
    for (const listener of listeners) listener();
  };

  async function read() {
    if (!isSignedIn()) {
      if (view.order) set({ order: null });
      poller.unschedule();
      return;
    }
    const latest = poller.ticket();
    poller.unschedule();
    try {
      const answer = await client.orders().catch(() => null);
      if (!latest()) return;
      if (answer && answer.ok) {
        const earliest = earliestAwaitingOrder(answer.data.active);
        set({ order: earliest });
      }
    } finally {
      if (latest() && isSignedIn()) {
        poller.schedule(true);
      }
    }
  }

  function attachListeners() {
    detachListeners();

    const appStateSub = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (state === "active" && isSignedIn()) {
        void read();
      }
    });
    unsubs.push(() => appStateSub.remove());

    const sessionUnsub = authSession.subscribe(() => {
      if (isSignedIn()) {
        void read();
      } else {
        set({ order: null });
        poller.unschedule();
      }
    });
    unsubs.push(sessionUnsub);

    const pushUnsub = onPushReceived?.(() => {
      if (isSignedIn()) {
        void read();
      }
    });
    if (pushUnsub) unsubs.push(pushUnsub);
  }

  function detachListeners() {
    for (const unsub of unsubs) unsub();
    unsubs = [];
  }

  return {
    get: () => view,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    refresh: () => read(),
    start() {
      if (!started) {
        started = true;
        attachListeners();
      }
      poller.start();
      void read();
    },
    stop() {
      started = false;
      poller.stop();
      detachListeners();
    },
  };
}

export const changedTotalBanner = createChangedTotalBannerStore(api, session, push.onReceived);

