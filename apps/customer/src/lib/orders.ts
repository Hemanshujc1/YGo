import type { ApiResult } from "@ygo/api-client";
import type { OrdersResponse } from "@ygo/contracts";
import { createPoller, phoneTimers, type Timers } from "@ygo/mobile/poller";
import { strings } from "../strings";
import { pollEvery } from "./order";

export type OrdersView = {
  status: "loading" | "ready" | "failed";
  orders: OrdersResponse | null;
  /** Why the list couldn't be read. */
  message: string | null;
  /** A pull to refresh is on its way. */
  refreshing: boolean;
};

/**
 * C18 (#426): reads the Customer's orders each time the screen comes to the front, then every `every` ms
 * only while an active order is shown.
 */
export function createOrders(client: { orders(): Promise<ApiResult<OrdersResponse>> }, timers: Timers = phoneTimers, every = pollEvery) {
  let view: OrdersView = { status: "loading", orders: null, message: null, refreshing: false };
  const poller = createPoller(() => void read(), every, timers);
  const listeners = new Set<() => void>();

  const set = (next: Partial<OrdersView>) => {
    view = { ...view, ...next };
    for (const listener of listeners) listener();
  };

  async function read(pull = false) {
    const latest = poller.ticket();
    poller.unschedule();
    if (pull) set({ refreshing: true });
    else if (!view.orders) set({ status: "loading", message: null });
    const answer = await client.orders().catch(() => "offline" as const);
    if (!latest()) return;
    if (answer !== "offline" && answer.ok) set({ status: "ready", orders: answer.data, message: null, refreshing: false });
    else {
      const message = answer === "offline" ? strings.area.offline : strings.errors[answer.code];
      set({ status: view.orders ? "ready" : "failed", message, refreshing: false });
    }
    poller.schedule((view.orders?.active.length ?? 0) > 0);
  }

  return {
    get: () => view,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** The screen is in front: read now. */
    start() {
      poller.start();
      void read();
    },
    /** The screen closed or the app went to the background. */
    stop: poller.stop,
    /** Pull to refresh, and Try again after a failed read. */
    refresh: () => read(true),
    retry: () => read(),
  };
}
