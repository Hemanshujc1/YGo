import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  params: {} as Record<string, string>, back: vi.fn(), hooks: [] as unknown[], cursor: 0, started: false, ids: 0,
  api: { productRequests: vi.fn(), createProductRequest: vi.fn() },
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
  useEffect: (effect: () => void) => { if (!mock.started) { mock.started = true; effect(); } },
}));
vi.mock("expo-router", () => ({ Link: "Link", useLocalSearchParams: () => mock.params, useRouter: () => ({ back: mock.back }) }));
vi.mock("expo-crypto", () => ({ randomUUID: () => `00000000-0000-4000-8000-${String(++mock.ids).padStart(12, "0")}` }));
vi.mock("@ygo/mobile", () => ({ Text: "Text", Button: "Button", StatusChip: "StatusChip" }));
vi.mock("react-native", () => ({ ActivityIndicator: "Spinner", Pressable: "Pressable", ScrollView: "ScrollView", TextInput: "TextInput", View: "View" }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("../src/api", () => ({ api: mock.api }));
vi.mock("../src/lib/back-path", () => ({ backPath: () => "/" }));
import ProductRequestsScreen from "../src/app/product-requests";
import { strings } from "../src/strings";

type El = { type: unknown; props: Record<string, unknown> };
function elements(node: unknown): El[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as El;
  if (typeof element.type === "function") return elements((element.type as (props: unknown) => unknown)(element.props));
  return [element, ...elements(element.props.children)];
}
const draw = () => { mock.cursor = 0; return elements(ProductRequestsScreen()); };
const texts = (nodes: El[]) => nodes.flatMap(({ props: { children } }) => typeof children === "string" ? [children] : Array.isArray(children) && children.every((c) => typeof c === "string") ? [children.join("")] : []);
const button = (nodes: El[], label: string) => nodes.find((n) => n.type === "Button" && n.props.label === label);
const input = (nodes: El[], label: string) => nodes.find((n) => n.type === "TextInput" && n.props.accessibilityLabel === label);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const words = strings.productRequests;

const category = { id: "00000000-0000-4000-8000-0000000000c1", name: "Staples", parentName: null };
const listed = { id: "00000000-0000-4000-8000-0000000000a1", name: "Jaggery", brand: null, baseUnit: "kg", packQuantity: "0.500", counterPrice: "40.00", mrp: "45.00", status: "rejected", reason: "Photo unclear", createdAt: "2030-01-01T00:00:00.000Z" };

async function open() { draw(); await settle(); return draw(); }
/** Fills the form like the Owner would, one field at a time, redrawing between so each change lands. */
function fill(values: Record<string, string>) {
  for (const [label, value] of Object.entries(values)) (input(draw(), label)?.props.onChangeText as (text: string) => void)(value);
  const choose = (label: string) => (draw().find((n) => n.type === "Pressable" && (n.props.children as El)?.props?.children === label)?.props.onPress as () => void)();
  choose("Staples");
  return choose;
}
const valid = { [words.name]: "Fresh jaggery", [words.packQuantity]: "0.5", [words.counterPrice]: "40", [words.mrp]: "45" };

beforeEach(() => {
  vi.clearAllMocks();
  mock.hooks = []; mock.started = false; mock.ids = 0; mock.params = {};
  mock.api.productRequests.mockResolvedValue({ ok: true, data: { requests: [listed], categories: [category] } });
});

describe("S38 Product request (#62, CAT-3)", () => {
  it("lists the shop's requests with how Admin answered, and the categories to choose from", async () => {
    const shown = await open();
    expect(texts(shown)).toEqual(expect.arrayContaining([words.title, "Jaggery", "0.5 kg · ₹40 · MRP ₹45", words.reason("Photo unclear"), "Staples"]));
    expect(shown.find((n) => n.type === "StatusChip")?.props).toMatchObject({ word: words.status.rejected, treatment: "ended" });
  });

  it("marks what is wrong and sends nothing", async () => {
    await open();
    (button(draw(), words.request)?.props.onPress as () => void)();
    await settle();
    const shown = draw();
    expect(mock.api.createProductRequest).not.toHaveBeenCalled();
    expect(texts(shown)).toEqual(expect.arrayContaining([words.invalid, words.fields.name, words.fields.categoryId, words.fields.packQuantity]));
  });

  it("sends the request, tells the Owner they can sell it now, clears the form and reads the list again", async () => {
    mock.api.createProductRequest.mockResolvedValue({ ok: true, data: { ...listed, status: "pending", reason: null } });
    await open();
    fill(valid);
    (button(draw(), words.request)?.props.onPress as () => void)();
    await settle();
    expect(mock.api.createProductRequest).toHaveBeenCalledWith({
      clientId: "00000000-0000-4000-8000-000000000001", name: "Fresh jaggery", categoryId: category.id, baseUnit: "kg", packQuantity: "0.5", counterPrice: "40", mrp: "45",
    });
    expect(mock.api.productRequests).toHaveBeenCalledTimes(2);
    const shown = draw();
    expect(texts(shown)).toContain(words.sent);
    expect((input(shown, words.name)?.props.value)).toBe("");
  });

  it("refuses a price above the MRP before asking the server", async () => {
    await open();
    fill({ ...valid, [words.counterPrice]: "46" });
    (button(draw(), words.request)?.props.onPress as () => void)();
    await settle();
    expect(mock.api.createProductRequest).not.toHaveBeenCalled();
    expect(texts(draw())).toContain(words.fields.counterPrice);
  });

  it("shows the server's refusal in the app's own words", async () => {
    mock.api.createProductRequest.mockResolvedValue({ ok: false, status: 409, code: "PRODUCT_NAME_IN_USE" });
    await open();
    fill(valid);
    (button(draw(), words.request)?.props.onPress as () => void)();
    await settle();
    expect(texts(draw())).toContain(strings.errors.PRODUCT_NAME_IN_USE);
  });

  it("turns the button off when the phone can't reach the server, says why, and turns it on again once it can", async () => {
    mock.api.productRequests.mockRejectedValue(new Error("network"));
    draw(); await settle();
    const offline = draw();
    expect(texts(offline)).toEqual(expect.arrayContaining([words.loadFailed, words.offline]));
    expect(button(offline, words.request)?.props.disabled).toBe(true);
    mock.api.productRequests.mockResolvedValue({ ok: true, data: { requests: [], categories: [category] } });
    (button(offline, words.retry)?.props.onPress as () => void)();
    await settle();
    expect(button(draw(), words.request)?.props.disabled).toBe(false);
    expect(mock.api.createProductRequest).not.toHaveBeenCalled();
  });

  it("goes offline when a send is lost, keeps the form, and the retry after reconnecting is the same request", async () => {
    await open();
    fill(valid);
    mock.api.createProductRequest.mockRejectedValueOnce(new Error("network")).mockResolvedValue({ ok: true, data: { ...listed, status: "pending", reason: null } });
    (button(draw(), words.request)?.props.onPress as () => void)();
    await settle();
    const lost = draw();
    expect(texts(lost)).toContain(words.offline);
    expect(button(lost, words.request)?.props.disabled).toBe(true);
    expect(input(lost, words.name)?.props.value).toBe("Fresh jaggery");
    (button(lost, words.retry)?.props.onPress as () => void)();
    await settle();
    (button(draw(), words.request)?.props.onPress as () => void)();
    await settle();
    const ids = mock.api.createProductRequest.mock.calls.map(([body]) => (body as { clientId: string }).clientId);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
  });

  it("opens from a counter bill's typed line with its name and price filled in, the MRP blank, and Back returning to the bill (#565)", async () => {
    mock.params = { name: "Fresh jaggery", price: "40.50" };
    const shown = await open();
    expect(input(shown, words.name)?.props.value).toBe("Fresh jaggery");
    expect(input(shown, words.counterPrice)?.props.value).toBe("40.5");
    expect(input(shown, words.mrp)?.props.value).toBe("");
    // The MRP is still required: the form refuses to send until the shop gives it.
    fill({ [words.packQuantity]: "0.5" });
    (button(draw(), words.request)?.props.onPress as () => void)();
    await settle();
    expect(mock.api.createProductRequest).not.toHaveBeenCalled();
    expect(texts(draw())).toContain(words.fields.mrp);
    const back = draw().find((n) => n.type === "Pressable" && texts([n]).length === 0 && texts(elements(n.props.children)).includes(`‹ ${words.backToBill}`));
    (back?.props.onPress as () => void)();
    expect(mock.back).toHaveBeenCalled();
  });

  it("sends that prefilled request once the shop adds the MRP and the rest", async () => {
    mock.params = { name: "Fresh jaggery", price: "40" };
    mock.api.createProductRequest.mockResolvedValue({ ok: true, data: { ...listed, status: "pending", reason: null } });
    await open();
    fill({ [words.packQuantity]: "0.5", [words.mrp]: "45" });
    (button(draw(), words.request)?.props.onPress as () => void)();
    await settle();
    expect(mock.api.createProductRequest).toHaveBeenCalledWith(expect.objectContaining({ name: "Fresh jaggery", counterPrice: "40", mrp: "45" }));
  });

  it("keeps the usual Back when it is not opened from a bill", async () => {
    const shown = await open();
    expect(shown.some((n) => n.type === "Link")).toBe(true);
  });
});
