import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ hooks: [] as unknown[], cursor: 0, started: false, api: { shopDiscount: vi.fn(), saveShopDiscount: vi.fn() } }));
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
vi.mock("expo-router", () => ({ Link: "Link" }));
vi.mock("@ygo/mobile", () => ({ Text: "Text", Button: "Button" }));
vi.mock("react-native", () => ({ ActivityIndicator: "Spinner", Pressable: "Pressable", ScrollView: "ScrollView", Switch: "Switch", TextInput: "TextInput", View: "View" }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("../src/api", () => ({ api: mock.api }));
vi.mock("../src/lib/back-path", () => ({ backPath: () => "/" }));
import ShopDiscountScreen from "../src/app/shop-discount";
import { strings } from "../src/strings";

type El = { type: unknown; props: Record<string, unknown> };
function elements(node: unknown): El[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as El;
  if (typeof element.type === "function") return elements((element.type as (props: unknown) => unknown)(element.props));
  return [element, ...elements(element.props.children)];
}
const draw = () => { mock.cursor = 0; return elements(ShopDiscountScreen()); };
const texts = (nodes: El[]) => nodes.flatMap(({ props: { children } }) => typeof children === "string" ? [children] : Array.isArray(children) && children.every((c) => typeof c === "string") ? [children.join("")] : []);
const input = (nodes: El[], label: string) => nodes.find((n) => n.type === "TextInput" && n.props.accessibilityLabel === label);
const save = async (nodes: El[]) => { (nodes.find((n) => n.type === "Button" && n.props.label === strings.shopDiscount.save)?.props.onPress as () => void)(); await settle(); };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const words = strings.shopDiscount;
const rule = { id: "00000000-0000-4000-8000-000000000001", version: 2, form: "percentage", percentage: "18.0000", cap: null, amount: null, minimumOrder: null, status: "paused" };

async function open(data: object) {
  mock.api.shopDiscount.mockResolvedValue({ ok: true, data });
  draw(); await settle();
  return draw();
}
beforeEach(() => { vi.clearAllMocks(); mock.hooks = []; mock.started = false; });

describe("S34 Shop discount (#63)", () => {
  it("starts empty with the maximum shown, and sends a valid rule", async () => {
    mock.api.saveShopDiscount.mockResolvedValue({ ok: true, data: { rule: { ...rule, percentage: "10.0000", status: "active" }, maximumPercentage: "20.0000" } });
    const shown = await open({ rule: null, maximumPercentage: "20" });
    expect(texts(shown)).toEqual(expect.arrayContaining([words.maximum("20")]));
    (input(shown, words.percentage)?.props.onChangeText as (text: string) => void)("10");
    await save(draw());
    expect(mock.api.saveShopDiscount).toHaveBeenCalledWith({ form: "percentage", percentage: "10", cap: null, active: true });
    expect(texts(draw())).toContain(words.saved);
  });

  it("says a rule is paused by a lower maximum, leaves its percentage unchanged and shows it off", async () => {
    const shown = await open({ rule, maximumPercentage: "15" });
    expect(texts(shown)).toContain(words.paused("15"));
    expect(input(shown, words.percentage)?.props.value).toBe("18");
    expect(shown.find((n) => n.type === "Switch")?.props.value).toBe(false);
  });

  it("shows the server's refusal above the maximum and keeps what was typed", async () => {
    mock.api.saveShopDiscount.mockResolvedValue({ ok: false, status: 400, code: "DISCOUNT_ABOVE_MAXIMUM", maximumPercentage: "20.0000" });
    const shown = await open({ rule: null, maximumPercentage: "20" });
    (input(shown, words.percentage)?.props.onChangeText as (text: string) => void)("25");
    await save(draw());
    const after = draw();
    expect(texts(after)).toContain(words.above("20"));
    expect(input(after, words.percentage)?.props.value).toBe("25");
  });

  it("does not send an empty form", async () => {
    await save(await open({ rule: null, maximumPercentage: "20" }));
    expect(mock.api.saveShopDiscount).not.toHaveBeenCalled();
    expect(texts(draw())).toContain(words.invalid);
  });
});
