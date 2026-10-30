import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openingStockQueue } from "../src/lib/opening-stock-queue";
import { adapter } from "./stock-database-fixture";
import type { SyncActionsBody } from "@ygo/contracts";

const mock = vi.hoisted(() => ({ get: vi.fn(), open: vi.fn(), stock: vi.fn(), send: vi.fn(), set: vi.fn(),
  hooks: [] as unknown[], cursor: 0, focused: false }));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const index = mock.cursor++;
    if (!(index in mock.hooks)) mock.hooks[index] = initial;
    return [mock.hooks[index], (value: unknown) => {
      mock.set(value);
      mock.hooks[index] = typeof value === "function" ? value(mock.hooks[index]) : value;
    }];
  },
  useRef: (initial: unknown) => {
    const index = mock.cursor++;
    if (!(index in mock.hooks)) mock.hooks[index] = { current: initial };
    return mock.hooks[index];
  },
  useCallback: (callback: unknown) => callback,
}));
vi.mock("expo-router", () => ({ Link: "Link", useFocusEffect: (callback: () => void) => { if (!mock.focused) { mock.focused = true; callback(); } } }));
vi.mock("@ygo/mobile", () => ({ Text: "Text", Button: "Button", SupportEmail: "SupportEmail" }));
vi.mock("../src/components/icons", () => ({ Cloud: "Cloud" }));
vi.mock("react-native", () => ({ ActivityIndicator: "Spinner", ScrollView: "ScrollView", View: "View" }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("../src/components/toggle", () => ({ Toggle: "Toggle" }));
vi.mock("../src/api", () => ({ session: { get: mock.get }, api: { syncChanges: mock.stock, syncActions: mock.send }, supportEmail: "help@example.com" }));
vi.mock("../src/lib/opening-stock-database", () => ({ openOpeningStock: mock.open,
  legacyOpeningStock: { getAllKeys: () => [] } }));
import StockScreen from "../src/app/stock";

const shopId = "00000000-0000-4000-8000-000000000001", packId = "00000000-0000-4000-8000-000000000002";
const item = { packId, listingId: packId, name: "Rice", packQuantity: "1", baseUnit: "kg", quantity: "7", outOfStock: false };
function render() { mock.cursor = 0; return StockScreen(); }
function elements(node: unknown): Array<{ props: Record<string, unknown> }> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as { props: Record<string, unknown> };
  return [element, ...elements(element.props.children)];
}
async function settle() { for (let i = 0; i < 35; i++) await Promise.resolve(); }
function press(label: string) {
  const element = elements(render()).find((node) => node.props.label === label);
  expect(element, label).toBeDefined();
  (element?.props.onPress as () => void)();
}
function texts() {
  return elements(render()).flatMap((node) => {
    const children = node.props.children;
    if (typeof children === "string") return [children];
    return Array.isArray(children) && children.every((child) => typeof child === "string" || typeof child === "number") ? [children.join("")] : [];
  });
}
function switchAccount() { mock.get.mockReturnValue({ account: { id: "account-2" } }); mock.set.mockClear(); }

describe("minimal Stock screen", () => {
  let db: DatabaseSync, queue: ReturnType<typeof openingStockQueue>;
  beforeEach(() => {
    vi.clearAllMocks(); mock.hooks = []; mock.cursor = 0; mock.focused = false;
    db = new DatabaseSync(":memory:"); queue = openingStockQueue(adapter(db), randomUUID);
    mock.get.mockReturnValue({ account: { id: "account-1" } }); mock.open.mockResolvedValue(queue);
    mock.stock.mockResolvedValue({ ok: true, data: { shopId, state: "live", cursor: `${shopId}:1`, changes: [{ packId, item, deletedAt: null }] } });
    mock.send.mockResolvedValue({ ok: false });
  });
  afterEach(() => db.close());

  it("keeps offline toggles pending in order and updates the switch without changing quantity", async () => {
    render(); await settle(); press("Rice: Out of stock"); await settle();
    expect(texts()).toContain("Saved on this phone · waiting to sync");
    expect(elements(render()).find((node) => node.props.label === "Rice: Out of stock")?.props.on).toBe(true);
    press("Rice: Out of stock"); await settle();
    expect(queue.batch(shopId).actions.map((action) => action.payload)).toEqual([{ packId, outOfStock: true }, { packId, outOfStock: false }]);
    expect(texts()).toContain("7 kg");
  });

  it("shows Saved after retry acknowledgement and exposes retained failures with support and fresh-ID retry", async () => {
    render(); await settle(); press("Rice: Out of stock"); await settle();
    mock.send.mockImplementation(async (body: SyncActionsBody) => ({ ok: true, data: { results: body.actions.map((action) => ({
      actionId: action.id, sequence: action.sequence, status: "applied", code: null, result: { listingId: packId, outOfStock: true, recordedAt: new Date().toISOString() }, clockSuspect: false,
    })) } }));
    press("Retry sync"); await settle(); expect(texts()).toContain("Saved"); expect(queue.count()).toBe(0);
    mock.send.mockImplementation(async (body: SyncActionsBody) => ({ ok: true, data: { results: body.actions.map((action) => ({
      actionId: action.id, sequence: action.sequence, status: "rejected", code: "ACTION_TOO_OLD", result: null, clockSuspect: false,
    })) } }));
    press("Rice: Out of stock"); await settle();
    const rejected = queue.flag(shopId, packId)?.action.id;
    expect(texts().join(" ")).toContain(rejected);
    expect(elements(render()).some((node) => node.props.address === "help@example.com")).toBe(true);
    // The card's retry retries the refused value using a fresh action ID.
    const retry = elements(render()).filter((node) => node.props.label === "Retry sync").at(-1);
    (retry?.props.onPress as () => void)(); await settle();
    expect(queue.flag(shopId, packId)?.action.id).not.toBe(rejected);
    expect(queue.failureCount()).toBe(2);
  });

  it("does not claim a save when local storage fails", async () => {
    render(); await settle(); vi.spyOn(queue, "saveFlag").mockImplementation(() => { throw new Error("disk full"); });
    press("Rice: Out of stock"); await settle();
    expect(texts()).toContain("Couldn't save on this phone. Try again before leaving this screen.");
    expect(queue.count()).toBe(0); expect(mock.send).not.toHaveBeenCalled();
  });

  it.each(["listing", "database", "sync"])("ignores %s results from a previous account", async (stage) => {
    if (stage === "listing") mock.stock.mockImplementation(async () => { switchAccount(); return { ok: false, code: "NOT_FOUND" }; });
    if (stage === "database") mock.open.mockImplementation(async () => { switchAccount(); return queue; });
    render(); await settle();
    if (stage === "sync") {
      mock.send.mockImplementation(async () => { switchAccount(); return { ok: false }; });
      press("Rice: Out of stock"); await settle();
    }
    expect(mock.set).not.toHaveBeenCalled();
  });
  it("refreshes the current server flag after replay and ignores a previous account's refresh", async () => {
    render(); await settle(); press("Rice: Out of stock"); await settle();
    mock.send.mockImplementation(async (body: SyncActionsBody) => ({ ok: true, data: { results: body.actions.map((action) => ({
      actionId: action.id, sequence: action.sequence, status: "applied", code: null, result: { listingId: packId, outOfStock: true, recordedAt: new Date().toISOString() }, clockSuspect: false,
    })) } }));
    // The replay acknowledges true, but another phone has since saved false.
    press("Retry sync"); await settle();
    expect(elements(render()).find((node) => node.props.label === "Rice: Out of stock")?.props.on).toBe(false);
    mock.stock.mockImplementationOnce(async () => { switchAccount(); return { ok: false }; });
    press("Rice: Out of stock"); await settle();
    expect(mock.set).not.toHaveBeenCalled();
  });

  it("pulls other-device changes on manual refresh and keeps pending toggles over offline pulls", async () => {
    render(); await settle();
    mock.stock.mockResolvedValue({ ok: true, data: { shopId, state: "live", cursor: `${shopId}:2`, changes: [{ packId, item: { ...item, quantity: "9", outOfStock: true }, deletedAt: null }] } });
    press("Retry sync"); await settle();
    expect(mock.stock).toHaveBeenLastCalledWith(`${shopId}:1`);
    expect(texts()).toContain("9 kg");
    press("Rice: Out of stock"); await settle();
    expect(elements(render()).find((node) => node.props.label === "Rice: Out of stock")?.props.on).toBe(false);
    mock.stock.mockRejectedValue(new Error("offline"));
    press("Retry sync"); await settle();
    expect(texts()).toContain("9 kg");
    expect(texts()).toContain("Couldn't refresh Stock. Showing saved stock; changes stay on this phone.");
    expect(queue.count()).toBe(1);
  });

  it("keeps a removed pending row read-only, then exposes the retained refusal's support reference", async () => {
    render(); await settle(); press("Rice: Out of stock"); await settle();
    mock.stock.mockResolvedValue({ ok: true, data: { shopId, state: "live", cursor: `${shopId}:2`, changes: [{ packId, item: null, deletedAt: new Date().toISOString() }] } });
    press("Retry sync"); await settle();
    expect(texts()).toContain("No longer available · waiting to sync");
    expect(elements(render()).some((node) => node.props.label === "Rice: Out of stock")).toBe(false);
    const id = queue.batch(shopId).actions[0]?.id;
    mock.send.mockImplementation(async (body: SyncActionsBody) => ({ ok: true, data: { results: body.actions.map((action) => ({
      actionId: action.id, sequence: action.sequence, status: "rejected", code: "NOT_FOUND", result: null, clockSuspect: false,
    })) } }));
    press("Retry sync"); await settle();
    expect(texts().join(" ")).not.toContain("Rice");
    expect(texts().join(" ")).toContain(id);
    expect(queue.failureCount()).toBe(1);
    expect(elements(render()).some((node) => node.props.address === "help@example.com")).toBe(true);
  });

  it("keeps the acknowledged switch when the following pull fails, then replaces replay echoes on an empty successful pull", async () => {
    render(); await settle();
    mock.send.mockImplementation(async (body: SyncActionsBody) => ({ ok: true, data: { results: body.actions.map((action) => ({
      actionId: action.id, sequence: action.sequence, status: "applied", code: null, result: { listingId: packId, outOfStock: true, recordedAt: new Date().toISOString() }, clockSuspect: false,
    })) } }));
    mock.stock.mockRejectedValue(new Error("pull offline"));
    press("Rice: Out of stock"); await settle();
    expect(queue.count()).toBe(0);
    expect(texts()).toContain("Saved");
    expect(elements(render()).find((node) => node.props.label === "Rice: Out of stock")?.props.on).toBe(true);
    // Another phone restored false before the server projection changed; no delta is needed.
    mock.stock.mockResolvedValue({ ok: true, data: { shopId, state: "live", cursor: `${shopId}:1`, changes: [] } });
    press("Retry sync"); await settle();
    expect(elements(render()).find((node) => node.props.label === "Rice: Out of stock")?.props.on).toBe(false);
  });

});
