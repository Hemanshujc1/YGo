import type { ShopOrderSummary, SyncActionsBody, SyncActionResult } from "@ygo/contracts";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attentionCount, CLOCK_BACK_MS } from "../src/lib/delivery-store";
import { prepareDeliveries, UPLOAD_FRESH_MS } from "../src/lib/delivery-upload";
import { openingStockQueue, syncOpeningStockBatch } from "../src/lib/opening-stock-queue";
import { adapter } from "./stock-database-fixture";

const shopId = "00000000-0000-4000-8000-000000000001";
const orderA = "00000000-0000-4000-8000-0000000000a1";
const orderB = "00000000-0000-4000-8000-0000000000b1";
const summary = (id: string) => ({ id, number: 7, offlineDeliveryIssue: false }) as unknown as ShopOrderSummary;
const bytes = new Uint8Array([1, 2, 3]);
const result = (action: { id: string; sequence: number }, status: SyncActionResult["status"], code: SyncActionResult["code"] = null): SyncActionResult =>
  ({ actionId: action.id, sequence: action.sequence, status, code, result: status === "applied" ? { orderId: orderA, status: "delivered" } : null, clockSuspect: false });

describe("delivery without internet (#617)", () => {
  let db: DatabaseSync;
  let clock: number;
  let queue: ReturnType<typeof openingStockQueue>;
  const complete = (orderId = orderA) => queue.saveDelivery(shopId, "delivery_complete", { orderId, handoverCode: "4821", payment: "cash" }, bytes);
  beforeEach(() => { db = new DatabaseSync(":memory:"); clock = Date.parse("2026-11-12T10:00:00Z"); queue = openingStockQueue(adapter(db), randomUUID, () => new Date(clock)); });
  afterEach(() => db.close());

  it("keeps My deliveries and each order for a phone with no internet", () => {
    queue.deliveries.saveList([summary(orderA), summary(orderB)]);
    queue.deliveries.saveOrder({ id: orderA, number: 7, customer: { name: "Asha", phone: "9000000000" } } as never, 1500);
    expect(queue.deliveries.list().map((order) => order.id)).toEqual([orderA, orderB]);
    expect(queue.deliveries.order(orderA)).toMatchObject({ offset: 1500, order: { customer: { name: "Asha" } } });
  });

  it("drops an order that left the list, but never one with an action waiting, nor its photo", () => {
    queue.deliveries.saveList([summary(orderA), summary(orderB)]);
    const saved = complete(orderA) as { id: string };
    queue.deliveries.saveList([]);
    expect(queue.deliveries.list().map((order) => order.id)).toEqual([orderA]);
    expect(db.prepare("SELECT count(*) AS n FROM delivery_photos").get()).toEqual({ n: 1 });
    expect(queue.batch(shopId).actions.map((action) => action.id)).toEqual([saved.id]);
  });

  it("sends a delivery after its photo is up, with the upload id in the action, and wipes the code and photo once accepted", async () => {
    complete(orderA);
    const sent: SyncActionsBody[] = [];
    const answer = await syncOpeningStockBatch(queue, shopId, (body) => { sent.push(body); return Promise.resolve({ ok: true as const, data: { results: body.actions.map((action) => result(action, "applied")) } }); }, () => true,
      (batch) => prepareDeliveries(queue.deliveries, batch, () => Promise.resolve("11111111-1111-4111-8111-111111111111")));
    expect(sent[0]?.actions[0]?.payload).toMatchObject({ photoUploadId: "11111111-1111-4111-8111-111111111111", handoverCode: "4821" });
    expect(answer?.results[0]?.status).toBe("applied");
    expect(JSON.stringify(db.prepare("SELECT action FROM opening_stock_actions").all())).not.toContain("4821");
    expect(db.prepare("SELECT count(*) AS n FROM delivery_photos").get()).toEqual({ n: 0 });
  });

  it("stops the batch at a photo it cannot upload, in order, and sends nothing when the first cannot", async () => {
    complete(orderA);
    complete(orderB);
    const batch = queue.batch(shopId);
    let calls = 0;
    const upload = () => Promise.resolve(++calls === 1 ? "22222222-2222-4222-8222-222222222222" : "network" as const);
    const ready = await prepareDeliveries(queue.deliveries, batch, upload);
    expect(ready?.actions).toHaveLength(1);
    expect(await prepareDeliveries(queue.deliveries, queue.batch(shopId), () => Promise.resolve("network"))).toBeNull();
  });

  it("leaves the stand-in id when the server refuses the photo, so the action is refused with its reason and the sequence moves on", async () => {
    complete(orderA);
    const stand = (queue.batch(shopId).actions[0]?.payload as { photoUploadId: string }).photoUploadId;
    const ready = await prepareDeliveries(queue.deliveries, queue.batch(shopId), () => Promise.resolve("refused"));
    expect(ready?.actions[0]?.payload).toMatchObject({ photoUploadId: stand });
  });

  it("asks again for an upload that is stale and unsent, but keeps the id of an action already sent", async () => {
    complete(orderA);
    await prepareDeliveries(queue.deliveries, queue.batch(shopId), () => Promise.resolve("33333333-3333-4333-8333-333333333333"));
    clock += UPLOAD_FRESH_MS + 1000;
    const again = await prepareDeliveries(queue.deliveries, queue.batch(shopId), () => Promise.resolve("44444444-4444-4444-8444-444444444444"), () => new Date(clock));
    expect(again?.actions[0]?.payload).toMatchObject({ photoUploadId: "44444444-4444-4444-8444-444444444444" });
    if (!again) throw new Error("not ready");
    queue.attempted(again);
    clock += UPLOAD_FRESH_MS + 1000;
    const sentAlready = await prepareDeliveries(queue.deliveries, queue.batch(shopId), () => Promise.resolve("55555555-5555-4555-8555-555555555555"), () => new Date(clock));
    expect(sentAlready?.actions[0]?.payload).toMatchObject({ photoUploadId: "44444444-4444-4444-8444-444444444444" });
  });

  it("keeps a refused delivery and its photo until its order leaves the list, and wipes the code at once", () => {
    queue.deliveries.saveList([summary(orderA)]);
    complete(orderA);
    const batch = queue.batch(shopId);
    queue.acknowledge(batch, { results: batch.actions.map((action) => result(action, "rejected", "ACTION_TOO_OLD")) });
    expect(JSON.stringify(db.prepare("SELECT action FROM opening_stock_actions").all())).not.toContain("4821");
    expect(queue.deliveries.stateOf(orderA).refused).toEqual({ type: "delivery_complete", code: "ACTION_TOO_OLD" });
    expect(queue.failureCount()).toBe(1);
    queue.deliveries.saveList([summary(orderA)]);
    expect(queue.deliveries.refusedIds()).toEqual([orderA]);
    expect(db.prepare("SELECT count(*) AS n FROM delivery_photos").get()).toEqual({ n: 1 });
    queue.deliveries.saveList([]);
    expect(queue.deliveries.refusedIds()).toEqual([]);
    expect(db.prepare("SELECT count(*) AS n FROM delivery_photos").get()).toEqual({ n: 0 });
  });

  it("counts waiting deliveries toward the allowance and sign-out, and shows the call attempt time for the phone's own wait", () => {
    queue.saveDelivery(shopId, "delivery_call_attempt", { orderId: orderA });
    expect(queue.count()).toBe(1);
    expect(queue.deliveries.stateOf(orderA)).toMatchObject({ waiting: ["delivery_call_attempt"], callAt: new Date(clock).toISOString() });
  });

  it("doubts a clock that reads earlier than before and marks the action", () => {
    queue.saveDelivery(shopId, "delivery_call_attempt", { orderId: orderA });
    clock -= CLOCK_BACK_MS + 1000;
    queue.saveDelivery(shopId, "delivery_call_attempt", { orderId: orderB });
    expect(queue.batch(shopId).actions.map((action) => action.clockSuspect)).toEqual([false, true]);
  });

  it("counts an order the server and the phone both hold as refused once", () => {
    expect(attentionCount(1, [orderA], [orderA])).toBe(1);
    expect(attentionCount(1, [orderA], [orderB])).toBe(2);
    expect(attentionCount(0, [], [orderA])).toBe(1);
  });
});
