import { describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ hooks: [] as unknown[], cursor: 0 }));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const index = mock.cursor++;
    if (!(index in mock.hooks)) mock.hooks[index] = initial;
    return [mock.hooks[index], () => undefined];
  },
  useRef: (initial: unknown) => { const index = mock.cursor++; if (!(index in mock.hooks)) mock.hooks[index] = { current: initial }; return mock.hooks[index]; },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void) => effect(),
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
}));
vi.mock("expo-router", () => ({ Link: "Link", Redirect: "Redirect", useFocusEffect: () => undefined }));
vi.mock("@ygo/mobile", () => ({ Button: "Button", Text: "Text", ThemePicker: "ThemePicker" }));
vi.mock("react-native", () => ({ ActivityIndicator: "Spinner", Pressable: "Pressable", RefreshControl: "RefreshControl", ScrollView: "ScrollView", View: "View" }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("../src/api", () => ({ api: {}, session: {} }));
vi.mock("../src/components/application-form", () => ({ ApplicationForm: "ApplicationForm" }));
vi.mock("../src/components/application-status", () => ({ ApplicationStatus: "ApplicationStatus" }));
vi.mock("../src/components/sign-out", () => ({ SignOut: "SignOut" }));
vi.mock("../src/components/sync-status", () => ({ SyncStatus: "SyncStatus" }));
import Home from "../src/app/index";

function elements(node: unknown): Array<{ type: unknown; props: Record<string, unknown> }> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as { type: unknown; props: Record<string, unknown> };
  if (typeof element.type === "function") return elements((element.type as (props: unknown) => unknown)(element.props));
  return [element, ...elements(element.props.children)];
}
const load = (state: Record<string, unknown>) => {
  mock.cursor = 0; mock.hooks = [];
  Home(); // the first render registers the load state
  mock.hooks[0] = { kind: "loaded", application: null, liveCheck: null, staffShop: null, ...state };
  mock.cursor = 0;
  return elements(Home());
};
const forShop = (state: string) => load({ application: { state } });
const hrefs = (nodes: ReturnType<typeof elements>) => nodes.filter((node) => node.type === "Link").map((node) => node.props.href);
const redirects = (nodes: ReturnType<typeof elements>) => nodes.filter((node) => node.type === "Redirect").map((node) => node.props.href);

describe("Home once the shop answers orders (#550)", () => {
  it("sends the Owner of a Live or Suspended shop to the Orders tab, and shows nothing of its own", () => {
    for (const state of ["live", "suspended"]) {
      expect(redirects(forShop(state))).toEqual(["/orders"]);
      expect(hrefs(forShop(state))).toEqual([]);
    }
  });

  it("sends Staff of a Live or Suspended shop there too", () => {
    for (const state of ["live", "suspended"]) expect(redirects(load({ staffShop: { shopName: "S", state } }))).toEqual(["/orders"]);
  });

  it("keeps the orders buttons, the bell, S03, the open switch and Void a bill off Home in every state", () => {
    for (const state of ["draft", "submitted", "approved", "live", "suspended"]) {
      const nodes = forShop(state);
      expect(hrefs(nodes)).not.toEqual(expect.arrayContaining(["/orders"]));
      for (const href of ["/bill", "/void-bill", "/deliveries"]) expect(hrefs(nodes)).not.toContain(href);
      expect(nodes.map((node) => node.type)).not.toEqual(expect.arrayContaining(["NotificationsBell"]));
    }
  });
});

describe("Home's Staff button (#535)", () => {
  it("sits in the Owner's setup list of an Approved shop, once, after Hours", () => {
    const list = hrefs(forShop("approved"));
    expect(list.filter((href) => href === "/staff")).toHaveLength(1);
    expect(list.indexOf("/staff")).toBe(list.indexOf("/hours") + 1);
  });

  it("is hidden before approval", () => {
    expect(hrefs(forShop("submitted"))).not.toContain("/staff");
  });

  it("is hidden from Staff of a shop that is not open yet", () => {
    expect(hrefs(load({ staffShop: { shopName: "S", state: "approved" } }))).toEqual([]);
  });
});

describe("Home's Start screen (S21, #536)", () => {
  it("offers a way to join a shop with a code", () => {
    expect(hrefs(load({}))).toContain("/join-shop");
  });
});
