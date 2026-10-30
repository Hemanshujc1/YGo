import type { ApiResult } from "@ygo/api-client";
import type { OrderStatus, OrderSummary, OrdersResponse } from "@ygo/contracts";
import { describe, expect, it } from "vitest";
import type { Timers } from "../src/lib/order";
import { createOrders } from "../src/lib/orders";
import { strings } from "../src/strings";

const row = (number: number, status: OrderStatus): OrderSummary => ({
  id: `7d2e9a4c-6b1f-4c3a-8e5d-0f2a4b6c${String(number).padStart(4, "0")}`, number, status, placedAt: "2030-01-01T00:00:00.000Z",
  shop: { id: "5b0c7f1e-2a4d-4e8f-9b6a-1c3d5e7f9a0b", name: "Sai General Stores", phone: "+919876500001" }, total: "300.00", answerExpired: false,
});
const withActive: OrdersResponse = { active: [row(1002, "accepted")], past: [row(1001, "delivered")] };
const allPast: OrdersResponse = { active: [], past: [row(1002, "delivered"), row(1001, "cancelled_by_customer")] };
const ok = <T,>(data: T): ApiResult<T> => ({ ok: true, data });

function fakeTimers() {
  const pending = new Map<number, { run: () => void; ms: number }>();
  let next = 0;
  const timers: Timers = {
    set: (run, ms) => {
      pending.set(++next, { run, ms });
      return next;
    },
    clear: (handle) => void pending.delete(handle as number),
  };
  return {
    timers, pending,
    fire() {
      const due = [...pending.values()];
      pending.clear();
      for (const { run } of due) run();
    },
  };
}

function fakeServer() {
  const reads: Array<(answer: ApiResult<OrdersResponse>) => void> = [];
  return { client: { orders: () => new Promise<ApiResult<OrdersResponse>>((resolve) => reads.push(resolve)) }, reads };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("C18 order list (#426)", () => {
  it("reads on coming to the front, then every 10 s while an active order is shown", async () => {
    const server = fakeServer();
    const clock = fakeTimers();
    const store = createOrders(server.client, clock.timers);
    store.start();
    expect(store.get().status).toBe("loading");
    server.reads.shift()?.(ok(withActive));
    await settle();
    expect(store.get()).toMatchObject({ status: "ready", orders: withActive });
    expect([...clock.pending.values()].map((timer) => timer.ms)).toEqual([10_000]);
    clock.fire();
    expect(server.reads).toHaveLength(1);
  });

  it("stops polling once no order is active, and reads again only on return or a pull", async () => {
    const server = fakeServer();
    const clock = fakeTimers();
    const store = createOrders(server.client, clock.timers);
    store.start();
    server.reads.shift()?.(ok(withActive));
    await settle();
    clock.fire();
    server.reads.shift()?.(ok(allPast));
    await settle();
    expect(clock.pending.size).toBe(0);
    store.stop();
    store.start();
    expect(server.reads).toHaveLength(1);
    server.reads.shift()?.(ok(allPast));
    await settle();
    const pulling = store.refresh();
    expect(store.get().refreshing).toBe(true);
    server.reads.shift()?.(ok(allPast));
    await pulling;
    expect(store.get()).toMatchObject({ refreshing: false, orders: allPast });
    expect(clock.pending.size).toBe(0);
  });

  it("stops polling when the screen closes or the app goes to the background", async () => {
    const server = fakeServer();
    const clock = fakeTimers();
    const store = createOrders(server.client, clock.timers);
    store.start();
    server.reads.shift()?.(ok(withActive));
    await settle();
    store.stop();
    expect(clock.pending.size).toBe(0);
  });

  it("shows the empty list as it is, with nothing to poll", async () => {
    const server = fakeServer();
    const clock = fakeTimers();
    const store = createOrders(server.client, clock.timers);
    store.start();
    server.reads.shift()?.(ok({ active: [], past: [] }));
    await settle();
    expect(store.get()).toMatchObject({ status: "ready", orders: { active: [], past: [] }, message: null });
    expect(clock.pending.size).toBe(0);
  });

  it("fails with Try again when the first read can't reach the server, and keeps a shown list on a later failure", async () => {
    const server = { client: { orders: () => Promise.reject(new Error("offline")) } };
    const store = createOrders(server.client, fakeTimers().timers);
    await store.retry();
    expect(store.get()).toMatchObject({ status: "failed", orders: null, message: strings.area.offline });

    const later = fakeServer();
    const clock = fakeTimers();
    const shown = createOrders(later.client, clock.timers);
    shown.start();
    later.reads.shift()?.(ok(withActive));
    await settle();
    clock.fire();
    later.reads.shift()?.({ ok: false, status: 500, code: "INTERNAL" } as ApiResult<never>);
    await settle();
    expect(shown.get()).toMatchObject({ status: "ready", orders: withActive, message: strings.errors.INTERNAL });
    // Still an active order on screen, so it keeps reading.
    expect(clock.pending.size).toBe(1);
  });
});
