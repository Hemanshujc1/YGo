import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openingStockQueue } from "../src/lib/opening-stock-queue";
import { adapter } from "./stock-database-fixture";

const mock = vi.hoisted(() => ({
  get: vi.fn(), open: vi.fn(), allowed: vi.fn(), run: vi.fn(), share: vi.fn(), bills: vi.fn(), mode: "offline",
  hooks: [] as unknown[], effects: [] as (() => void)[],
  cursor: 0, focused: false,
}));
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
  useEffect: (effect: () => unknown, deps: unknown[]) => {
    const index = mock.cursor++;
    const prev = mock.hooks[index] as { deps: unknown[]; cleanup?: () => void } | undefined;
    if (!prev || deps.some((dep, i) => dep !== prev.deps[i])) {
      mock.effects.push(() => {
        prev?.cleanup?.();
        const cleanup = effect();
        mock.hooks[index] = { deps, cleanup: typeof cleanup === "function" ? (cleanup as () => void) : undefined };
      });
    }
  },
}));
vi.mock("expo-router", () => ({ Link: "Link", useFocusEffect: (callback: () => void) => { if (!mock.focused) { mock.focused = true; callback(); } } }));
vi.mock("@ygo/mobile", () => ({ Text: "Text", Button: "Button", SupportEmail: "SupportEmail", FieldMessage: "FieldMessage", PhoneField: "PhoneField" }));
vi.mock("../src/components/icons", () => ({ Minus: "Minus", Plus: "Plus", Share2: "Share2", Square: "Square", SquareCheck: "SquareCheck" }));
vi.mock("../src/lib/share-bill", () => ({ shareBill: mock.share }));
vi.mock("../src/components/sync-status", () => ({ SyncStatus: "SyncStatus" }));
vi.mock("react-native", () => ({ ActivityIndicator: "Spinner", Pressable: "Pressable", ScrollView: "ScrollView", TextInput: "TextInput", View: "View" }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("../src/api", () => ({ accountEpoch: () => 0, supportEmail: "help@example.com", session: { get: mock.get }, api: { shopCounterBills: mock.bills },
  access: { subscribe: () => () => undefined, answersOrders: () => false, allowed: mock.allowed, expire: vi.fn(), shopName: () => "Sai General Stores", shopGstin: () => null, get: () => ({ shopId: "00000000-0000-4000-8000-000000000001", mode: mock.mode }) } }));
vi.mock("../src/lib/opening-stock-database", () => ({ openOpeningStock: mock.open }));
vi.mock("../src/lib/stock-sync", () => ({ stockSync: { subscribe: () => () => undefined, get: () => ({ running: false }), run: mock.run } }));
import BillScreen from "../src/app/bill";

const shopId = "00000000-0000-4000-8000-000000000001", rice = "00000000-0000-4000-8000-000000000002", dal = "00000000-0000-4000-8000-000000000003";
const item = { listingId: rice, packId: rice, name: "Rice", packQuantity: "1.000", baseUnit: "kg" as const, quantity: "-2", held: "0", outOfStock: true, counterPrice: "21.00" };

function render() { mock.cursor = 0; const tree = BillScreen(); for (const effect of mock.effects.splice(0)) effect(); return tree; }
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
const type = (label: string, value: string) => {
  (find((props) => props.accessibilityLabel === label || props.label === label)?.onChangeText as (value: string) => void)(value);
  render();
  vi.advanceTimersByTime(250);
  render();
};
const tap = (test: (props: Record<string, unknown>) => boolean) => (find(test)?.onPress as () => void)();
async function settle() { for (let i = 0; i < 10; i++) await Promise.resolve(); }

describe("S06 Counter bill (#468)", () => {
  let db: DatabaseSync, queue: ReturnType<typeof openingStockQueue>;
  beforeEach(() => {
    vi.clearAllMocks(); vi.useFakeTimers(); mock.hooks = []; mock.cursor = 0; mock.focused = false; mock.effects = [];
    db = new DatabaseSync(":memory:"); queue = openingStockQueue(adapter(db), randomUUID);
    queue.cache.apply({ shopId, state: "live", cursor: `${shopId}:1`, changes: [{ packId: rice, item, deletedAt: null }] });
    // Saved before #468: no counter price until the next pull.
    db.prepare("INSERT INTO stock_cache_items (shop_id, pack_id, payload) VALUES (?, ?, ?)").run(shopId, dal,
      JSON.stringify({ ...item, listingId: dal, packId: dal, name: "Dal", counterPrice: undefined }));
    mock.mode = "offline"; mock.get.mockReturnValue({ account: { id: "account-1" } }); mock.open.mockResolvedValue(queue); mock.allowed.mockReturnValue(true);
  });
  afterEach(() => {
    for (const hook of mock.hooks) {
      if (hook && typeof hook === "object" && "cleanup" in hook) (hook as { cleanup?: () => void }).cleanup?.();
    }
    vi.useRealTimers(); db.close();
  });

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
    expect(texts()).toEqual(expect.arrayContaining(["₹25 · UPI · 1 item", "Meera · 98765 43210"]));
    // The form starts empty again.
    expect(find((props) => props.accessibilityLabel === "Typed item 1: Item name")).toBeUndefined();
    expect(find((props) => props.accessibilityLabel === "Discount (₹)")?.value).toBe("");
    expect(find((props) => props.accessibilityLabel === "Customer name")?.value).toBe("");
    expect(find((props) => props.label === "Customer phone")?.value).toBe("");
    expect(find((props) => props.label === "Save bill")?.disabled).toBe(true);
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

  it("learns a void from the server when online, shows it on the card and in search, and keeps it when a later read fails or the phone is offline (#493)", async () => {
    const saved = queue.saveBill(shopId, { lines: [{ packId: rice, count: 1, unitPrice: "21" }], total: "21.00", payment: "cash" });
    if (typeof saved === "string") throw new Error(saved);
    const batch = queue.batch(shopId), billId = randomUUID();
    queue.acknowledge(batch, { results: batch.actions.map((sent) => ({ actionId: sent.id, sequence: sent.sequence, status: "applied", code: null, clockSuspect: false,
      result: { billId, reference: saved.reference, number: 12, heldReason: null, totalMismatch: false, recordedAt: new Date().toISOString() } })) });
    const now = new Date().toISOString();
    mock.mode = "online";
    mock.bills.mockResolvedValue({ ok: true, data: { bills: [{ id: billId, reference: saved.reference, number: 12, total: "21", payment: "cash", madeAt: now, receivedAt: now, voidUntil: null, voidable: false,
      voided: { reason: "other", note: "Customer left", createdAt: now } }] } });
    render(); await settle(); render(); await settle();
    expect(mock.bills).toHaveBeenCalledTimes(1);
    expect(texts()).toContain("Voided · Other · Customer left");
    expect(texts()).not.toContain("Synced · Bill 12");
    type("Find a bill by reference or number", "12");
    expect(texts()).toContain("Voided · Other · Customer left");

    // A failed read, an empty list and no connection never take the void back.
    mock.hooks = []; mock.focused = false; mock.effects = [];
    mock.bills.mockResolvedValue({ ok: true, data: { bills: [] } });
    render(); await settle(); render(); await settle();
    expect(mock.bills).toHaveBeenCalledTimes(2);
    expect(texts()).toContain("Voided · Other · Customer left");
    mock.hooks = []; mock.focused = false; mock.effects = []; mock.mode = "offline"; mock.bills.mockClear();
    render(); await settle();
    expect(mock.bills).not.toHaveBeenCalled();
    expect(texts()).toContain("Voided · Other · Customer left");
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

    (find((props) => props.accessibilityLabel === "Find a bill by reference or number")?.onChangeText as (value: string) => void)(saved.reference.toLowerCase());
    render();
    expect(texts()).not.toContain("Bills found · 1");
    vi.advanceTimersByTime(250);
    render();
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
    expect(find((props) => props.label === "Customer phone")?.autofill).toBe(false);

    type("Customer phone", "98765 43210");
    tap((props) => props.accessibilityRole === "checkbox");
    type("Customer phone", "98765 43211");
    expect(find((props) => props.accessibilityRole === "checkbox")?.accessibilityState).toEqual({ checked: false, disabled: false });
  });

  it("shares a bill as a PDF before it syncs, with the shop's name and each pack's name, but not a refused bill (#53)", async () => {
    const refused = queue.saveBill(shopId, { lines: [{ packId: rice, count: 1, unitPrice: "21" }], total: "21.00", payment: "cash" });
    const waiting = queue.saveBill(shopId, { lines: [{ packId: rice, count: 2, unitPrice: "21" }], total: "42.00", payment: "upi" });
    if (typeof refused === "string" || typeof waiting === "string") throw new Error("not saved");
    db.prepare("UPDATE opening_stock_actions SET status = 'rejected', result = ? WHERE id = ?").run(JSON.stringify({ code: "VALIDATION_FAILED" }), refused.id);
    mock.share.mockResolvedValue(undefined);
    render(); await settle();
    const shares = elements(render()).filter((node) => node.props.label === "Share bill");
    expect(shares).toHaveLength(1);
    (shares[0]?.props.onPress as () => void)(); await settle();
    const [{ bill, shopName, label }] = mock.share.mock.calls[0] as [{ bill: { reference: string; status: string }; shopName: string; label: (packId: string) => { name: string } | null }];
    expect(bill).toMatchObject({ reference: waiting.reference, status: "pending" });
    expect(shopName).toBe("Sai General Stores");
    expect(label(rice)?.name).toBe("Rice");

    mock.share.mockRejectedValue(new Error("no printer"));
    tap((props) => props.label === "Share bill"); await settle();
    expect(texts()).toContain("Couldn't make the bill PDF. Try again.");
  });

  // 100 full re-renders: slow when the machine is busy, so it gets a longer limit (#541).
  it("stops at 100 catalog and typed items together, as the contract does (#53)", async () => {
    render(); await settle();
    (find((props) => props.accessibilityLabel === "Search products")?.onChangeText as (value: string) => void)("rice");
    tap((props) => props.accessibilityRole === "button" && text(props).includes("Rice · 1 kg"));
    for (let i = 0; i < 100; i++) tap((props) => props.label === "Add a typed item");
    expect(find((props) => props.accessibilityLabel === "Typed item 99: Item name")).toBeDefined();
    expect(find((props) => props.accessibilityLabel === "Typed item 100: Item name")).toBeUndefined();
    expect(texts()).toContain("A bill holds up to 100 items. Save this one and start another.");
  }, 30_000);

  it("clamps typed count at 1 on minus and removes the item with the Remove action (#485)", async () => {
    render(); await settle();
    tap((props) => props.label === "Add a typed item");
    expect(find((props) => props.accessibilityLabel === "Typed item 1: count")?.value).toBe("1");
    tap((props) => props.accessibilityLabel === "One less Typed item 1");
    expect(find((props) => props.accessibilityLabel === "Typed item 1: count")?.value).toBe("1");
    expect(find((props) => props.accessibilityLabel === "Typed item 1: Item name")).toBeDefined();
    tap((props) => props.accessibilityLabel === "Typed item 1: Remove");
    expect(find((props) => props.accessibilityLabel === "Typed item 1: Item name")).toBeUndefined();
  });

  it("shows a prompt to fix the discount when lines are valid but the discount is not (#485)", async () => {
    render(); await settle();
    tap((props) => props.label === "Add a typed item");
    type("Typed item 1: Item name", "Rope");
    type("Typed item 1: Price each (₹)", "50");
    expect(texts()).toContain("Total ₹50");

    type("Discount (₹)", "60");
    expect(texts()).toContain("Fix the discount to see the total.");
    expect(texts()).not.toContain("Fill in every item to see the total.");

    type("Discount (₹)", "10.");
    expect(texts()).toContain("Fix the discount to see the total.");

    type("Discount (₹)", "10");
    expect(texts()).toContain("Total ₹40");
  });

  it("marks invalid catalog count in red and reports fixFields on Save (#485)", async () => {
    render(); await settle();
    type("Search products", "ric");
    tap((props) => props.accessibilityRole === "button" && text(props).includes("Rice · 1 kg"));
    type("Rice · 1 kg: number of packs", "0");
    tap((props) => props.accessibilityRole === "radio" && text(props).includes("Cash"));
    tap((props) => props.label === "Save bill");
    expect(texts()).toContain("Fix the fields marked in red to save.");
    expect(texts()).toContain("Each count must be 1 to 9,999 packs.");
    const countInput = find((props) => props.accessibilityLabel === "Rice · 1 kg: number of packs");
    expect(countInput?.className).toContain("border-danger");
  });

  it("refuses to save an empty bill and asks for at least one item (#485)", async () => {
    render(); await settle();
    tap((props) => props.accessibilityRole === "radio" && text(props).includes("Cash"));
    expect(find((props) => props.label === "Save bill")?.disabled).toBe(false);
    tap((props) => props.label === "Save bill");
    expect(texts()).toContain("Add at least one item to save.");
    expect(queue.batch(shopId).actions).toHaveLength(0);
  });

  it("shows no-items message when the last item is removed and Save is tapped (#485)", async () => {
    render(); await settle();
    tap((props) => props.label === "Add a typed item");
    type("Typed item 1: Item name", "Rope");
    type("Typed item 1: Price each (₹)", "15");
    tap((props) => props.accessibilityRole === "radio" && text(props).includes("Cash"));
    expect(find((props) => props.label === "Save bill")?.disabled).toBe(false);

    tap((props) => props.accessibilityLabel === "Typed item 1: Remove");
    expect(find((props) => props.accessibilityLabel === "Typed item 1: Item name")).toBeUndefined();

    tap((props) => props.label === "Save bill");
    expect(texts()).toContain("Add at least one item to save.");
    expect(texts()).not.toContain("Fix the fields marked in red to save.");
    expect(texts()).not.toContain("Couldn't save the bill to this phone. Try again.");
    expect(queue.batch(shopId).actions).toHaveLength(0);

    type("Search products", "ric");
    tap((props) => props.accessibilityRole === "button" && text(props).includes("Rice · 1 kg"));
    expect(find((props) => props.accessibilityLabel === "Rice · 1 kg: number of packs")).toBeDefined();
    tap((props) => props.accessibilityLabel === "One less Rice · 1 kg");
    expect(find((props) => props.accessibilityLabel === "Rice · 1 kg: number of packs")).toBeUndefined();

    tap((props) => props.label === "Save bill");
    expect(texts()).toContain("Add at least one item to save.");
    expect(texts()).not.toContain("Fix the fields marked in red to save.");
    expect(texts()).not.toContain("Couldn't save the bill to this phone. Try again.");
    expect(queue.batch(shopId).actions).toHaveLength(0);
  });

  it("cancels earlier debounce timers when typing rapidly and shows results only after pause (#485)", async () => {
    const saved = queue.saveBill(shopId, { lines: [{ packId: rice, count: 1, unitPrice: "21" }], total: "21.00", payment: "cash" });
    if (typeof saved === "string") throw new Error(saved);
    db.prepare("UPDATE opening_stock_actions SET action = json_set(action, '$.createdAt', '2020-01-01T00:00:00.000Z')").run();
    render(); await settle();

    const searchInput = (value: string) => (find((props) => props.accessibilityLabel === "Find a bill by reference or number")?.onChangeText as (value: string) => void)(value);
    const ref = saved.reference.replace("-", "").toLowerCase();

    searchInput(ref.slice(0, 1));
    render();
    vi.advanceTimersByTime(100);
    searchInput(ref.slice(0, 2));
    render();
    vi.advanceTimersByTime(100);
    searchInput(ref.slice(0, 4));
    render();

    vi.advanceTimersByTime(100);
    render();
    expect(texts()).not.toContain("Bills found");
    expect(texts()).not.toContain("Today's bills");

    vi.advanceTimersByTime(150);
    render();
    expect(texts()).toEqual(expect.arrayContaining(["Bills found · 1", `Bill ${saved.reference}`]));

    searchInput("");
    render();
    expect(texts()).toContain("Today's bills · 1");
    expect(texts()).not.toContain("Bills found");
  });

  it("offers a product request on every named typed line, carrying its name and price, and leaves the bill as it was (#565)", async () => {
    render(); await settle();
    tap((props) => props.label === "Add a typed item");
    const request = (props: Record<string, unknown>) => props.accessibilityLabel === "Typed item 1: Request this as a product";
    expect(find(request)).toBeUndefined();
    type("Typed item 1: Item name", "  Rope "); type("Typed item 1: Price each (₹)", "15");
    expect(find(request)).toBeDefined();
    expect(find((props) => typeof props.href === "object")?.href).toEqual({ pathname: "/product-requests", params: { name: "Rope", price: "15" } });
    expect(find((props) => props.accessibilityLabel === "Typed item 1: Item name")?.value).toBe("  Rope ");
    expect(find((props) => props.accessibilityLabel === "Typed item 1: Price each (₹)")?.value).toBe("15");
    expect(queue.batch(shopId).actions).toHaveLength(0);
  });
});
