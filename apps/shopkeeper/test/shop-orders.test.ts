import type { ApiResult } from "@ygo/api-client";
import type { ShopOrderResponse, ShopOrdersResponse, ShortLine } from "@ygo/contracts";
import type { Timers } from "@ygo/mobile/poller";
import { describe, expect, it } from "vitest";
import { clock, clockOffset, createShopOrder, createShopOrders, lineLabel, secondsLeft, shortLabel } from "../src/lib/shop-orders";
import { strings } from "../src/strings";

const id = "7d2e9a4c-6b1f-4c3a-8e5d-0f2a4b6c8d1e";
const words = strings.orders;

const order = (status: ShopOrderResponse["status"] = "placed"): ShopOrderResponse => ({
  id, number: 1001, status, placedAt: "2030-01-01T00:00:00.000Z", expiresAt: status === "placed" ? "2030-01-01T00:10:00.000Z" : null,
  now: "2030-01-01T00:02:18.000Z",
  address: { label: "home", flat: "Flat 4B", areaLine: "Kothrud", pincode: "411038" },
  lines: [{ name: "Toor Dal", brand: null, baseUnit: "kg", quantity: "1", count: 2, part: null, unitPrice: "135.00", lineTotal: "270.00" }],
  productValue: "270.00", deliveryFee: "30.00", smallCartFee: null, total: "300.00", rejectReason: null,
});
const expires = "2030-01-01T00:10:00.000Z";
const line = order().lines[0] ?? never();
function never(): never {
  throw new Error("missing");
}
const list: ShopOrdersResponse = { now: "2030-01-01T00:02:18.000Z", new: [], accepted: [], doneToday: [] };
const ok = <T,>(data: T): ApiResult<T> => ({ ok: true, data });
const refused = (code: "ORDER_STATUS_CHANGED" | "ORDER_EXPIRED" | "NOT_ENOUGH_STOCK" | "INTERNAL", shortLines?: ShortLine[]) =>
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
    expect([...pending.values()].map(({ ms }) => ms)).toEqual([15_000]);
    fire();
    reads.shift()?.(ok(order("accepted")));
    await settle();
    expect(pending.size).toBe(0);
    one.stop();
    one.start();
    expect(reads).toHaveLength(0);
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
    // Still New, so it keeps reading.
    expect(pending.size).toBe(1);

    const rejecting = one.reject("out_of_stock");
    answers.shift()?.(refused("ORDER_EXPIRED"));
    await settle();
    reads.shift()?.(ok(order()));
    expect(await rejecting).toBe(false);
    expect(one.get()).toMatchObject({ notice: strings.errors.ORDER_EXPIRED, shortLines: [], expired: true, answering: null });
    expect(pending.size).toBe(0);
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
