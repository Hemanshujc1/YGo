import type { OwnerStatementsResponse, Statement } from "@ygo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  hooks: [] as unknown[], cursor: 0, started: false, params: { id: "" } as Record<string, string>,
  api: { myStatements: vi.fn(), myStatement: vi.fn() }, share: vi.fn(),
}));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const index = mock.cursor++;
    if (!(index in mock.hooks)) mock.hooks[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [mock.hooks[index], (value: unknown) => { mock.hooks[index] = typeof value === "function" ? (value as (old: unknown) => unknown)(mock.hooks[index]) : value; }];
  },
  useRef: (initial: unknown) => {
    const index = mock.cursor++;
    if (!(index in mock.hooks)) mock.hooks[index] = { current: initial };
    return mock.hooks[index];
  },
  useCallback: (fn: unknown) => fn,
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
}));
vi.mock("expo-router", () => ({ Link: "Link", useLocalSearchParams: () => mock.params }));
vi.mock("@ygo/mobile", () => ({ Text: "Text", Button: "Button", useInFront: ({ start }: { start: () => void }) => { if (!mock.started) { mock.started = true; start(); } } }));
vi.mock("react-native", () => ({ ActivityIndicator: "Spinner", FlatList: "FlatList", Pressable: "Pressable", RefreshControl: "RefreshControl", ScrollView: "ScrollView", View: "View" }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("../src/api", () => ({ api: mock.api }));
vi.mock("../src/lib/back-path", () => ({ backPath: () => "/" }));
vi.mock("../src/lib/share-statement", () => ({ shareStatement: mock.share }));
import Detail from "../src/app/money/[id]";
import Money from "../src/app/money/index";
import { strings } from "../src/strings";

type El = { type: unknown; props: Record<string, unknown> };
function elements(node: unknown): El[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as El;
  if (typeof element.type === "function") return elements((element.type as (props: unknown) => unknown)(element.props));
  // A list draws its header, its empty note, its footer and each row from props rather than children.
  if (element.type === "FlatList") {
    const { data, renderItem, ListHeaderComponent, ListEmptyComponent, ListFooterComponent } = element.props as { data: unknown[]; renderItem: (info: { item: unknown }) => unknown; ListHeaderComponent: unknown; ListEmptyComponent: unknown; ListFooterComponent: unknown };
    return [element, ...elements(ListHeaderComponent), ...(data.length ? data.flatMap((item) => elements(renderItem({ item }))) : elements(ListEmptyComponent)), ...elements(ListFooterComponent)];
  }
  return [element, ...elements(element.props.children)];
}
const texts = (nodes: El[]) => nodes.flatMap(({ props: { children } }) => typeof children === "string" ? [children]
  : Array.isArray(children) && children.every((c) => typeof c === "string") ? [children.join("")] : []);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const draw = (screen: () => unknown) => { mock.cursor = 0; return elements(screen()); };

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const row = (number: number) => ({ id: id(number), number, shopId: id(900), shopName: "Sai", periodStart: "2026-11-02", periodEnd: "2026-11-08", issuedAt: "2026-11-09T00:30:00.000Z",
  dueOn: "2026-11-16", orderCount: 2, total: "107.50" });
const first: OwnerStatementsResponse = { balance: { onStatements: "215.00", thisWeek: "7.50", total: "222.50" }, statements: [row(3), row(2)], nextBefore: 2 };
const detail: Statement = { ...row(3), shopAddress: "12 MG Road", shopPincode: "411038", lines: [
  { orderId: id(1001), orderNumber: 1001, completedAt: "2026-11-03T06:30:00.000Z", late: false, fulfilment: "delivery", orderTotal: "500.00", commission: "50.00", feeShare: "10.00", bookingFees: "0.00", platformCoupon: "0.00", owed: "60.00" },
  { orderId: id(1002), orderNumber: 1002, completedAt: "2026-10-30T06:30:00.000Z", late: true, fulfilment: "pickup", orderTotal: "300.00", commission: "30.00", feeShare: "0.00", bookingFees: "5.00", platformCoupon: "7.50", owed: "27.50" },
] };

beforeEach(() => {
  vi.clearAllMocks();
  mock.hooks = []; mock.started = false; mock.params = { id: id(3) };
  mock.api.myStatements.mockResolvedValue({ ok: true, data: first });
  mock.api.myStatement.mockResolvedValue({ ok: true, data: detail });
  mock.share.mockResolvedValue(undefined);
});

describe("S15 Money (#630)", () => {
  async function open() { draw(Money); await settle(); return draw(Money); }

  it("shows the balance in its two parts, with the total as their sum", async () => {
    const shown = texts(await open());
    for (const part of [strings.money.onStatements, strings.money.thisWeek, strings.money.total, "₹215", "₹7.50", "₹222.50"]) expect(shown).toContain(part);
  });

  it("lists the statements newest first as links to each one, and loads the next page at the end of the list", async () => {
    const nodes = await open();
    const list = nodes.find((node) => node.type === "FlatList");
    expect(list?.props.data).toEqual(first.statements);
    mock.api.myStatements.mockResolvedValueOnce({ ok: true, data: { ...first, statements: [row(1)], nextBefore: null } });
    (list?.props.onEndReached as () => void)();
    await settle();
    expect(mock.api.myStatements).toHaveBeenLastCalledWith({ before: 2, limit: 20 });
    expect(draw(Money).find((node) => node.type === "FlatList")?.props.data).toHaveLength(3);
  });

  it("says there is no statement yet, and still shows what is owed this week", async () => {
    mock.api.myStatements.mockResolvedValue({ ok: true, data: { balance: { onStatements: "0.00", thisWeek: "7.50", total: "7.50" }, statements: [], nextBefore: null } });
    const shown = texts(await open());
    expect(shown).toContain(strings.money.none);
    expect(shown).toContain("₹7.50");
  });

  it("says so and offers a retry when the first read fails", async () => {
    mock.api.myStatements.mockResolvedValue({ ok: false, status: 500, code: "INTERNAL" });
    const nodes = await open();
    expect(texts(nodes)).toContain(strings.errors.INTERNAL);
    expect(nodes.some((node) => node.type === "Button" && node.props.label === strings.money.retry)).toBe(true);
  });

  it("never shows profit", async () => {
    expect(JSON.stringify(strings.money)).not.toMatch(/profit|margin|earning/i);
  });
});

describe("a statement (#630)", () => {
  async function open() { draw(Detail); await settle(); return draw(Detail); }

  it("shows its week, the due date, each order, the total and that it is not a tax invoice", async () => {
    const shown = texts(await open());
    for (const part of [strings.money.notTaxInvoice, "₹107.50", "Order #1001", "Order #1002", strings.money.late]) expect(shown.join("|")).toContain(part);
  });

  it("shares the statement as a PDF made on the phone", async () => {
    const nodes = await open();
    const share = nodes.find((node) => node.type === "Button" && node.props.label === strings.money.share);
    await (share?.props.onPress as () => Promise<void>)();
    expect(mock.share).toHaveBeenCalledWith(detail);
  });

  it("says when the statement is not found", async () => {
    mock.api.myStatement.mockResolvedValue({ ok: false, status: 404, code: "NOT_FOUND" });
    expect(texts(await open())).toContain(strings.errors.NOT_FOUND);
  });
});
