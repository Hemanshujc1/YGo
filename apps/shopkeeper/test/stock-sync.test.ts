import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncActionsBody } from "@ygo/contracts";
import { openingStockQueue } from "../src/lib/opening-stock-queue";
import { adapter } from "./stock-database-fixture";

const shopId = "00000000-0000-4000-8000-000000000001", packId = "00000000-0000-4000-8000-000000000002";
const mock = vi.hoisted(() => ({ account: "account-1", verify: vi.fn(), view: {} as Record<string, unknown>, allowed: vi.fn(), open: vi.fn(), send: vi.fn(), pull: vi.fn(), legacy: vi.fn() }));
vi.mock("../src/api", () => ({
  accountEpoch: () => 0,
  session: { get: () => ({ account: { id: mock.account } }) },
  access: { verify: mock.verify, get: () => mock.view, allowed: mock.allowed },
  api: { syncActions: mock.send, syncChanges: mock.pull },
}));
vi.mock("../src/lib/opening-stock-database", () => ({ openOpeningStock: mock.open, legacyOpeningStock: { getAllKeys: () => [], getString: () => undefined, remove: () => false } }));
import { stockSyncPass } from "../src/lib/stock-sync";

const page = (cursor = 1) => ({ ok: true, data: { shopId, state: "live", cursor: `${shopId}:${cursor}`, changes: [] } });
const answer = (status: "applied" | "retry") => async (body: SyncActionsBody) => ({ ok: true, data: { results: body.actions.map((action) => ({
  actionId: action.id, sequence: action.sequence, status, code: status === "retry" ? "SEQUENCE_MISSING" : null,
  result: status === "retry" ? null : { listingId: packId, outOfStock: true, recordedAt: new Date().toISOString() }, clockSuspect: false })) } });

describe("one sync pass (#395)", () => {
  let db: DatabaseSync, queue: ReturnType<typeof openingStockQueue>;
  beforeEach(() => {
    vi.clearAllMocks(); mock.account = "account-1";
    db = new DatabaseSync(":memory:"); queue = openingStockQueue(adapter(db), randomUUID);
    mock.open.mockResolvedValue(queue);
    mock.verify.mockResolvedValue({ shopId, state: "live" });
    mock.view = { mode: "online", accountId: "account-1", shopId }; mock.allowed.mockReturnValue(true);
    mock.send.mockImplementation(answer("applied")); mock.pull.mockResolvedValue(page());
  });
  afterEach(() => db.close());

  it("sends in order, then pulls Stock from the saved cursor", async () => {
    queue.saveFlag(shopId, packId, true); queue.saveFlag(shopId, packId, false);
    expect(await stockSyncPass()).toMatchObject({ kind: "done" });
    expect(mock.send.mock.calls[0]?.[0].actions.map((action: { sequence: number }) => action.sequence)).toEqual([1, 2]);
    expect(queue.count()).toBe(0);
    expect(mock.pull).toHaveBeenCalledWith(undefined);
    await stockSyncPass();
    expect(mock.pull).toHaveBeenLastCalledWith(`${shopId}:1`);
  });

  it.each([
    ["a thrown request", () => mock.send.mockRejectedValue(new Error("offline")), "retry"],
    ["a server fault", () => mock.send.mockResolvedValue({ ok: false, status: 503, code: "INTERNAL" }), "retry"],
    ["a busy server", () => mock.send.mockResolvedValue({ ok: false, status: 429, code: "INTERNAL" }), "retry"],
    ["a per-change retry answer", () => mock.send.mockImplementation(answer("retry")), "retry"],
    ["a refused request", () => mock.send.mockResolvedValue({ ok: false, status: 404, code: "NOT_FOUND" }), "halt"],
    ["a failed pull after a good send", () => mock.pull.mockRejectedValue(new Error("offline")), "retry"],
    ["an ended session on pull", () => mock.pull.mockResolvedValue({ ok: false, status: 401, code: "UNAUTHENTICATED" }), "halt"],
  ] as const)("reports %s and keeps unsent work queued", async (name, arrange, kind) => {
    queue.saveFlag(shopId, packId, true);
    arrange();
    expect((await stockSyncPass()).kind).toBe(kind);
    expect(queue.count()).toBe(name.includes("pull") ? 0 : 1);
  });

  it("still pulls other phones' changes when sending fails", async () => {
    queue.saveFlag(shopId, packId, true);
    mock.send.mockRejectedValue(new Error("offline"));
    await stockSyncPass();
    expect(mock.pull).toHaveBeenCalledOnce(); expect(queue.cache.cursor(shopId)).toBe(`${shopId}:1`);
  });

  it("sends an Approved shop's opening stock without pulling Stock", async () => {
    mock.verify.mockResolvedValue({ shopId, state: "approved" });
    mock.view = { mode: "online", accountId: "account-1" }; mock.allowed.mockReturnValue(false);
    queue.save(shopId, packId, { quantity: "3", clientId: randomUUID() });
    mock.send.mockImplementation(async (body: SyncActionsBody) => ({ ok: true, data: { results: body.actions.map((action) => ({ actionId: action.id, sequence: action.sequence,
      status: "applied", code: null, result: { listingId: packId, quantity: "3", recordedAt: new Date().toISOString() }, clockSuspect: false })) } }));
    expect((await stockSyncPass()).kind).toBe("done");
    expect(queue.count()).toBe(0); expect(mock.pull).not.toHaveBeenCalled();
  });

  it("retries when the access check got no answer, and stops when the server confirms no shop or the lease ended", async () => {
    mock.verify.mockResolvedValue(null); mock.view = { mode: "online", accountId: "account-1" }; mock.allowed.mockReturnValue(false);
    expect((await stockSyncPass()).kind).toBe("retry");
    mock.verify.mockResolvedValue({ shopId: null, state: null });
    expect((await stockSyncPass()).kind).toBe("halt");
    mock.verify.mockResolvedValue(null); mock.view = { mode: "expired", accountId: "account-1", shopId };
    expect((await stockSyncPass()).kind).toBe("halt");
    expect(mock.open).not.toHaveBeenCalled();
  });

  it("sends from a valid offline lease even though the access check could not be reached", async () => {
    mock.verify.mockResolvedValue(null); mock.view = { mode: "offline", accountId: "account-1", shopId };
    queue.saveFlag(shopId, packId, true);
    expect((await stockSyncPass()).kind).toBe("done");
    expect(queue.count()).toBe(0);
  });

  it("drops a late answer once the account changes, leaving the change queued", async () => {
    queue.saveFlag(shopId, packId, true);
    mock.send.mockImplementation(async (body: SyncActionsBody) => { mock.account = "account-2"; return answer("applied")(body); });
    expect((await stockSyncPass()).kind).toBe("halt");
    expect(queue.count()).toBe(1); expect(mock.pull).not.toHaveBeenCalled();
  });
});
