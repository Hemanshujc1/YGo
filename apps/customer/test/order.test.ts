import type { ApiResult } from "@ygo/api-client";
import { type CartResponse, OrderStatus, type OrderResponse, RejectReason } from "@ygo/contracts";
import { describe, expect, it } from "vitest";
import { createOrder, isFinal, placeOrder, shownStatus, type Timers, treatments } from "../src/lib/order";
import { strings } from "../src/strings";

const id = "7d2e9a4c-6b1f-4c3a-8e5d-0f2a4b6c8d1e";
const shopId = "5b0c7f1e-2a4d-4e8f-9b6a-1c3d5e7f9a0b";
const addressId = "0b6f3f1e-8f2a-4d6e-9a51-5c1d2e3f4a5b";

const order = (status: OrderStatus = "placed"): OrderResponse => ({
  id, number: 1001, status, placedAt: "2030-01-01T00:00:00.000Z",
  shop: { id: shopId, name: "Sai General Stores", phone: "+919876500001" },
  address: { label: "home", flat: "Flat 4B", areaLine: "Kothrud", pincode: "411038" },
  lines: [{ name: "Toor Dal", brand: null, baseUnit: "kg", quantity: "1", count: 2, part: null, unitPrice: "135.00", lineTotal: "270.00" }],
  productValue: "270.00", deliveryFee: "30.00", smallCartFee: null, total: "300.00", rejectReason: null, answerExpired: false,
});
const cart: CartResponse & { quote: NonNullable<CartResponse["quote"]> } = {
  shop: { id: shopId, name: "Sai General Stores" }, revision: 2, lines: [],
  quote: { productValue: "270.00", deliveryFee: "30.00", smallCartFee: null, total: "300.00" }, placeable: true, reasons: [],
};
const ok = <T,>(data: T): ApiResult<T> => ({ ok: true, data });
const refused = (code: "ORDER_STATUS_CHANGED" | "NOT_FOUND" | "CART_CHANGED" | "OWN_SHOP", status: number, more = {}) =>
  ({ ok: false, status, code, ...more }) as ApiResult<never>;

/** Timers the test runs by hand. */
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
    /** Fires every timer set so far. */
    fire() {
      const due = [...pending.values()];
      pending.clear();
      for (const { run } of due) run();
    },
  };
}

/** A server whose answers the test hands out one at a time. */
function fakeServer() {
  const reads: Array<(answer: ApiResult<OrderResponse>) => void> = [];
  const cancels: Array<(answer: ApiResult<OrderResponse>) => void> = [];
  const client = {
    order: () => new Promise<ApiResult<OrderResponse>>((resolve) => reads.push(resolve)),
    cancelOrder: () => new Promise<ApiResult<OrderResponse>>((resolve) => cancels.push(resolve)),
  };
  return { client, reads, cancels };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("placing the cart (#427)", () => {
  it("sends the revision and total C07 shows, and names each way it can go", async () => {
    const sent: unknown[] = [];
    const answering = (answer: ApiResult<OrderResponse> | Error) => ({
      placeOrder: async (shop: string, body: unknown) => {
        sent.push([shop, body]);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    });
    expect(await placeOrder(answering(ok(order())), shopId, cart, addressId)).toEqual({ kind: "placed", order: order() });
    expect(sent).toEqual([[shopId, { revision: 2, total: "300.00", addressId }]]);
    expect(await placeOrder(answering(new TypeError("Network request failed")), shopId, cart, addressId)).toEqual({ kind: "offline" });
    const now = { ...cart, revision: 3 };
    expect(await placeOrder(answering(refused("CART_CHANGED", 409, { cart: now })), shopId, cart, addressId)).toEqual({ kind: "changed", cart: now });
    expect(await placeOrder(answering(refused("NOT_FOUND", 404)), shopId, cart, addressId)).toEqual({ kind: "gone" });
    expect(await placeOrder(answering(refused("OWN_SHOP", 403)), shopId, cart, addressId)).toEqual({ kind: "error", code: "OWN_SHOP" });
  });
});

describe("order statuses (design system section 6)", () => {
  it("gives every status a Customer word and a look, and ends polling only on a final one", () => {
    for (const status of OrderStatus.options) {
      expect(strings.order.statuses[status]).toBeTruthy();
      expect(treatments[status]).toBeTruthy();
    }
    expect([strings.order.statuses.placed, treatments.placed]).toEqual(["Waiting for shop", "waiting"]);
    expect([treatments.arrived, treatments.delivered, treatments.expired]).toEqual(["needsYou", "completed", "ended"]);
    expect(OrderStatus.options.filter(isFinal)).toHaveLength(8);
  });

  it("words every reason the shop can reject with, as the shop's list does (#425)", () => {
    for (const reason of RejectReason.options) expect(strings.order.rejectReasons[reason]).toBeTruthy();
    expect(strings.order.rejectedBecause(strings.order.rejectReasons.out_of_stock)).toBe("The shop said: Items out of stock");
  });
});

describe("C09/C19 order (#427)", () => {
  it("opens on the placed order, then reads it every 10 s while the screen is in front", async () => {
    const server = fakeServer();
    const clock = fakeTimers();
    const store = createOrder(server.client, id, order(), clock.timers);
    expect(store.get()).toMatchObject({ status: "ready", order: { status: "placed" } });
    store.start();
    expect(server.reads).toHaveLength(1);
    server.reads.shift()?.(ok(order()));
    await settle();
    expect([...clock.pending.values()].map(({ ms }) => ms)).toEqual([10_000]);
    clock.fire();
    expect(server.reads).toHaveLength(1);
    server.reads.shift()?.(ok(order("accepted")));
    await settle();
    expect(store.get().order?.status).toBe("accepted");
    expect(clock.pending.size).toBe(1);
  });

  it("stops when the screen closes or the app goes to the background, and starts again on return", async () => {
    const server = fakeServer();
    const clock = fakeTimers();
    const store = createOrder(server.client, id, order(), clock.timers);
    store.start();
    server.reads.shift()?.(ok(order()));
    await settle();
    store.stop();
    expect(clock.pending.size).toBe(0);
    // A read on its way when the screen closed sets no next one.
    store.start();
    store.stop();
    server.reads.shift()?.(ok(order()));
    await settle();
    expect(clock.pending.size).toBe(0);
    store.start();
    expect(server.reads).toHaveLength(1);
  });

  it("stops for good on a final status, and doesn't read a final order again on return", async () => {
    const server = fakeServer();
    const clock = fakeTimers();
    const store = createOrder(server.client, id, order(), clock.timers);
    store.start();
    server.reads.shift()?.(ok(order("expired")));
    await settle();
    expect(clock.pending.size).toBe(0);
    store.stop();
    store.start();
    expect(server.reads).toHaveLength(0);
    // Pull to refresh still reads.
    const pulling = store.refresh();
    expect(store.get().refreshing).toBe(true);
    server.reads.shift()?.(ok(order("expired")));
    await pulling;
    expect(store.get()).toMatchObject({ refreshing: false, order: { status: "expired" } });
  });

  it("stops on a placed order past its answer time, showing it as the shop not answering (#426)", async () => {
    const server = fakeServer();
    const clock = fakeTimers();
    const store = createOrder(server.client, id, order(), clock.timers);
    store.start();
    const late = { ...order(), answerExpired: true };
    server.reads.shift()?.(ok(late));
    await settle();
    expect(shownStatus(late)).toBe("expired");
    expect(shownStatus(order())).toBe("placed");
    expect(clock.pending.size).toBe(0);
    store.stop();
    store.start();
    expect(server.reads).toHaveLength(0);
  });

  it("opened with no order, shows loading, then a failure with Try again, keeping polling", async () => {
    const server = fakeServer();
    const clock = fakeTimers();
    const store = createOrder(server.client, id, undefined, clock.timers);
    store.start();
    expect(store.get().status).toBe("loading");
    server.reads.shift()?.(refused("NOT_FOUND", 404));
    await settle();
    expect(store.get()).toMatchObject({ status: "failed", message: strings.errors.NOT_FOUND });
    expect(clock.pending.size).toBe(1);
    const retrying = store.retry();
    server.reads.shift()?.(ok(order()));
    await retrying;
    expect(store.get()).toMatchObject({ status: "ready", message: null, order: { number: 1001 } });
  });

  it("keeps the order shown when a later read can't reach the server", async () => {
    const server = fakeServer();
    const store = createOrder({ ...server.client, order: () => Promise.reject(new TypeError("offline")) }, id, order(), fakeTimers().timers);
    await store.retry();
    expect(store.get()).toMatchObject({ status: "ready", order: { status: "placed" }, message: strings.area.offline });
  });

  it("cancels, and an older read landing after it doesn't bring the placed status back", async () => {
    const server = fakeServer();
    const clock = fakeTimers();
    const store = createOrder(server.client, id, order(), clock.timers);
    store.start();
    const cancelling = store.cancel();
    expect(store.get().cancelling).toBe(true);
    server.cancels.shift()?.(ok(order("cancelled_by_customer")));
    await cancelling;
    server.reads.shift()?.(ok(order()));
    await settle();
    expect(store.get()).toMatchObject({ cancelling: false, notice: null, order: { status: "cancelled_by_customer" } });
    expect(clock.pending.size).toBe(0);
  });

  it("reads nothing while Cancel is on its way, so a read can't land after it with the placed status", async () => {
    const server = fakeServer();
    const clock = fakeTimers();
    const store = createOrder(server.client, id, order(), clock.timers);
    store.start();
    server.reads.shift()?.(ok(order()));
    await settle();
    const cancelling = store.cancel();
    expect(clock.pending.size).toBe(0);
    // The app comes back to the front while Cancel is on its way.
    store.start();
    expect(server.reads).toHaveLength(0);
    server.cancels.shift()?.(ok(order("cancelled_by_customer")));
    await cancelling;
    expect(store.get().order?.status).toBe("cancelled_by_customer");
  });

  it("stops the pull-to-refresh spinner when Cancel drops the pull's read", async () => {
    const server = fakeServer();
    const store = createOrder(server.client, id, order(), fakeTimers().timers);
    void store.refresh();
    const cancelling = store.cancel();
    server.cancels.shift()?.(ok(order("cancelled_by_customer")));
    await cancelling;
    server.reads.shift()?.(ok(order()));
    await settle();
    expect(store.get()).toMatchObject({ refreshing: false, order: { status: "cancelled_by_customer" } });
  });

  it("says the shop answered first when Cancel is refused, and reads the order again", async () => {
    const server = fakeServer();
    const store = createOrder(server.client, id, order(), fakeTimers().timers);
    const cancelling = store.cancel();
    server.cancels.shift()?.(refused("ORDER_STATUS_CHANGED", 409));
    await settle();
    expect(store.get().notice).toBe("The shop already answered this order, so it can't be cancelled here.");
    server.reads.shift()?.(ok(order("accepted")));
    await cancelling;
    expect(store.get().order?.status).toBe("accepted");
  });

  it("says Cancel didn't reach the server when offline, and keeps polling", async () => {
    const clock = fakeTimers();
    const server = fakeServer();
    const store = createOrder({ ...server.client, cancelOrder: () => Promise.reject(new TypeError("offline")) }, id, order(), clock.timers);
    store.start();
    await store.cancel();
    expect(store.get()).toMatchObject({ cancelling: false, notice: strings.order.cancelOffline, order: { status: "placed" } });
    expect(clock.pending.size).toBe(1);
  });
});
