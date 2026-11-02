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
  useMemo: (make: () => unknown) => make(),
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
}));
vi.mock("expo-router", () => ({ Link: "Link", useFocusEffect: (callback: () => void) => { if (!mock.focused) { mock.focused = true; callback(); } } }));
vi.mock("@ygo/mobile", () => ({ Text: "Text", Button: "Button", SupportEmail: "SupportEmail", FieldMessage: "FieldMessage", PhoneField: "PhoneField" }));
vi.mock("../src/components/icons", () => ({ Minus: "Minus", Plus: "Plus", Square: "Square", SquareCheck: "SquareCheck" }));
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
  const element = node as { type: unknown; props: Record<string, unknown> };
  // Render our own components, such as BillCard, in place.
  if (typeof element.type === "function") return elements((element.type as (props: unknown) => unknown)(element.props));
  return [element, ...elements(element.props.children)];
}
const find = (test: (props: Record<string, unknown>) => boolean) => elements(render()).find((node) => test(node.props))?.props;
const text = (props: Record<string, unknown> | undefined) => elements(props?.children).concat(props ? [{ props }] : []).flatMap((node) => {
  const children = node.props.children;
  return typeof children === "string" ? [children] : Array.isArray(children) && children.every((child) => typeof child === "string" || typeof child === "number") ? [children.join("")] : [];
});
const texts = () => text({ children: render() }).concat(elements(render()).flatMap((node) => typeof node.props.text === "string" ? [node.props.text] : []));
const type = (label: string, value: string) => (find((props) => props.accessibilityLabel === label || props.label === label)?.onChangeText as (value: string) => void)(value);
const tap = (test: (props: Record<string, unknown>) => boolean) => (find(test)?.onPress as () => void)();
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

  it("queues the bill once when Save is tapped twice before the cleared form redraws", async () => {
    render(); await settle();
    (find((props) => props.accessibilityLabel === "Search products")?.onChangeText as (value: string) => void)("rice");
    (find((props) => props.accessibilityRole === "button" && text(props).includes("Rice · 1 kg"))?.onPress as () => void)();
    (find((props) => props.accessibilityRole === "radio" && text(props).includes("UPI"))?.onPress as () => void)();
    const tap = find((props) => props.label === "Save bill")?.onPress as () => void;
    tap(); tap();
    expect(queue.batch(shopId).actions).toHaveLength(1);
  });

  it("greys a pack whose price isn't on the phone yet, so it can't be billed", async () => {
    render(); await settle();
    (find((props) => props.accessibilityLabel === "Search products")?.onChangeText as (value: string) => void)("dal");
    const pick = find((props) => props.accessibilityRole === "button" && text(props).includes("Dal · 1 kg"));
    expect(pick?.disabled).toBe(true);
    expect(text(pick)).toContain("Connect once to get its price");
  });

  it("bills a typed item less a discount for a customer who agrees to offers, and shows them on the bill (#53)", async () => {
    render(); await settle();
    tap((props) => props.label === "Add a typed item");
    type("Typed item 1: Item name", "Rope"); type("Typed item 1: Price each (₹)", "15");
    tap((props) => props.accessibilityLabel === "One more Typed item 1");
    type("Discount (₹)", "5");
    expect(texts()).toEqual(expect.arrayContaining(["Items ₹30 · Discount ₹5", "Total ₹25"]));
    expect(find((props) => props.accessibilityRole === "checkbox")?.disabled).toBe(true);
    type("Customer name", "Meera"); type("Customer phone", "98765 43210");
    tap((props) => props.accessibilityRole === "checkbox");
    expect(find((props) => props.accessibilityRole === "checkbox")?.accessibilityState).toEqual({ checked: true, disabled: false });
    tap((props) => props.accessibilityRole === "radio" && text(props).includes("UPI"));
    tap((props) => props.label === "Save bill");

    expect(queue.batch(shopId).actions[0]?.payload).toEqual({ lines: [], manualLines: [{ name: "Rope", count: 2, unitPrice: "15" }], discount: "5",
      customer: { name: "Meera", phone: "+919876543210", offers: true }, total: "25.00", payment: "upi" });
    expect(texts()).toEqual(expect.arrayContaining(["₹25 · UPI · 1 item", "Meera · +919876543210"]));
    // The form starts empty again.
    expect(find((props) => props.accessibilityLabel === "Discount (₹)")).toBeUndefined();
  });

  it("marks a typed item with no price and a short phone when Save is tapped, and queues nothing (#53)", async () => {
    render(); await settle();
    tap((props) => props.label === "Add a typed item");
    type("Typed item 1: Item name", "Rope"); type("Customer phone", "12345");
    tap((props) => props.accessibilityRole === "radio" && text(props).includes("Cash"));
    expect(texts()).not.toContain("Type a price such as 40 or 39.50.");
    tap((props) => props.label === "Save bill");
    expect(texts()).toEqual(expect.arrayContaining(["Type a price such as 40 or 39.50.", "Fix the fields marked in red to save.", "Fill in every item to see the total."]));
    expect(find((props) => props.label === "Customer phone")?.message).toBe("Enter a 10-digit mobile number, such as 98765 43210.");
    expect(queue.batch(shopId).actions).toHaveLength(0);
  });

  it("finds an older day's bill by its reference or its number, offline (#53)", async () => {
    const saved = queue.saveBill(shopId, { lines: [{ packId: rice, count: 1, unitPrice: "21" }], total: "21.00", payment: "cash" });
    if (typeof saved === "string") throw new Error(saved);
    const batch = queue.batch(shopId);
    queue.acknowledge(batch, { results: batch.actions.map((sent) => ({ actionId: sent.id, sequence: sent.sequence, status: "applied", code: null, clockSuspect: false,
      result: { billId: randomUUID(), reference: saved.reference, number: 987654, heldReason: null, totalMismatch: false, recordedAt: new Date().toISOString() } })) });
    db.prepare("UPDATE opening_stock_actions SET action = json_set(action, '$.createdAt', '2020-01-01T00:00:00.000Z')").run();
    render(); await settle();
    expect(texts()).toContain("No bills yet today.");

    type("Find a bill by reference or number", saved.reference.toLowerCase());
    expect(texts()).toEqual(expect.arrayContaining(["Bills found · 1", `Bill ${saved.reference}`, "Synced · Bill 987654"]));
    type("Find a bill by reference or number", "987654");
    expect(texts()).toContain("Synced · Bill 987654");
    type("Find a bill by reference or number", "Rice");
    expect(texts()).toEqual(expect.arrayContaining(["Bills found · 0", "No bill on this phone matches."]));
  });

  it("trims a price and discount as their fields are left, takes a spaced discount, and clears the offers tick when the phone changes (#53)", async () => {
    render(); await settle();
    tap((props) => props.label === "Add a typed item");
    type("Typed item 1: Item name", "Rope"); type("Typed item 1: Price each (₹)", "15.50");
    (find((props) => props.accessibilityLabel === "Typed item 1: Price each (₹)")?.onBlur as () => void)();
    expect(find((props) => props.accessibilityLabel === "Typed item 1: Price each (₹)")?.value).toBe("15.5");
    type("Discount (₹)", "5.");
    (find((props) => props.accessibilityLabel === "Discount (₹)")?.onBlur as () => void)();
    expect(find((props) => props.accessibilityLabel === "Discount (₹)")?.value).toBe("5");
    type("Discount (₹)", " 5 ");
    expect(texts()).toEqual(expect.arrayContaining(["Items ₹15.50 · Discount ₹5", "Total ₹10.50"]));

    type("Customer phone", "98765 43210");
    tap((props) => props.accessibilityRole === "checkbox");
    type("Customer phone", "98765 43211");
    expect(find((props) => props.accessibilityRole === "checkbox")?.accessibilityState).toEqual({ checked: false, disabled: false });
  });

  it("stops at 100 catalog and typed items together, as the contract does (#53)", async () => {
    render(); await settle();
    (find((props) => props.accessibilityLabel === "Search products")?.onChangeText as (value: string) => void)("rice");
    tap((props) => props.accessibilityRole === "button" && text(props).includes("Rice · 1 kg"));
    for (let i = 0; i < 100; i++) tap((props) => props.label === "Add a typed item");
    expect(find((props) => props.accessibilityLabel === "Typed item 99: Item name")).toBeDefined();
    expect(find((props) => props.accessibilityLabel === "Typed item 100: Item name")).toBeUndefined();
    expect(texts()).toContain("A bill holds up to 100 items. Save this one and start another.");
  });
});
