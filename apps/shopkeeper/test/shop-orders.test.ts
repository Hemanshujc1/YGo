import type { ApiResult } from "@ygo/api-client";
import { type CancelRequestStatus, RejectReason, type ShopOrderResponse, type ShopOrdersResponse, type ShortLine } from "@ygo/contracts";
import type { Timers } from "@ygo/mobile/poller";
import { describe, expect, it } from "vitest";
import { clock, clockOffset, createShopOrder, createShopOrders, lineLabel, secondsLeft, shortLabel, waitingOrder } from "../src/lib/shop-orders";
import { strings } from "../src/strings";

const id = "7d2e9a4c-6b1f-4c3a-8e5d-0f2a4b6c8d1e";
const words = strings.orders;

const order = (status: ShopOrderResponse["status"] = "placed"): ShopOrderResponse => ({
  id, number: 1001, status, placedAt: "2030-01-01T00:00:00.000Z", expiresAt: status === "placed" ? "2030-01-01T00:10:00.000Z" : null,
  now: "2030-01-01T00:02:18.000Z",
  fulfilment: "delivery", address: { label: "home", flat: "Flat 4B", areaLine: "Kothrud", pincode: "411038" },
  lines: [{ listingId: id, name: "Toor Dal", brand: null, baseUnit: "kg", quantity: "1", count: 2, part: null, unitPrice: "135.00", lineTotal: "270.00" }],
  productValue: "270.00", deliveryFee: "30.00", smallCartFee: null, pickupFee: null, total: "300.00", rejectReason: null,
  delivererId: null, customer: null, shopUpiId: null, deliveryPhotoAvailable: false, deliveryFailureReadyAt: null,
  confirmByAt: null, proposal: null, cancelRequest: null,
});
const expires = "2030-01-01T00:10:00.000Z";
const line = order().lines[0] ?? never();
function never(): never {
  throw new Error("missing");
}
const list: ShopOrdersResponse = { now: "2030-01-01T00:02:18.000Z", canDeliver: true, new: [], accepted: [], myDeliveries: [], doneToday: [] };
const ok = <T,>(data: T): ApiResult<T> => ({ ok: true, data });
const refused = (code: "CANCEL_REQUEST_CLOSED" | "ORDER_STATUS_CHANGED" | "PROPOSAL_OPEN" | "ORDER_EXPIRED" | "NOT_ENOUGH_STOCK" | "INTERNAL", shortLines?: ShortLine[]) =>
  ({ ok: false, status: 409, code, shortLines }) as ApiResult<never>;

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
    fire() {
      const due = [...pending.values()];
      pending.clear();
      for (const { run } of due) run();
    },
    /** Runs only the timers set for `ms`. */
    fireAt(ms: number) {
      for (const [handle, timer] of pending) {
        if (timer.ms !== ms) continue;
        pending.delete(handle);
        timer.run();
      }
    },
  };
}

/** A server whose answers the test hands out one at a time. */
function fakeServer() {
  const reads: Array<(answer: ApiResult<ShopOrderResponse>) => void> = [];
  const answers: Array<(answer: ApiResult<ShopOrderResponse>) => void> = [];
  const sent: unknown[] = [];
  const client = {
    shopOrder: () => new Promise<ApiResult<ShopOrderResponse>>((resolve) => reads.push(resolve)),
    acceptOrder: () => new Promise<ApiResult<ShopOrderResponse>>((resolve) => answers.push(resolve)),
    rejectOrder: (_: string, body: unknown) => {
      sent.push(body);
      return new Promise<ApiResult<ShopOrderResponse>>((resolve) => answers.push(resolve));
    },
    answerCancelRequest: (_: string, answer: string) => {
      sent.push(answer);
      return new Promise<ApiResult<ShopOrderResponse>>((resolve) => answers.push(resolve));
    },
    partialAcceptOrder: (_: string, body: unknown) => {
      sent.push(body);
      return new Promise<ApiResult<ShopOrderResponse>>((resolve) => answers.push(resolve));
    },
    cancelShopOrder: (_: string, body: unknown) => {
      sent.push(body);
      return new Promise<ApiResult<ShopOrderResponse>>((resolve) => answers.push(resolve));
    },
  };
  return { client, reads, answers, sent };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("what S04 and S05 show (#431)", () => {
  it("counts down by the server's clock, whatever the phone's clock says", () => {
    // The phone is 5 minutes behind the server.
    const phone = Date.parse("2030-01-01T00:02:18.000Z") - 300_000;
    const offset = clockOffset(order().now, phone);
    expect(secondsLeft(expires, offset, phone)).toBe(462);
    expect(clock(462)).toBe("7:42");
    expect(clock(59)).toBe("0:59");
    expect(secondsLeft(expires, offset, phone + 462_000)).toBe(0);
    expect(secondsLeft(expires, offset, phone + 999_000)).toBe(0);
  });

  it("reads whole packs and part packs, and names what a short line has left", () => {
    expect(lineLabel(line)).toBe("2 × 1 kg");
    expect(lineLabel({ ...line, brand: "Tata", part: "0.5", count: 1 })).toBe("Tata · 500 g of a 1 kg pack");
    const short = { name: "Toor Dal", brand: null, baseUnit: "kg", quantity: "2", count: 2, part: null, available: "3" } as const;
    expect(shortLabel(short)).toBe("Toor Dal 2 kg: 1 left, order needs 2");
    expect(shortLabel({ ...short, quantity: "1", count: 1, part: "0.5", available: "0.3" })).toBe("Toor Dal: 300 g left, order needs 500 g");
  });
});

describe("S04 Orders (#431)", () => {
  it("reads every 15 s while in front, keeps the groups on a failed read, and stops when it closes", async () => {
    const { timers, pending, fire } = fakeTimers();
    const answers: Array<ApiResult<ShopOrdersResponse> | Error> = [ok(list), new TypeError("Network request failed")];
    const orders = createShopOrders({ shopOrders: async () => {
      const next = answers.shift();
      if (!next || next instanceof Error) throw next;
      return next;
    } }, timers);
    orders.start();
    await settle();
    expect(orders.get()).toMatchObject({ status: "ready", orders: list });
    expect([...pending.values()].map(({ ms }) => ms)).toEqual([15_000]);
    fire();
    await settle();
    expect(orders.get()).toMatchObject({ status: "ready", orders: list, message: words.offline });
    orders.stop();
    expect(pending.size).toBe(0);
  });

  it("keeps how far the server's clock is ahead, for the countdown pinned on S03 (#507)", async () => {
    const phoneNow = Date.parse(list.now) - 4_000;
    const orders = createShopOrders({ shopOrders: async () => ok(list) }, fakeTimers().timers, 15_000, () => phoneNow);
    orders.start();
    await settle();
    expect(orders.get()).toMatchObject({ status: "ready", offset: 4_000 });
  });
});

describe("S05 New order (#431)", () => {
  it("reads every 15 s only while the order is New", async () => {
    const { timers, pending, fire } = fakeTimers();
    const { client, reads } = fakeServer();
    const one = createShopOrder(client, id, timers, 15_000, () => Date.parse("2030-01-01T00:02:18.000Z"));
    one.start();
    reads.shift()?.(ok(order()));
    await settle();
    expect(one.get()).toMatchObject({ status: "ready", offset: 0 });
    expect([...pending.values()].map(({ ms }) => ms).sort()).toEqual([15_000, 462_000]);
    fire();
    reads.shift()?.(ok(order("accepted")));
    await settle();
    // Accepted: the Customer may still ask to cancel, so it is read again (#59) until it is ready.
    expect([...pending.values()].map(({ ms }) => ms)).toEqual([15_000]);
    fire();
    reads.shift()?.(ok(order("ready")));
    await settle();
    expect(pending.size).toBe(0);
    one.stop();
    one.start();
    expect(reads).toHaveLength(0);
  });

  it("shows an ask to cancel that arrives while an accepted or preparing order is open, and stops once it is ready or ended", async () => {
    const { timers, pending, fire } = fakeTimers();
    const { client, reads } = fakeServer();
    const one = createShopOrder(client, id, timers, 15_000);
    one.start();
    reads.shift()?.(ok(order("accepted")));
    await settle();
    expect(one.get().order?.cancelRequest).toBeNull();
    fire();
    reads.shift()?.(ok({ ...order("accepted"), cancelRequest: { status: "asked", askedAt: "2030-01-01T00:05:00.000Z" } }));
    await settle();
    expect(one.get().order?.cancelRequest?.status).toBe("asked");
    fire();
    reads.shift()?.(ok({ ...order("preparing"), cancelRequest: { status: "asked", askedAt: "2030-01-01T00:05:00.000Z" } }));
    await settle();
    expect(pending.size).toBe(1);
    fire();
    reads.shift()?.(ok({ ...order("cancelled_by_customer"), cancelRequest: { status: "agreed", askedAt: "2030-01-01T00:05:00.000Z" } }));
    await settle();
    expect(pending.size).toBe(0);
    one.stop();
  });

  it("goes back to S04 once accepted or rejected, sending the chosen reason", async () => {
    const { client, reads, answers, sent } = fakeServer();
    const one = createShopOrder(client, id, fakeTimers().timers);
    one.start();
    reads.shift()?.(ok(order()));
    await settle();
    const accepting = one.accept();
    expect(one.get().answering).toBe("accept");
    answers.shift()?.(ok(order("accepted")));
    expect(await accepting).toBe(true);
    expect(one.get().order?.status).toBe("accepted");

    const rejecting = one.reject("too_busy");
    answers.shift()?.(ok(order("rejected_by_shop")));
    expect(await rejecting).toBe(true);
    expect(sent).toEqual([{ reason: "too_busy" }]);
  });

  it("accept in part: names the server's reason for an accepted order, and refreshes into a waiting proposal (#589)", async () => {
    const lines = [{ listingId: id, count: 1, reason: "out_of_stock" as const }];
    for (const [code, status, notice] of [
      ["ORDER_STATUS_CHANGED", "accepted", strings.errors.ORDER_STATUS_CHANGED],
      ["ORDER_STATUS_CHANGED", "rejected_by_shop", words.answered],
      ["PROPOSAL_OPEN", "awaiting_customer_confirm", strings.errors.PROPOSAL_OPEN],
    ] as const) {
      const { client, reads, answers } = fakeServer();
      const one = createShopOrder(client, id, fakeTimers().timers);
      one.start();
      reads.shift()?.(ok(order()));
      await settle();
      const sending = one.partialAccept(lines);
      answers.shift()?.(refused(code));
      await settle();
      reads.shift()?.(ok(order(status)));
      expect(await sending).toBe(false);
      expect(one.get()).toMatchObject({ notice, order: { status } });
    }
  });

  it("says the customer cancelled, or that another phone answered, from the order read again", async () => {
    for (const [status, notice] of [["cancelled_by_customer", words.cancelledByCustomer], ["rejected_by_shop", words.answered]] as const) {
      const { client, reads, answers } = fakeServer();
      const one = createShopOrder(client, id, fakeTimers().timers);
      one.start();
      reads.shift()?.(ok(order()));
      await settle();
      const accepting = one.accept();
      answers.shift()?.(refused("ORDER_STATUS_CHANGED"));
      await settle();
      reads.shift()?.(ok(order(status)));
      expect(await accepting).toBe(false);
      expect(one.get()).toMatchObject({ notice, order: { status } });
    }
  });

  it("keeps the buttons off while it reads again, and says so when that read fails", async () => {
    const { client, reads, answers } = fakeServer();
    const one = createShopOrder(client, id, fakeTimers().timers);
    one.start();
    reads.shift()?.(ok(order()));
    await settle();
    const accepting = one.accept();
    answers.shift()?.(refused("ORDER_STATUS_CHANGED"));
    await settle();
    expect(one.get().answering).toBe("accept");
    expect(await one.accept()).toBe(false);
    reads.shift()?.(refused("INTERNAL"));
    expect(await accepting).toBe(false);
    expect(one.get()).toMatchObject({ answering: null, notice: strings.errors.INTERNAL, order: { status: "placed" } });
  });

  it("stops reading once the time is up by the server's clock", async () => {
    const { client, reads } = fakeServer();
    const { timers, pending } = fakeTimers();
    const one = createShopOrder(client, id, timers, 15_000, () => Date.parse("2030-01-01T00:02:18.000Z"));
    one.start();
    reads.shift()?.(ok({ ...order(), now: "2030-01-01T00:10:00.000Z" }));
    await settle();
    expect(pending.size).toBe(0);
  });

  it("turns the buttons off when the server says the time is up, and lists the short lines", async () => {
    const { client, reads, answers } = fakeServer();
    const { timers, pending } = fakeTimers();
    const one = createShopOrder(client, id, timers);
    one.start();
    reads.shift()?.(ok(order()));
    await settle();

    const short = [{ name: "Toor Dal", brand: null, baseUnit: "kg", quantity: "1", count: 2, part: null, available: "1" }] satisfies ShortLine[];
    const accepting = one.accept();
    answers.shift()?.(refused("NOT_ENOUGH_STOCK", short));
    expect(await accepting).toBe(false);
    expect(one.get()).toMatchObject({ notice: strings.errors.NOT_ENOUGH_STOCK, shortLines: short, expired: false });
    // Still New, so it keeps reading (and the expiry timer stays set).
    expect([...pending.values()].map(({ ms }) => ms)).toContain(15_000);

    const rejecting = one.reject("out_of_stock");
    answers.shift()?.(refused("ORDER_EXPIRED"));
    expect(await rejecting).toBe(false);
    expect(reads).toHaveLength(0);
    expect(one.get()).toMatchObject({ notice: strings.errors.ORDER_EXPIRED, shortLines: [], expired: true, answering: null });
    expect(pending.size).toBe(0);
  });

  it("marks the order expired when the countdown reaches 0, dropping the pending read, and reads nothing on resume", async () => {
    const { client, reads } = fakeServer();
    const { timers, pending, fire, fireAt } = fakeTimers();
    let phone = Date.parse("2030-01-01T00:02:18.000Z");
    const one = createShopOrder(client, id, timers, 15_000, () => phone);
    one.start();
    reads.shift()?.(ok(order()));
    await settle();
    expect(one.get().expired).toBe(false);
    expect([...pending.values()].map(({ ms }) => ms)).toContain(15_000);

    phone = Date.parse(expires);
    fireAt(462_000);
    expect(one.get()).toMatchObject({ expired: true, order: { status: "placed" } });
    expect(pending.size).toBe(0);
    fire();
    await settle();
    expect(reads).toHaveLength(0);

    // Into the background and back.
    one.stop();
    one.start();
    await settle();
    expect(reads).toHaveLength(0);
    expect(pending.size).toBe(0);
    expect(await one.accept()).toBe(false);

    // Pull to refresh and Try again fetch nothing either.
    await one.refresh();
    await one.retry();
    expect(reads).toHaveLength(0);
    expect(one.get()).toMatchObject({ refreshing: false, expired: true });
  });

  it("marks the order expired, without reading, when the time ran out in the background", async () => {
    const { client, reads } = fakeServer();
    const { timers, pending } = fakeTimers();
    let phone = Date.parse("2030-01-01T00:02:18.000Z");
    const one = createShopOrder(client, id, timers, 15_000, () => phone);
    one.start();
    reads.shift()?.(ok(order()));
    await settle();
    one.stop();
    expect(pending.size).toBe(0);

    phone = Date.parse(expires) + 60_000;
    one.start();
    await settle();
    expect(one.get().expired).toBe(true);
    expect(reads).toHaveLength(0);
    expect(pending.size).toBe(0);
  });

  it("still reads again after an answer while in time, but not once the time ran out during it", async () => {
    const { client, reads, answers } = fakeServer();
    const { timers, fireAt } = fakeTimers();
    let phone = Date.parse("2030-01-01T00:02:18.000Z");
    const one = createShopOrder(client, id, timers, 15_000, () => phone);
    one.start();
    reads.shift()?.(ok(order()));
    await settle();
    const accepting = one.accept();
    phone = Date.parse(expires);
    fireAt(462_000);
    answers.shift()?.(refused("ORDER_STATUS_CHANGED"));
    expect(await accepting).toBe(false);
    expect(reads).toHaveLength(0);
    expect(one.get()).toMatchObject({ answering: null, expired: true, notice: strings.errors.ORDER_STATUS_CHANGED });
  });

  it("drops a read that lands after Accept was tapped", async () => {
    const { client, reads, answers } = fakeServer();
    const { timers, fire } = fakeTimers();
    const one = createShopOrder(client, id, timers);
    one.start();
    reads.shift()?.(ok(order()));
    await settle();
    fire();
    const accepting = one.accept();
    answers.shift()?.(ok(order("accepted")));
    await accepting;
    reads.shift()?.(ok(order()));
    await settle();
    expect(one.get().order?.status).toBe("accepted");
  });
});

describe("S03's pinned order (#507)", () => {
  const summary = (number: number, expiresAt: string): ShopOrdersResponse["new"][number] => ({
    id: `${id.slice(0, -4)}${String(number).padStart(4, "0")}`, number, status: "placed", placedAt: "2030-01-01T00:00:00.000Z", expiresAt,
    itemCount: 1, total: "300.00", fulfilment: "delivery", address: { flat: "Flat 4B", areaLine: null }, delivererId: null, confirmByAt: null, cancelAsked: false,
  });

  it("pins the oldest New order with time left, and none when there is none", () => {
    const now = Date.parse(list.now);
    const orders = { ...list, new: [summary(1, "2030-01-01T00:02:18.000Z"), summary(2, "2030-01-01T00:05:00.000Z")] };
    expect(waitingOrder(orders, 0, now)?.number).toBe(2);
    expect(waitingOrder(orders, 0, now - 1_000)?.number).toBe(1);
    expect(waitingOrder(list, 0, now)).toBeNull();
    expect(waitingOrder(null, 0, now)).toBeNull();
  });
});

describe("cancelling after acceptance (ORD-5, #59)", () => {
  const asked = (status: ShopOrderResponse["status"], request: CancelRequestStatus = "asked"): ShopOrderResponse =>
    ({ ...order(status), cancelRequest: { status: request, askedAt: "2030-01-01T00:05:00.000Z" } });
  const started = async (first: ShopOrderResponse) => {
    const server = fakeServer();
    const clock = fakeTimers();
    const store = createShopOrder(server.client, id, clock.timers);
    store.start();
    server.reads.shift()?.(ok(first));
    await settle();
    return { server, store };
  };

  it("sends Agree and Keep, lands the answer, and reads nothing while it is on its way", async () => {
    const { server, store } = await started(asked("accepted"));
    const agreeing = store.agree();
    expect(store.get().answering).toBe("agree");
    expect(await store.agree()).toBe(false);
    server.answers.shift()?.(ok(asked("cancelled_by_customer", "agreed")));
    expect(await agreeing).toBe(true);
    expect(server.sent).toEqual(["agree"]);
    expect(store.get()).toMatchObject({ answering: null, notice: null, order: { status: "cancelled_by_customer", cancelRequest: { status: "agreed" } } });

    const kept = await started(asked("preparing"));
    const keeping = kept.store.keep();
    kept.server.answers.shift()?.(ok(asked("preparing", "kept")));
    expect(await keeping).toBe(true);
    expect(kept.server.sent).toEqual(["keep"]);
    expect(kept.store.get().order?.cancelRequest?.status).toBe("kept");
  });

  it.each(RejectReason.options)("cancels from accepted, preparing and ready with the reason %s", async (reason) => {
    for (const status of ["accepted", "preparing", "ready"] as const) {
      const { server, store } = await started(order(status));
      const cancelling = store.cancel(reason);
      expect(store.get().answering).toBe("cancel");
      server.answers.shift()?.(ok({ ...order("cancelled_by_shop"), rejectReason: reason }));
      expect(await cancelling).toBe(true);
      expect(server.sent).toEqual([{ reason }]);
      expect(store.get().order).toMatchObject({ status: "cancelled_by_shop", rejectReason: reason });
    }
  });

  it("shows a stale answer, reads the order again, sends nothing twice and keeps the notice when that read fails", async () => {
    const { server, store } = await started(asked("accepted"));
    const keeping = store.keep();
    server.answers.shift()?.(refused("CANCEL_REQUEST_CLOSED"));
    await settle();
    expect(store.get()).toMatchObject({ answering: "keep", notice: strings.errors.CANCEL_REQUEST_CLOSED });
    server.reads.shift()?.(ok(asked("ready", "closed_unanswered")));
    expect(await keeping).toBe(false);
    expect(store.get()).toMatchObject({ answering: null, notice: strings.errors.CANCEL_REQUEST_CLOSED, order: { status: "ready" } });
    expect(server.sent).toEqual(["keep"]);

    const failing = await started(asked("accepted"));
    const agreeing = failing.store.agree();
    failing.server.answers.shift()?.(refused("ORDER_STATUS_CHANGED"));
    await settle();
    failing.server.reads.shift()?.(refused("INTERNAL"));
    expect(await agreeing).toBe(false);
    expect(failing.store.get()).toMatchObject({ answering: null, notice: strings.errors.ORDER_STATUS_CHANGED, message: strings.errors.INTERNAL });
  });

  it("says it could not reach the server, then reads again", async () => {
    const server = fakeServer();
    const clock = fakeTimers();
    const client = { ...server.client, cancelShopOrder: () => Promise.reject(new Error("offline")) };
    const store = createShopOrder(client, id, clock.timers);
    store.start();
    server.reads.shift()?.(ok(order("accepted")));
    await settle();
    const cancelling = store.cancel("too_busy");
    await settle();
    expect(store.get().notice).toBe(words.offline);
    server.reads.shift()?.(ok(order("accepted")));
    expect(await cancelling).toBe(false);
    expect(store.get()).toMatchObject({ answering: null, notice: words.offline });
  });

  it("keeps cancelAsked on the S04 rows it reads", async () => {
    const row = { id, number: 1001, status: "accepted", placedAt: "2030-01-01T00:00:00.000Z", expiresAt: null, itemCount: 1, total: "300.00", fulfilment: "delivery", address: { flat: "Flat 4B", areaLine: null }, delivererId: null, confirmByAt: null } as const;
    const server = { shopOrders: async () => ok({ ...list, accepted: [{ ...row, cancelAsked: true }, { ...row, number: 1002, cancelAsked: false }] }) };
    const store = createShopOrders(server, fakeTimers().timers);
    store.start();
    await settle();
    expect(store.get().orders?.accepted.map((summary) => summary.cancelAsked)).toEqual([true, false]);
  });
});
