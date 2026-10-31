import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openingStockQueue } from "../src/lib/opening-stock-queue";
import { adapter } from "./stock-database-fixture";

const mock = vi.hoisted(() => ({ hooks: [] as unknown[], cursor: 0, effects: new Map<number, unknown[]>(), open: vi.fn(), listings: vi.fn(), retry: vi.fn(),
  status: { running: false, outcome: "done", failures: 0 } as Record<string, unknown>, view: { mode: "online" } as Record<string, unknown> }));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const index = mock.cursor++;
    if (!(index in mock.hooks)) mock.hooks[index] = initial;
    return [mock.hooks[index], (value: unknown) => { mock.hooks[index] = value; }];
  },
  // Like React: run again when an input changes.
  useEffect: (effect: () => void, deps: unknown[]) => {
    const index = mock.cursor++, before = mock.effects.get(index);
    if (!before || deps.some((dep, i) => !Object.is(dep, before[i]))) { mock.effects.set(index, deps); effect(); }
  },
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
}));
vi.mock("expo-router", () => ({ Link: "Link" }));
vi.mock("@ygo/mobile", () => ({ Text: "Text", Button: "Button", SupportEmail: "SupportEmail" }));
vi.mock("react-native", () => ({ ActivityIndicator: "Spinner", Pressable: "Pressable", ScrollView: "ScrollView", View: "View" }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("../src/api", () => ({ accountEpoch: () => 0, session: { get: () => ({ account: { id: "account-1" } }) }, supportEmail: "help@example.com",
  access: { subscribe: vi.fn(), get: () => mock.view }, api: { shopListings: mock.listings } }));
vi.mock("../src/lib/opening-stock-database", () => ({ openOpeningStock: mock.open }));
vi.mock("../src/lib/stock-sync", () => ({ stockSync: { subscribe: vi.fn(), get: () => mock.status, retryNow: mock.retry } }));
import SyncScreen from "../src/app/sync";

const shopId = "00000000-0000-4000-8000-000000000001", packId = "00000000-0000-4000-8000-000000000002", dal = "00000000-0000-4000-8000-000000000009";
function render() { mock.cursor = 0; return SyncScreen(); }
function elements(node: unknown): Array<{ type: unknown; props: Record<string, unknown> }> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as { type: unknown; props: Record<string, unknown> };
  return [element, ...elements(element.props.children)];
}
function texts() {
  return elements(render()).flatMap(({ props: { children } }) => typeof children === "string" ? [children]
    : Array.isArray(children) && children.every((child) => typeof child === "string" || typeof child === "number") ? [children.join("")] : []);
}
function linkTo(label: string) {
  return elements(render()).find((node) => node.props.href && elements(node.props.children).some((child) => child.props.children === label))?.props.href;
}
async function settle() { await new Promise((resolve) => setTimeout(resolve, 0)); render(); await new Promise((resolve) => setTimeout(resolve, 0)); }

describe("S08 Waiting to sync (#395)", () => {
  let db: DatabaseSync, queue: ReturnType<typeof openingStockQueue>;
  beforeEach(() => {
    vi.clearAllMocks(); mock.hooks = []; mock.effects = new Map(); mock.view = { mode: "online" };
    mock.status = { running: false, outcome: "done", failures: 0 };
    db = new DatabaseSync(":memory:"); queue = openingStockQueue(adapter(db), randomUUID);
    mock.open.mockResolvedValue(queue);
    mock.listings.mockResolvedValue({ ok: true, data: { items: [{ packId: dal, name: "Dal", packQuantity: "0.500", baseUnit: "kg" }] } });
  });
  afterEach(() => db.close());

  it("shows the three sections in order with the meter, a refusal's reason, reference and fix, and names from the Stock copy or listings", async () => {
    queue.cache.apply({ shopId, state: "live", cursor: `${shopId}:1`, changes: [{ packId, deletedAt: null,
      item: { packId, listingId: packId, name: "Rice", packQuantity: "1", baseUnit: "kg", quantity: "7", held: "0", outOfStock: false } }] });
    queue.saveFlag(shopId, packId, true);
    const batch = queue.batch(shopId);
    queue.acknowledge(batch, { results: [{ actionId: batch.actions[0]?.id ?? "", sequence: 1, status: "rejected", code: "ACTION_TOO_OLD", result: null, clockSuspect: false }] });
    queue.save(shopId, dal, { quantity: "4", clientId: randomUUID() });
    render(); await settle();
    const lines = texts();
    expect(lines).toContain("Offline room used: 1 of 500 · 72 h left");
    const order = ["Needs attention · 1", "Waiting to sync · 1", "Synced today · 0"].map((line) => lines.indexOf(line));
    expect(order.every((index, i) => index >= 0 && (i === 0 || index > (order[i - 1] ?? 0)))).toBe(true);
    expect(lines).toContain("Rice · 1 kg"); expect(lines).toContain("Marked out of stock");
    expect(lines).toContain("This change waited too long to sync, so the server refused it.");
    expect(lines).toContain(`Support reference: ${batch.actions[0]?.id}`);
    expect(linkTo("Fix in Stock")).toBe("/stock");
    // No Stock copy names the opening-stock pack, so the listings do.
    expect(lines).toContain("Dal · 0.5 kg"); expect(lines).toContain("Opening stock 4 kg");
    expect(elements(render()).some((node) => node.props.address === "help@example.com")).toBe(true);
  });

  it("says changes stay on the phone after a failed pass, retries on request, and goes back to Stock offline", async () => {
    mock.status = { running: false, outcome: "retry", failures: 2 }; mock.view = { mode: "offline" };
    render(); await settle();
    expect(texts()).toContain("Couldn't reach YGo. Changes stay on this phone and sync by themselves when you're back online.");
    expect(texts()).toContain("None");
    expect(mock.listings).not.toHaveBeenCalled();
    expect(linkTo("Back")).toBe("/stock");
    (elements(render()).find((node) => node.props.label === "Retry sync")?.props.onPress as () => void)();
    expect(mock.retry).toHaveBeenCalledOnce();
  });

  it("says syncing stopped after a refusal, and offline points opening-stock fixes to going online", async () => {
    mock.status = { running: false, outcome: "halt", failures: 0 }; mock.view = { mode: "offline" };
    queue.save(shopId, dal, { quantity: "4", clientId: randomUUID() });
    const batch = queue.batch(shopId);
    queue.acknowledge(batch, { results: [{ actionId: batch.actions[0]?.id ?? "", sequence: 1, status: "rejected", code: "ACTION_TOO_OLD", result: null, clockSuspect: false }] });
    render(); await settle();
    expect(texts()).toContain("Syncing stopped. Changes stay on this phone. Fix what needs attention, then tap Retry sync.");
    expect(texts()).toContain("Go online to fix this in Opening stock.");
    expect(elements(render()).some((node) => node.props.href === "/opening-stock")).toBe(false);
  });
});
