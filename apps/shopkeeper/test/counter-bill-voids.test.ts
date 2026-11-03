import type { ApiResult } from "@ygo/api-client";
import type { ShopCounterBill, ShopCounterBillsResponse, VoidCounterBillBody } from "@ygo/contracts";
import { describe, expect, it, vi } from "vitest";
import { canVoid, createCounterBillVoids } from "../src/lib/counter-bill-voids";
import { strings } from "../src/strings";

const id = "7d2e9a4c-6b1f-4c3a-8e5d-0f2a4b6c8d1e";
const bill = (over: Partial<ShopCounterBill> = {}): ShopCounterBill => ({
  id, reference: "7D2E9A4C", number: 12, total: "63.00", payment: "cash", madeAt: "2030-01-01T10:00:00.000Z", receivedAt: "2030-01-01T10:00:05.000Z",
  voidUntil: "2030-01-02T10:00:05.000Z", voidable: true, voided: null, ...over,
});
const voided = bill({ voidable: false, voided: { reason: "billed_twice", note: null, createdAt: "2030-01-01T11:00:00.000Z" } });
const ok = <T,>(data: T): ApiResult<T> => ({ ok: true, data });
const refused = (code: "COUNTER_BILL_VOIDED" | "COUNTER_BILL_NOT_VOIDABLE" | "INTERNAL" | "TOO_MANY_REQUESTS", status = 409) => ({ ok: false, status, code }) as ApiResult<never>;
const offline = () => Promise.reject(new TypeError("Network request failed"));
const body: VoidCounterBillBody = { reason: "other", note: "Customer changed mind" };

/** A promise the test settles by hand, to land answers out of order. */
function later<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { settle = resolve; });
  return { promise, settle };
}
function never(): never { throw new Error("unexpected read"); }
async function settle() { for (let i = 0; i < 10; i++) await Promise.resolve(); }

function setup(list: () => Promise<ApiResult<ShopCounterBillsResponse>>, send: () => Promise<ApiResult<ShopCounterBill>> = () => Promise.resolve(ok(voided))) {
  const client = { shopCounterBills: vi.fn(list), voidCounterBill: vi.fn(send) };
  return { client, voids: createCounterBillVoids(client) };
}

describe("S37 Void a bill store (#492)", () => {
  it("offers Void only while the server says so, and never for a bill with no number", () => {
    expect(canVoid(bill())).toBe(true);
    expect(canVoid(bill({ voidable: false }))).toBe(false);
    // Even if the server ever said voidable, a held bill stays out of reach (safeguard 1).
    expect(canVoid(bill({ number: null, voidUntil: null, voidable: true }))).toBe(false);
    expect(canVoid({ ...voided, voidable: true })).toBe(false);
  });

  it("loads the list, shows an empty one, and says voiding needs a connection when offline", async () => {
    const { voids } = setup(() => Promise.resolve(ok({ bills: [] })));
    expect(voids.get().status).toBe("loading");
    voids.start(); await settle();
    expect(voids.get()).toMatchObject({ status: "ready", bills: [], message: null });

    const away = setup(offline);
    away.voids.start(); await settle();
    expect(away.voids.get()).toMatchObject({ status: "failed", bills: null, message: "Voiding needs a connection." });

    const fault = setup(() => Promise.resolve(refused("INTERNAL", 500)));
    fault.voids.start(); await settle();
    expect(fault.voids.get()).toMatchObject({ status: "failed", message: "Something went wrong on the server." });
  });

  it("clears an old read error once a void goes through", async () => {
    let reads = 0;
    const { voids } = setup(() => (++reads === 1 ? Promise.resolve(ok({ bills: [bill()] })) : offline()));
    voids.start(); await settle();
    await voids.refresh();
    expect(voids.get().message).toBe("Voiding needs a connection.");
    await voids.voidBill(id, body);
    expect(voids.get()).toMatchObject({ message: null, notice: { tone: "success" } });
  });

  it("marks the bill voided from the server's answer, and drops an older read that would bring it back", async () => {
    const stale = later<ApiResult<ShopCounterBillsResponse>>();
    let reads = 0;
    const { client, voids } = setup(() => (++reads === 1 ? Promise.resolve(ok({ bills: [bill()] })) : stale.promise));
    voids.start(); await settle();
    void voids.refresh();
    expect(await voids.voidBill(id, body)).toEqual({ close: true, message: null });
    expect(client.voidCounterBill).toHaveBeenCalledWith(id, body);
    expect(voids.get()).toMatchObject({ bills: [voided], voiding: null, refreshing: false, notice: { text: "Bill 12 voided.", tone: "success" } });
    stale.settle(ok({ bills: [bill()] })); await settle();
    expect(voids.get().bills).toEqual([voided]);
  });

  it("closes the sheet and reads the list again when the bill was already voided, staying busy until the read lands", async () => {
    let reads = 0;
    const reread = later<ApiResult<ShopCounterBillsResponse>>();
    const { client, voids } = setup(() => (++reads === 1 ? Promise.resolve(ok({ bills: [bill()] })) : reread.promise), () => Promise.resolve(refused("COUNTER_BILL_VOIDED")));
    voids.start(); await settle();
    const done = voids.voidBill(id, body);
    await settle();
    expect(voids.get().voiding).toBe(id);
    expect(await voids.voidBill(id, body)).toEqual({ close: false, message: null });
    reread.settle(ok({ bills: [voided] }));
    expect(await done).toEqual({ close: true, message: null });
    expect(client.shopCounterBills).toHaveBeenCalledTimes(2);
    expect(voids.get()).toMatchObject({ bills: [voided], voiding: null, notice: { text: "This bill is already voided.", tone: "danger" } });
  });

  it("does the same when the server says the bill can't be voided now, as its window has ended", async () => {
    let reads = 0;
    const closed = bill({ voidable: false });
    const { voids } = setup(() => Promise.resolve(ok({ bills: [++reads === 1 ? bill() : closed] })), () => Promise.resolve(refused("COUNTER_BILL_NOT_VOIDABLE")));
    voids.start(); await settle();
    expect(await voids.voidBill(id, { reason: "wrong_item" })).toEqual({ close: true, message: null });
    expect(voids.get()).toMatchObject({ bills: [closed], notice: { text: "This bill can't be voided now." } });
  });

  it("keeps the sheet open offline, so the typed note isn't lost, after checking the list in case the void got through", async () => {
    const { client, voids } = setup(() => Promise.resolve(ok({ bills: [bill()] })), offline);
    voids.start(); await settle();
    expect(await voids.voidBill(id, body)).toEqual({ close: false, message: "Voiding needs a connection." });
    expect(client.shopCounterBills).toHaveBeenCalledTimes(2);
    expect(voids.get()).toMatchObject({ bills: [bill()], voiding: null, notice: null });
  });

  it("closes the sheet when a void timed out but the list shows it went through", async () => {
    let reads = 0;
    const { voids } = setup(() => Promise.resolve(ok({ bills: [++reads === 1 ? bill() : voided] })), offline);
    voids.start(); await settle();
    expect(await voids.voidBill(id, body)).toEqual({ close: true, message: null });
    expect(voids.get()).toMatchObject({ bills: [voided], voiding: null });
  });

  it("never leaves the sheet busy, even if reading the list throws", async () => {
    let reads = 0;
    const { voids } = setup(() => (++reads === 1 ? Promise.resolve(ok({ bills: [bill()] })) : never()), () => Promise.resolve(refused("INTERNAL", 500)));
    voids.start(); await settle();
    await expect(voids.voidBill(id, body)).rejects.toThrow();
    expect(voids.get().voiding).toBeNull();
  });

  it("keeps the sheet open on a server fault, busy until the list is read again, so the void can't be sent twice", async () => {
    let reads = 0;
    const reread = later<ApiResult<ShopCounterBillsResponse>>();
    const { client, voids } = setup(() => (++reads === 1 ? Promise.resolve(ok({ bills: [bill()] })) : reread.promise), () => Promise.resolve(refused("INTERNAL", 500)));
    voids.start(); await settle();
    const done = voids.voidBill(id, body);
    await settle();
    expect(client.shopCounterBills).toHaveBeenCalledTimes(2);
    expect(voids.get().voiding).toBe(id);
    // A second tap while the read is on its way sends nothing and leaves the sheet as it is.
    expect(await voids.voidBill(id, body)).toEqual({ close: false, message: null });
    expect(client.voidCounterBill).toHaveBeenCalledTimes(1);
    reread.settle(ok({ bills: [bill()] }));
    expect(await done).toEqual({ close: false, message: "Something went wrong on the server." });
    expect(voids.get().voiding).toBeNull();
  });

  it("closes the sheet after a server fault when the list read again shows the bill already voided", async () => {
    let reads = 0;
    const { voids } = setup(() => Promise.resolve(ok({ bills: [++reads === 1 ? bill() : voided] })), () => Promise.resolve(refused("INTERNAL", 500)));
    voids.start(); await settle();
    expect(await voids.voidBill(id, body)).toEqual({ close: true, message: null });
    expect(voids.get()).toMatchObject({ bills: [voided], voiding: null, notice: { text: "This bill is already voided.", tone: "danger" } });
  });

  it("stays busy after a server fault until a pull sent meanwhile has landed too", async () => {
    let reads = 0;
    const first = later<ApiResult<ShopCounterBillsResponse>>(), pulled = later<ApiResult<ShopCounterBillsResponse>>();
    const { client, voids } = setup(() => [Promise.resolve(ok({ bills: [bill()] })), first.promise, pulled.promise][reads++] ?? never(), () => Promise.resolve(refused("INTERNAL", 500)));
    voids.start(); await settle();
    const done = voids.voidBill(id, body);
    await settle();
    void voids.refresh();
    first.settle(ok({ bills: [bill()] })); await settle();
    // The void's own read was dropped for the pull: still busy, so a tap sends nothing.
    expect(voids.get().voiding).toBe(id);
    expect(await voids.voidBill(id, body)).toEqual({ close: false, message: null });
    expect(client.voidCounterBill).toHaveBeenCalledTimes(1);
    pulled.settle(ok({ bills: [bill()] }));
    expect(await done).toEqual({ close: false, message: "Something went wrong on the server." });
    expect(voids.get().voiding).toBeNull();
  });

  it("keeps the sheet open after a server fault when the list can't be read again, as the bill's state is unknown", async () => {
    let reads = 0;
    const { client, voids } = setup(() => (++reads === 1 ? Promise.resolve(ok({ bills: [bill()] })) : offline()), () => Promise.resolve(refused("INTERNAL", 500)));
    voids.start(); await settle();
    expect(await voids.voidBill(id, body)).toEqual({ close: false, message: "Something went wrong on the server." });
    expect(client.shopCounterBills).toHaveBeenCalledTimes(2);
    expect(voids.get().voiding).toBeNull();
  });

  it("keeps the sheet open without reading the list again on a refusal that leaves the bill as it was", async () => {
    const { client, voids } = setup(() => Promise.resolve(ok({ bills: [bill()] })), () => Promise.resolve(refused("TOO_MANY_REQUESTS", 429)));
    voids.start(); await settle();
    expect(await voids.voidBill(id, body)).toEqual({ close: false, message: strings.errors.TOO_MANY_REQUESTS });
    expect(client.shopCounterBills).toHaveBeenCalledTimes(1);
    expect(voids.get().voiding).toBeNull();
  });

  it("sends one void at a time, and a second tap leaves the sheet as it is", async () => {
    const answer = later<ApiResult<ShopCounterBill>>();
    const { client, voids } = setup(() => Promise.resolve(ok({ bills: [bill()] })), () => answer.promise);
    voids.start(); await settle();
    const first = voids.voidBill(id, body);
    expect(voids.get().voiding).toBe(id);
    expect(await voids.voidBill(id, body)).toEqual({ close: false, message: null });
    expect(client.voidCounterBill).toHaveBeenCalledTimes(1);
    answer.settle(ok(voided));
    await first;
  });
});

describe("S37 remembers voids for the bill cards (#493)", () => {
  it("hands the phone every list it reads and every void it makes, and nothing from a failed read", async () => {
    const remember = vi.fn();
    const client = { shopCounterBills: vi.fn(() => Promise.resolve(ok({ bills: [bill()] }))), voidCounterBill: vi.fn(() => Promise.resolve(ok(voided))) };
    const voids = createCounterBillVoids(client, remember);
    voids.start(); await settle();
    expect(remember).toHaveBeenLastCalledWith([bill()]);
    await voids.voidBill(id, body);
    expect(remember).toHaveBeenLastCalledWith([voided]);
    remember.mockClear();
    client.shopCounterBills.mockImplementation(() => offline() as never);
    await voids.refresh(); await settle();
    expect(remember).not.toHaveBeenCalled();
  });
});
