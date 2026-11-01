import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openingStockQueue } from "../src/lib/opening-stock-queue";
import { adapter } from "./stock-database-fixture";

const mock = vi.hoisted(() => ({ get: vi.fn(), open: vi.fn(), allowed: vi.fn(), run: vi.fn(), hooks: [] as unknown[], cursor: 0, focused: false }));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const index = mock.cursor++;
    if (!(index in mock.hooks)) mock.hooks[index] = initial;
    return [mock.hooks[index], (value: unknown) => { mock.hooks[index] = typeof value === "function" ? value(mock.hooks[index]) : value; }];
  },
  useRef: (initial: unknown) => {
    const index = mock.cursor++;
    if (!(index in mock.hooks)) mock.hooks[index] = { current: initial };
    return mock.hooks[index];
  },
  useCallback: (callback: unknown) => callback,
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
}));
vi.mock("expo-router", () => ({ Link: "Link", useFocusEffect: (callback: () => void) => { if (!mock.focused) { mock.focused = true; callback(); } } }));
vi.mock("@ygo/mobile", () => ({ Text: "Text", Button: "Button", SupportEmail: "SupportEmail" }));
vi.mock("../src/components/icons", () => ({ Minus: "Minus", Plus: "Plus" }));
vi.mock("../src/components/sync-status", () => ({ SyncStatus: "SyncStatus" }));
vi.mock("react-native", () => ({ ActivityIndicator: "Spinner", Pressable: "Pressable", ScrollView: "ScrollView", TextInput: "TextInput", View: "View" }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("../src/api", () => ({ accountEpoch: () => 0, supportEmail: "help@example.com", session: { get: mock.get },
  access: { subscribe: () => () => undefined, allowed: mock.allowed, expire: vi.fn(), get: () => ({ shopId: "00000000-0000-4000-8000-000000000001", mode: "offline" }) } }));
vi.mock("../src/lib/opening-stock-database", () => ({ openOpeningStock: mock.open }));
vi.mock("../src/lib/stock-sync", () => ({ stockSync: { subscribe: () => () => undefined, get: () => ({ running: false }), run: mock.run } }));
import BillScreen from "../src/app/bill";

const shopId = "00000000-0000-4000-8000-000000000001", rice = "00000000-0000-4000-8000-000000000002", dal = "00000000-0000-4000-8000-000000000003";
const item = { listingId: rice, packId: rice, name: "Rice", packQuantity: "1.000", baseUnit: "kg" as const, quantity: "-2", held: "0", outOfStock: true, counterPrice: "21.00" };

function render() { mock.cursor = 0; return BillScreen(); }
function elements(node: unknown): Array<{ props: Record<string, unknown> }> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as { props: Record<string, unknown> };
  return [element, ...elements(element.props.children)];
}
const find = (test: (props: Record<string, unknown>) => boolean) => elements(render()).find((node) => test(node.props))?.props;
const text = (props: Record<string, unknown> | undefined) => elements(props?.children).concat(props ? [{ props }] : []).flatMap((node) => {
  const children = node.props.children;
  return typeof children === "string" ? [children] : Array.isArray(children) && children.every((child) => typeof child === "string" || typeof child === "number") ? [children.join("")] : [];
});
const texts = () => text({ children: render() });
async function settle() { for (let i = 0; i < 10; i++) await Promise.resolve(); }

describe("S06 Counter bill (#468)", () => {
  let db: DatabaseSync, queue: ReturnType<typeof openingStockQueue>;
  beforeEach(() => {
    vi.clearAllMocks(); mock.hooks = []; mock.cursor = 0; mock.focused = false;
    db = new DatabaseSync(":memory:"); queue = openingStockQueue(adapter(db), randomUUID);
    queue.cache.apply({ shopId, state: "live", cursor: `${shopId}:1`, changes: [{ packId: rice, item, deletedAt: null }] });
    // Saved before #468: no counter price until the next pull.
    db.prepare("INSERT INTO stock_cache_items (shop_id, pack_id, payload) VALUES (?, ?, ?)").run(shopId, dal,
      JSON.stringify({ ...item, listingId: dal, packId: dal, name: "Dal", counterPrice: undefined }));
    mock.get.mockReturnValue({ account: { id: "account-1" } }); mock.open.mockResolvedValue(queue); mock.allowed.mockReturnValue(true);
  });
  afterEach(() => db.close());

  it("bills an out-of-stock pack offline at its counter price, then shows the bill's number once it syncs", async () => {
    render(); await settle();
    (find((props) => props.accessibilityLabel === "Search products")?.onChangeText as (value: string) => void)("ric");
    const pick = find((props) => props.accessibilityRole === "button" && text(props).includes("Rice · 1 kg"));
    expect(text(pick)).toContain("₹21");
    (pick?.onPress as () => void)();
    (find((props) => props.accessibilityLabel === "Rice · 1 kg: number of packs")?.onChangeText as (value: string) => void)("2");
    (find((props) => props.accessibilityLabel === "One more Rice · 1 kg")?.onPress as () => void)();
    expect(texts()).toContain("Total ₹63");
    expect(find((props) => props.label === "Save bill")?.disabled).toBe(true);
    (find((props) => props.accessibilityRole === "radio" && text(props).includes("Cash"))?.onPress as () => void)();
    (find((props) => props.label === "Save bill")?.onPress as () => void)();

    const [action] = queue.batch(shopId).actions;
    expect(action).toMatchObject({ type: "counter_bill", payload: { lines: [{ packId: rice, count: 3, unitPrice: "21.00" }], total: "63.00", payment: "cash" } });
    expect(mock.run).toHaveBeenCalled();
    const [bill] = queue.bills(shopId, new Date(0));
    expect(texts()).toEqual(expect.arrayContaining([`Saved · Bill ${bill?.reference}`, `Bill ${bill?.reference}`, "₹63 · Cash · 1 item", "Saved on phone · number pending"]));

    const batch = queue.batch(shopId);
    queue.acknowledge(batch, { results: batch.actions.map((sent) => ({ actionId: sent.id, sequence: sent.sequence, status: "applied", code: null, clockSuspect: false,
      result: { billId: randomUUID(), reference: bill?.reference ?? "", number: 1, heldReason: null, totalMismatch: false, recordedAt: new Date().toISOString() } })) });
    expect(texts()).toContain("Synced · Bill 1");
  });

  it("greys a pack whose price isn't on the phone yet, so it can't be billed", async () => {
    render(); await settle();
    (find((props) => props.accessibilityLabel === "Search products")?.onChangeText as (value: string) => void)("dal");
    const pick = find((props) => props.accessibilityRole === "button" && text(props).includes("Dal · 1 kg"));
    expect(pick?.disabled).toBe(true);
    expect(text(pick)).toContain("Connect once to get its price");
  });
});
