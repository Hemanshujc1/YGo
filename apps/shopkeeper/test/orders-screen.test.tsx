import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ role: "owner" as "owner" | "staff" | null, state: "live" as string | undefined }));
vi.mock("react", () => ({ useState: (initial: unknown) => [typeof initial === "function" ? (initial as () => unknown)() : initial, () => undefined], useSyncExternalStore: () => ({ status: "ready", refreshing: false, message: null, orders: { canDeliver: true, new: [], accepted: [], doneToday: [], myDeliveries: [] } }) }));
vi.mock("@ygo/mobile", () => ({ Button: "Button", Text: "Text", useInFront: () => undefined }));
vi.mock("@ygo/mobile/notification-parts", () => ({ NotificationsBell: "NotificationsBell" }));
vi.mock("react-native", () => ({ ActivityIndicator: "Spinner", RefreshControl: "RefreshControl", ScrollView: "ScrollView", View: "View" }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("../src/api", () => ({ api: {}, session: { get: () => ({ account: { id: "account-1" } }) }, access: { answer: () => (mock.state ? { state: mock.state } : null) } }));
vi.mock("../src/components/alert-panel", () => ({ AlertPanel: "AlertPanel" }));
vi.mock("../src/components/open-switch", () => ({ OpenSwitch: "OpenSwitch" }));
vi.mock("../src/components/order-row", () => ({ OrderRow: "OrderRow" }));
vi.mock("../src/lib/account-role", () => ({ useAccountRole: () => mock.role }));
vi.mock("../src/lib/inbox", () => ({ inbox: {} }));
vi.mock("../src/lib/shop-orders", () => ({ createShopOrders: () => ({ subscribe: () => () => undefined, get: () => ({}), refresh: vi.fn(), retry: vi.fn() }) }));
import OrdersScreen from "../src/app/orders/index";
import { strings } from "../src/strings";

type El = { type: unknown; props: Record<string, unknown> };
function elements(node: unknown): El[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as El;
  return [element, ...elements(element.props.children)];
}
const shown = () => elements(OrdersScreen());
const types = () => shown().map((node) => node.type);
const texts = () => shown().flatMap(({ props: { children } }) => (typeof children === "string" ? [children] : []));

describe("S04 Orders, the first tab (#550)", () => {
  beforeEach(() => { mock.role = "owner"; mock.state = "live"; });

  it("carries the bell and S03 that Home used to, with no Back link and no My deliveries button", () => {
    expect(types()).toEqual(expect.arrayContaining(["NotificationsBell", "AlertPanel"]));
    expect(types()).not.toContain("Link");
    expect(texts()).not.toContain(strings.orders.back);
    expect(texts()).not.toContain(strings.orders.groups.myDeliveries);
  });

  it("gives the Owner of a Live shop the open switch, and nobody else", () => {
    expect(types()).toContain("OpenSwitch");
    mock.role = "staff";
    expect(types()).not.toContain("OpenSwitch");
    mock.role = "owner"; mock.state = "suspended";
    expect(types()).not.toContain("OpenSwitch");
  });

  it("tells a Suspended shop it is suspended", () => {
    mock.state = "suspended";
    expect(texts()).toContain(strings.stock.suspended);
    mock.state = "live";
    expect(texts()).not.toContain(strings.stock.suspended);
  });
});
