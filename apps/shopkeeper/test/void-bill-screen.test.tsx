import type { ShopCounterBill } from "@ygo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  list: vi.fn(), send: vi.fn(), waiting: 0, hooks: [] as unknown[], cursor: 0, focused: false, started: false,
}));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const index = mock.cursor++;
    if (!(index in mock.hooks)) mock.hooks[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [mock.hooks[index], (value: unknown) => { mock.hooks[index] = typeof value === "function" ? value(mock.hooks[index]) : value; }];
  },
  useRef: (initial: unknown) => {
    const index = mock.cursor++;
    if (!(index in mock.hooks)) mock.hooks[index] = { current: initial };
    return mock.hooks[index];
  },
  useEffect: (effect: () => void) => effect(),
  useCallback: (callback: unknown) => callback,
  useMemo: (make: () => unknown) => make(),
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
}));
vi.mock("expo-router", () => ({ Link: "Link", useFocusEffect: (callback: () => void) => { if (!mock.focused) { mock.focused = true; callback(); } } }));
vi.mock("@ygo/mobile", () => ({
  Text: "Text", Button: "Button", FieldMessage: "FieldMessage",
  useInFront: (store: { start(): void }) => { if (!mock.started) { mock.started = true; store.start(); } },
}));
vi.mock("react-native", () => ({
  ActivityIndicator: "Spinner", KeyboardAvoidingView: "KeyboardAvoidingView", Modal: "Modal", Pressable: "Pressable", RefreshControl: "RefreshControl",
  ScrollView: "ScrollView", TextInput: "TextInput", View: "View",
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("../src/api", () => ({
  api: { shopCounterBills: mock.list, voidCounterBill: mock.send }, accountEpoch: () => 0,
  session: { get: () => ({ account: { id: "account-1" } }) },
  access: { get: () => ({ shopId: "shop-1" }), allowed: () => true },
}));
vi.mock("../src/lib/opening-stock-database", () => ({ openOpeningStock: () => Promise.resolve({ billCount: () => mock.waiting }) }));
vi.mock("../src/lib/stock-sync", () => ({ stockSync: { subscribe: () => () => undefined, get: () => ({ running: false }) } }));
import VoidBillScreen from "../src/app/void-bill";

const id = "7d2e9a4c-6b1f-4c3a-8e5d-0f2a4b6c8d1e";
const bill = (over: Partial<ShopCounterBill> = {}): ShopCounterBill => ({
  id, reference: "7D2E9A4C", number: 12, total: "63.00", payment: "cash", madeAt: "2030-01-01T10:00:00.000Z", receivedAt: "2030-01-01T10:00:05.000Z",
  voidUntil: "2030-01-02T10:00:05.000Z", voidable: true, voided: null, ...over,
});
const voided = (reason: "billed_twice" | "other" = "billed_twice", note: string | null = null) =>
  bill({ voidable: false, voided: { reason, note, createdAt: "2030-01-01T11:00:00.000Z" } });

function render() { mock.cursor = 0; return VoidBillScreen(); }
function elements(node: unknown): Array<{ type: unknown; props: Record<string, unknown> }> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as { type: unknown; props: Record<string, unknown> };
  // Render the screen's own parts, such as the bill row and the sheet, in place.
  if (typeof element.type === "function") return elements((element.type as (props: unknown) => unknown)(element.props));
  return [element, ...elements(element.props.children)];
}
const all = () => elements(render());
const find = (test: (props: Record<string, unknown>) => boolean) => all().find((node) => test(node.props))?.props;
const texts = () => all().flatMap((node) => {
  const children = node.props.children;
  if (typeof children === "string") return [children];
  if (Array.isArray(children) && children.every((child) => typeof child === "string" || typeof child === "number")) return [children.join("")];
  return typeof node.props.text === "string" ? [node.props.text] : [];
});
const button = (label: string) => find((props) => props.label === label);
const tap = (label: string) => (button(label)?.onPress as () => void)();
const choose = (reason: string) => (find((props) => props.accessibilityRole === "radio" && elements(props.children).some((node) => node.props.children === reason))?.onPress as () => void)();
const sheetOpen = () => all().some((node) => node.type === "Modal");
async function settle() { for (let i = 0; i < 10; i++) await Promise.resolve(); }

describe("S37 Void a bill (#492)", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mock.hooks = []; mock.cursor = 0; mock.focused = false; mock.started = false; mock.waiting = 0;
  });

  it("shows loading, then a bill within its window with its number, reference, time, total and a Void button", async () => {
    mock.list.mockResolvedValue({ ok: true, data: { bills: [bill()] } });
    expect(texts()).toContain("Loading bills");
    await settle();
    expect(texts()).toEqual(expect.arrayContaining(["Bill 12", "Reference 7D2E9A4C", "₹63 · Cash"]));
    expect(texts()).not.toContain("Loading bills");
    expect(button("Void")).toMatchObject({ variant: "secondary" });
  });

  it("shows voided bills with their reason, older ones without Void, and a held bill with no amount and no Void", async () => {
    mock.list.mockResolvedValue({ ok: true, data: { bills: [
      voided(), { ...voided("other", "Customer changed mind"), id: "b2" },
      bill({ id: "b3", voidable: false }),
      // An unreadable held bill: no number, total or payment (owner's note on #492), even if the server said voidable.
      bill({ id: "b4", number: null, total: null, payment: null, voidUntil: null, voidable: true }),
      bill({ id: "b5", number: null, voidUntil: null, voidable: false }),
    ] } });
    render(); await settle();
    expect(texts()).toEqual(expect.arrayContaining([
      "Voided · Billed twice", "Voided · Other · Customer changed mind", "Older than 24 hours",
      "Number pending", "Number pending · can be voided once it has a number",
    ]));
    // An unreadable bill can't be numbered (#470), so it promises nothing.
    expect(texts().filter((line) => line === "Number pending · can be voided once it has a number")).toHaveLength(1);
    expect(all().filter((node) => node.props.label === "Void")).toHaveLength(0);
    expect(texts().filter((line) => line.startsWith("₹"))).toHaveLength(4);
  });

  it("says when there are no bills, and how many on this phone still wait to sync", async () => {
    mock.list.mockResolvedValue({ ok: true, data: { bills: [] } });
    mock.waiting = 2;
    render(); await settle();
    expect(texts()).toEqual(expect.arrayContaining(["No bills in the last 2 days.", "2 bills on this phone are waiting to sync. You can void them once they have a number."]));
    // Once they sync, they have numbers on the server: the list is read again to show them.
    mock.list.mockResolvedValue({ ok: true, data: { bills: [bill()] } });
    mock.waiting = 0;
    render(); await settle();
    expect(mock.list).toHaveBeenCalledTimes(2);
    expect(texts()).toContain("Bill 12");
    expect(texts().some((line) => line.includes("waiting to sync"))).toBe(false);
  });

  it("says voiding needs a connection offline, and shows the server's error, each with Try again", async () => {
    mock.list.mockRejectedValueOnce(new TypeError("Network request failed")).mockResolvedValueOnce({ ok: false, status: 500, code: "INTERNAL" });
    render(); await settle();
    expect(texts()).toContain("Voiding needs a connection.");
    tap("Try again"); await settle();
    expect(texts()).toContain("Something went wrong on the server.");
    expect(button("Try again")).toBeDefined();
  });

  it("voids with a reason: the red button waits for one, then the row shows Voided", async () => {
    mock.list.mockResolvedValue({ ok: true, data: { bills: [bill()] } });
    mock.send.mockResolvedValue({ ok: true, data: voided() });
    render(); await settle();
    tap("Void");
    expect(texts()).toEqual(expect.arrayContaining(["Void this bill?", "A voided bill keeps its reference and number. This can't be undone."]));
    expect(button("Void bill")).toMatchObject({ variant: "destructive", disabled: true });
    choose("Billed twice");
    expect(button("Void bill")?.disabled).toBe(false);
    tap("Void bill"); await settle();
    expect(mock.send).toHaveBeenCalledWith(id, { reason: "billed_twice" });
    expect(sheetOpen()).toBe(false);
    expect(texts()).toEqual(expect.arrayContaining(["Bill 12 voided.", "Voided · Billed twice"]));
  });

  it("needs a note for Other, and keeps it in the open sheet when the connection drops", async () => {
    mock.list.mockResolvedValue({ ok: true, data: { bills: [bill()] } });
    mock.send.mockRejectedValueOnce(new TypeError("Network request failed")).mockResolvedValueOnce({ ok: true, data: voided("other", "Customer changed mind") });
    render(); await settle();
    tap("Void"); choose("Other");
    expect(button("Void bill")?.disabled).toBe(true);
    const note = () => find((props) => props.accessibilityLabel === "What happened");
    (note()?.onChangeText as (value: string) => void)("   ");
    expect(button("Void bill")?.disabled).toBe(true);
    expect(texts()).toContain("Type what happened, up to 500 characters.");
    (note()?.onChangeText as (value: string) => void)("Customer changed mind");
    tap("Void bill"); await settle();
    expect(sheetOpen()).toBe(true);
    expect(note()?.value).toBe("Customer changed mind");
    expect(texts()).toContain("Voiding needs a connection.");
    tap("Void bill"); await settle();
    expect(mock.send).toHaveBeenLastCalledWith(id, { reason: "other", note: "Customer changed mind" });
    expect(texts()).toContain("Voided · Other · Customer changed mind");
  });

  it("keeps the sheet busy, with no way out, while a void is on its way", async () => {
    mock.list.mockResolvedValue({ ok: true, data: { bills: [bill()] } });
    let answer!: (value: unknown) => void;
    mock.send.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    render(); await settle();
    tap("Void"); choose("Billed twice"); tap("Void bill");
    expect(button("Void bill")?.busy).toBe(true);
    expect(button("Keep bill")?.disabled).toBe(true);
    (find((props) => typeof props.onRequestClose === "function")?.onRequestClose as () => void)();
    expect(sheetOpen()).toBe(true);
    answer({ ok: true, data: voided() }); await settle();
    expect(mock.send).toHaveBeenCalledTimes(1);
    expect(sheetOpen()).toBe(false);
    expect(texts()).toContain("Voided · Billed twice");
  });

  it("closes the sheet and refreshes the list when the bill was already voided", async () => {
    mock.list.mockResolvedValueOnce({ ok: true, data: { bills: [bill()] } }).mockResolvedValueOnce({ ok: true, data: { bills: [voided()] } });
    mock.send.mockResolvedValue({ ok: false, status: 409, code: "COUNTER_BILL_VOIDED" });
    render(); await settle();
    tap("Void"); choose("Wrong item billed"); tap("Void bill"); await settle();
    expect(sheetOpen()).toBe(false);
    expect(mock.list).toHaveBeenCalledTimes(2);
    expect(texts()).toEqual(expect.arrayContaining(["This bill is already voided.", "Voided · Billed twice"]));
  });
});
