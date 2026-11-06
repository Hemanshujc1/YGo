import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ pathname: "/orders", answersOrders: true, role: "owner" as "owner" | "staff" | null, canDeliver: false, replace: vi.fn() }));
vi.mock("react", () => ({ useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get() }));
vi.mock("expo-router", () => ({ router: { replace: mock.replace }, usePathname: () => mock.pathname }));
vi.mock("@ygo/mobile", () => ({ TabBar: "TabBar" }));
vi.mock("../src/api", () => ({ access: { subscribe: () => () => undefined, get: () => ({}), answersOrders: () => mock.answersOrders, role: () => mock.role, canDeliver: () => mock.canDeliver } }));
vi.mock("../src/components/icons", () => ({ ClipboardList: "i", Ellipsis: "i", Package: "i", Receipt: "i", Truck: "i" }));
import { ShopTabs } from "../src/components/shop-tabs";

type Tab = { key: string; label: string };
const bar = () => ShopTabs() as null | { props: { tabs: Tab[]; active: string; onSelect: (key: string) => void } };

describe("the Shopkeeper tab bar (#550)", () => {
  beforeEach(() => { mock.pathname = "/orders"; mock.answersOrders = true; mock.role = "owner"; mock.canDeliver = false; mock.replace.mockClear(); });

  it("draws the Owner's five tabs on a tab route, with the current one active", () => {
    mock.pathname = "/stock";
    expect(bar()?.props.tabs.map((tab) => tab.label)).toEqual(["Orders", "Bill", "Stock", "Deliveries", "More"]);
    expect(bar()?.props.active).toBe("stock");
  });

  it("leaves Deliveries out for Staff who can't deliver, and puts it back for Staff who can", () => {
    mock.role = "staff";
    expect(bar()?.props.tabs.map((tab) => tab.key)).not.toContain("deliveries");
    mock.canDeliver = true;
    expect(bar()?.props.tabs.map((tab) => tab.key)).toContain("deliveries");
  });

  it("draws nothing before the shop answers orders, and nothing on a drill-down screen", () => {
    mock.answersOrders = false;
    expect(bar()).toBeNull();
    mock.answersOrders = true;
    for (const path of ["/", "/orders/7", "/staff", "/void-bill"]) { mock.pathname = path; expect(bar()).toBeNull(); }
  });

  it("opens another tab by replacing the route, and does nothing on the tab already open", () => {
    bar()?.props.onSelect("more");
    expect(mock.replace).toHaveBeenCalledWith("/more");
    mock.replace.mockClear();
    bar()?.props.onSelect("orders");
    expect(mock.replace).not.toHaveBeenCalled();
  });
});
