import type { ApiResult } from "@ygo/api-client";
import type { CartLine, CartResponse, SaveCartBody } from "@ygo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cartBarLabel, createCart, feeText, nextSave, reasonText, rebase, saveBody, stockLeft, withCount } from "../src/lib/cart";

const shopId = "8a0e4f8e-1c55-4d3c-9b8e-6b6f1f7f2a10";
const place = { pincode: "411045", latitude: 18.56, longitude: 73.78 };
const atta = "3f1c2b9a-0d4e-4b7a-8c61-2e5f9d8a7b01";
const dal = "3f1c2b9a-0d4e-4b7a-8c61-2e5f9d8a7b02";

const line = (listingId: string, count: number, more: Partial<CartLine> = {}): CartLine => ({
  listingId, name: listingId === atta ? "Atta" : "Toor Dal", brand: null, baseUnit: "kg", quantity: "1", price: "60",
  count, state: "orderable", part: null, left: null, lineTotal: String(60 * count), ...more,
});
const cart = (revision: number, lines: CartLine[], more: Partial<CartResponse> = {}): CartResponse => ({
  shop: { id: shopId, name: "Day Dairy" }, revision, lines,
  quote: lines.length ? { productValue: "60", deliveryFee: "20", smallCartFee: null, total: "80" } : null,
  placeable: lines.length > 0, reasons: [], ...more,
});
const ok = (data: CartResponse): ApiResult<CartResponse> => ({ ok: true, data });
const refused = (code: "CART_CHANGED" | "NOT_FOUND", status: number): ApiResult<CartResponse> => ({ ok: false, status, code });

/** A server whose answers the test hands out one at a time, in any order. */
function fakeServer() {
  const saves: Array<{ body: SaveCartBody; answer: (result: ApiResult<CartResponse>) => void }> = [];
  const loads: Array<(result: ApiResult<CartResponse>) => void> = [];
  const client = {
    cart: () => new Promise<ApiResult<CartResponse>>((resolve) => loads.push(resolve)),
    saveCart: (_shop: string, _place: unknown, body: SaveCartBody) => new Promise<ApiResult<CartResponse>>((resolve) => saves.push({ body, answer: resolve })),
  };
  return { client, saves, loads };
}

describe("cart helpers (#406)", () => {
  it("builds the whole save from the counts on screen and the revision last seen", () => {
    let lines = withCount([], atta, 1);
    lines = withCount(lines, dal, 2);
    lines = withCount(lines, atta, 3);
    expect(saveBody(cart(4, []), lines)).toEqual({ revision: 4, lines: [{ listingId: atta, count: 3 }, { listingId: dal, count: 2 }] });
    expect(saveBody(null, withCount(lines, atta, 0))).toEqual({ revision: 0, lines: [{ listingId: dal, count: 2 }] });
  });

  it("lays the Customer's latest counts over a cart changed elsewhere", () => {
    expect(rebase([line(atta, 1), line(dal, 5)], new Map([[atta, 4], [dal, 0]]))).toEqual([{ listingId: atta, count: 4 }]);
    expect(rebase([line(dal, 1)], new Map([[atta, 2]]))).toEqual([{ listingId: dal, count: 1 }, { listingId: atta, count: 2 }]);
  });

  it("adds at most one new pack per save, so a refused save names its pack (#410)", () => {
    const server = cart(3, [line(atta, 1)]);
    const { body, sent } = nextSave(server, new Map([[dal, 1], ["3f1c2b9a-0d4e-4b7a-8c61-2e5f9d8a7b03", 2], [atta, 4]]));
    expect(body).toEqual({ revision: 3, lines: [{ listingId: atta, count: 4 }, { listingId: dal, count: 1 }] });
    expect([...sent]).toEqual([[dal, 1], [atta, 4]]);
  });

  it("counts packs on the bar and stops + only where the server says stock ends", () => {
    expect([cartBarLabel([{ listingId: atta, count: 1 }]), cartBarLabel([{ listingId: atta, count: 2 }, { listingId: dal, count: 1 }])])
      .toEqual(["View cart · 1 item", "View cart · 3 items"]);
    const server = cart(1, [line(atta, 3, { left: 3 }), line(dal, 1)]);
    expect([stockLeft(server, atta), stockLeft(server, dal), stockLeft(null, atta)]).toEqual([3, null, null]);
  });

  it("names each reason with its fix, and a zero fee as Free", () => {
    const now = Date.parse("2030-01-01T10:00:00+05:30");
    expect([
      reasonText({ code: "BELOW_MINIMUM_CART", shortfall: "40.50" }, now),
      reasonText({ code: "BELOW_CONTRIBUTION_FLOOR" }, now),
      reasonText({ code: "LINE_UNAVAILABLE" }, now),
      reasonText({ code: "SHOP_CLOSED", opensAt: "2030-01-02T03:30:00.000Z" }, now),
      reasonText({ code: "SHOP_CLOSED", opensAt: null }, now),
      reasonText({ code: "NOT_DELIVERING" }, now),
    ]).toEqual([
      "Add ₹40.50 more to order",
      "Add more items to order",
      "Remove the items that can't be ordered",
      "Shop is closed · opens tomorrow 9:00 AM",
      "Shop is closed",
      "This shop doesn't deliver to your location",
    ]);
    expect([feeText("0"), feeText("20.00"), feeText("19.50")]).toEqual(["Free", "₹20", "₹19.50"]);
  });
});

describe("the cart store (#406)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function loaded(server: ReturnType<typeof fakeServer>, data: CartResponse) {
    const store = createCart(server.client, shopId, 300);
    const loading = store.load(place);
    server.loads.shift()?.(ok(data));
    await loading;
    return store;
  }

  it("sends one save with the latest counts after rapid taps, and shows no total meanwhile", async () => {
    const server = fakeServer();
    const store = await loaded(server, cart(0, []));
    store.setCount(atta, 1);
    store.setCount(atta, 2);
    store.setCount(atta, 3);
    expect(store.get()).toMatchObject({ saving: true, lines: [{ listingId: atta, count: 3 }] });
    await vi.advanceTimersByTimeAsync(300);
    expect(server.saves.map((save) => save.body)).toEqual([{ revision: 0, lines: [{ listingId: atta, count: 3 }] }]);
    server.saves[0]?.answer(ok(cart(1, [line(atta, 3)])));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get()).toMatchObject({ saving: false, server: { revision: 1 }, lines: [{ listingId: atta, count: 3 }] });
  });

  it("never lets a reply to an older save replace newer counts on screen", async () => {
    const server = fakeServer();
    const store = await loaded(server, cart(0, []));
    store.setCount(atta, 1);
    await vi.advanceTimersByTimeAsync(300);
    store.setCount(atta, 2);
    await vi.advanceTimersByTimeAsync(300);
    // One save at a time: the second waits for the first reply.
    expect(server.saves).toHaveLength(1);
    server.saves[0]?.answer(ok(cart(1, [line(atta, 1)])));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get()).toMatchObject({ saving: true, lines: [{ listingId: atta, count: 2 }] });
    expect(server.saves[1]?.body).toEqual({ revision: 1, lines: [{ listingId: atta, count: 2 }] });
    server.saves[1]?.answer(ok(cart(2, [line(atta, 2)])));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get()).toMatchObject({ saving: false, server: { revision: 2 }, lines: [{ listingId: atta, count: 2 }] });
  });

  it("ends with no line when a part is added and quickly removed, before or while its save is on its way (#377)", async () => {
    const part = { quantity: "0.4", price: "16.00" };
    // Remove inside the pause: the Add is never sent.
    const quick = fakeServer();
    const first = await loaded(quick, cart(0, []));
    first.setCount(atta, 1);
    first.setCount(atta, 0);
    expect(first.get().lines).toEqual([]);
    await vi.advanceTimersByTimeAsync(300);
    expect(quick.saves.map((save) => save.body)).toEqual([{ revision: 0, lines: [] }]);
    quick.saves[0]?.answer(ok(cart(1, [])));
    await vi.advanceTimersByTimeAsync(0);
    expect(first.get()).toMatchObject({ saving: false, lines: [] });

    // Remove while the Add's save is on its way: its reply doesn't bring the part back, and the Remove is saved next.
    const slow = fakeServer();
    const second = await loaded(slow, cart(0, []));
    second.setCount(atta, 1);
    await vi.advanceTimersByTimeAsync(300);
    second.setCount(atta, 0);
    slow.saves[0]?.answer(ok(cart(1, [line(atta, 1, { part, left: 1, lineTotal: "16.00" })])));
    await vi.advanceTimersByTimeAsync(300);
    expect(second.get()).toMatchObject({ saving: true, lines: [] });
    expect(slow.saves[1]?.body).toEqual({ revision: 1, lines: [] });
    slow.saves[1]?.answer(ok(cart(2, [])));
    await vi.advanceTimersByTimeAsync(0);
    expect(second.get()).toMatchObject({ saving: false, server: { revision: 2 }, lines: [] });
  });

  it("takes the server's count where stock ends", async () => {
    const server = fakeServer();
    const store = await loaded(server, cart(0, []));
    store.setCount(atta, 5);
    await vi.advanceTimersByTimeAsync(300);
    server.saves[0]?.answer(ok(cart(1, [line(atta, 3, { left: 3 })])));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get().lines).toEqual([{ listingId: atta, count: 3 }]);
    expect(stockLeft(store.get().server, atta)).toBe(3);
  });

  it("on CART_CHANGED reloads and saves again with the Customer's latest change", async () => {
    const server = fakeServer();
    const store = await loaded(server, cart(1, [line(atta, 1)]));
    store.setCount(atta, 2);
    await vi.advanceTimersByTimeAsync(300);
    server.saves[0]?.answer(refused("CART_CHANGED", 409));
    await vi.advanceTimersByTimeAsync(0);
    // Another phone added dal meanwhile.
    server.loads.shift()?.(ok(cart(2, [line(atta, 1), line(dal, 1)])));
    await vi.advanceTimersByTimeAsync(0);
    expect(server.saves[1]?.body).toEqual({ revision: 2, lines: [{ listingId: atta, count: 2 }, { listingId: dal, count: 1 }] });
    expect(store.get().saving).toBe(true);
  });

  it("drops a first Add the server refuses and says so (#410)", async () => {
    const server = fakeServer();
    const store = await loaded(server, cart(1, [line(atta, 1)]));
    store.setCount(dal, 1);
    await vi.advanceTimersByTimeAsync(300);
    server.saves[0]?.answer(refused("NOT_FOUND", 404));
    await vi.advanceTimersByTimeAsync(0);
    server.loads.shift()?.(ok(cart(1, [line(atta, 1)])));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get()).toMatchObject({ saving: false, lines: [{ listingId: atta, count: 1 }], notice: "A pack you added can't be ordered right now, so it wasn't added." });
    expect(server.saves).toHaveLength(1);
  });

  it("keeps a pack added while the reload after a refused save is on its way, and saves it", async () => {
    const server = fakeServer();
    const store = await loaded(server, cart(1, [line(atta, 1)]));
    store.setCount(dal, 1);
    await vi.advanceTimersByTimeAsync(300);
    server.saves[0]?.answer(refused("NOT_FOUND", 404));
    await vi.advanceTimersByTimeAsync(0);
    // The reload is pending; the Customer adds another pack.
    const ghee = "3f1c2b9a-0d4e-4b7a-8c61-2e5f9d8a7b03";
    store.setCount(ghee, 2);
    server.loads.shift()?.(ok(cart(1, [line(atta, 1)])));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get().lines).toEqual([{ listingId: atta, count: 1 }, { listingId: ghee, count: 2 }]);
    await vi.advanceTimersByTimeAsync(300);
    expect(server.saves[1]?.body).toEqual({ revision: 1, lines: [{ listingId: atta, count: 1 }, { listingId: ghee, count: 2 }] });
    server.saves[1]?.answer(ok(cart(2, [line(atta, 1), line(ghee, 2)])));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get()).toMatchObject({ saving: false, lines: [{ listingId: atta, count: 1 }, { listingId: ghee, count: 2 }] });
  });

  it("adds the good pack when two are added together and only one is refused", async () => {
    const server = fakeServer();
    const store = await loaded(server, cart(0, []));
    store.setCount(dal, 1);
    store.setCount(atta, 1);
    await vi.advanceTimersByTimeAsync(300);
    expect(server.saves[0]?.body.lines).toEqual([{ listingId: dal, count: 1 }]);
    server.saves[0]?.answer(refused("NOT_FOUND", 404));
    await vi.advanceTimersByTimeAsync(0);
    server.loads.shift()?.(ok(cart(0, [])));
    await vi.advanceTimersByTimeAsync(0);
    expect(server.saves[1]?.body).toEqual({ revision: 0, lines: [{ listingId: atta, count: 1 }] });
    server.saves[1]?.answer(ok(cart(1, [line(atta, 1)])));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get()).toMatchObject({ saving: false, lines: [{ listingId: atta, count: 1 }], notice: "A pack you added can't be ordered right now, so it wasn't added." });
  });

  it("keeps the taps after a failed save, shows no old total, and sends them again on retry or the next load", async () => {
    const server = fakeServer();
    const store = await loaded(server, cart(0, []));
    store.setCount(atta, 1);
    await vi.advanceTimersByTimeAsync(300);
    server.saves[0]?.answer({ ok: false, status: 500, code: "INTERNAL" });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get()).toMatchObject({ saving: true, message: "Something went wrong on the server.", lines: [{ listingId: atta, count: 1 }] });
    store.retry();
    server.loads.shift()?.(ok(cart(0, [])));
    await vi.advanceTimersByTimeAsync(0);
    expect(server.saves[1]?.body).toEqual({ revision: 0, lines: [{ listingId: atta, count: 1 }] });
    server.saves[1]?.answer({ ok: false, status: 503, code: "UNAVAILABLE" });
    await vi.advanceTimersByTimeAsync(0);
    // A screen showing again reads the cart and sends the taps again.
    void store.load(place);
    server.loads.shift()?.(ok(cart(0, [])));
    await vi.advanceTimersByTimeAsync(0);
    expect(server.saves).toHaveLength(3);
  });

  it("keeps a tap made during the first load, and fails openly when its save fails", async () => {
    const server = fakeServer();
    const store = createCart(server.client, shopId, 300);
    void store.load(place);
    store.setCount(atta, 1);
    server.loads.shift()?.(ok(cart(2, [line(dal, 1)])));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get().lines).toEqual([{ listingId: dal, count: 1 }, { listingId: atta, count: 1 }]);
    await vi.advanceTimersByTimeAsync(300);
    expect(server.saves[0]?.body.revision).toBe(2);
    server.saves[0]?.answer({ ok: false, status: 500, code: "INTERNAL" });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get()).toMatchObject({ status: "ready", message: "Something went wrong on the server." });

    const first = fakeServer();
    const fresh = createCart(first.client, shopId, 300);
    void fresh.load(place);
    first.loads.shift()?.({ ok: false, status: 500, code: "INTERNAL" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fresh.get()).toMatchObject({ status: "failed", message: "Something went wrong on the server." });
  });

  it("sends nothing and shows no reply once stopped for a sign-out or another account", async () => {
    const server = fakeServer();
    const store = await loaded(server, cart(1, [line(atta, 1)]));
    store.setCount(atta, 2);
    store.stop();
    await vi.advanceTimersByTimeAsync(300);
    expect(server.saves).toHaveLength(0);

    const other = fakeServer();
    const sending = await loaded(other, cart(1, [line(atta, 1)]));
    sending.setCount(atta, 3);
    await vi.advanceTimersByTimeAsync(300);
    sending.stop();
    other.saves[0]?.answer(ok(cart(2, [line(atta, 3)])));
    await vi.advanceTimersByTimeAsync(0);
    sending.setCount(dal, 1);
    void sending.load(place);
    await vi.advanceTimersByTimeAsync(300);
    expect(sending.get().server?.revision).toBe(1);
    expect([other.saves.length, other.loads.length]).toEqual([1, 0]);
  });

  it("asks nothing more once stopped while a save is on its way, even on CART_CHANGED or NOT_FOUND", async () => {
    for (const code of ["CART_CHANGED", "NOT_FOUND"] as const) {
      const server = fakeServer();
      const store = await loaded(server, cart(1, [line(atta, 1)]));
      store.setCount(code === "CART_CHANGED" ? atta : dal, 2);
      await vi.advanceTimersByTimeAsync(300);
      store.stop();
      server.saves[0]?.answer(refused(code, code === "CART_CHANGED" ? 409 : 404));
      await vi.advanceTimersByTimeAsync(1000);
      expect([server.saves.length, server.loads.length]).toEqual([1, 0]);
      expect(store.get()).toMatchObject({ server: { revision: 1 }, notice: null });
    }
  });

  it("drops the recovery GET's reply when stopped while it is on its way", async () => {
    const server = fakeServer();
    const store = await loaded(server, cart(1, [line(atta, 1)]));
    store.setCount(atta, 2);
    await vi.advanceTimersByTimeAsync(300);
    server.saves[0]?.answer(refused("CART_CHANGED", 409));
    await vi.advanceTimersByTimeAsync(0);
    store.stop();
    server.loads.shift()?.(ok(cart(5, [line(atta, 1)])));
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.saves).toHaveLength(1);
    expect(store.get().server?.revision).toBe(1);
  });

  it("shows no cart when there is none and the shop can't deliver here", async () => {
    const server = fakeServer();
    const store = createCart(server.client, shopId, 300);
    const loading = store.load(place);
    server.loads.shift()?.(refused("NOT_FOUND", 404));
    await loading;
    expect(store.get()).toMatchObject({ status: "none", lines: [] });
  });
});
