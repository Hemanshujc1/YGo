import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ view: {} as Record<string, unknown> }));
vi.mock("react", () => ({ useState: (initial: unknown) => [typeof initial === "function" ? (initial as () => unknown)() : initial, () => undefined], useSyncExternalStore: () => mock.view }));
vi.mock("expo-router", () => ({ Link: "Link" }));
vi.mock("@ygo/mobile", () => ({ Button: "Button", Text: "Text", useInFront: () => undefined }));
vi.mock("react-native", () => ({ ActivityIndicator: "Spinner", Pressable: "Pressable", RefreshControl: "RefreshControl", ScrollView: "ScrollView", View: "View" }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("../src/api", () => ({ api: {} }));
vi.mock("../src/components/order-row", () => ({ OrderRow: "OrderRow" }));
vi.mock("../src/lib/shop-orders", () => ({ createShopOrders: () => ({ subscribe: () => () => undefined, get: () => mock.view, refresh: vi.fn(), retry: vi.fn() }) }));
import DeliveriesScreen from "../src/app/deliveries";
import { strings } from "../src/strings";

type El = { type: unknown; props: Record<string, unknown> };
function elements(node: unknown): El[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as El;
  return [element, ...elements(element.props.children)];
}
const text = () => elements(DeliveriesScreen()).flatMap(({ props: { children } }) => (typeof children === "string" ? [children] : []));
const list = (canDeliver: boolean) => ({ status: "ready", refreshing: false, message: null, orders: { canDeliver, myDeliveries: [] } });

describe("My deliveries reached directly (DLV-1, #536)", () => {
  beforeEach(() => { mock.view = {}; });

  it("tells Staff without can deliver they may not, and lists nothing", () => {
    mock.view = list(false);
    expect(text()).toContain(strings.errors.FORBIDDEN);
    expect(elements(DeliveriesScreen()).some((node) => node.type === "OrderRow")).toBe(false);
  });

  it("shows an empty list to someone who can deliver", () => {
    mock.view = list(true);
    expect(text()).toContain(strings.orders.noDeliveries);
    expect(text()).not.toContain(strings.errors.FORBIDDEN);
  });
});
