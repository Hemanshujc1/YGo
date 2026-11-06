import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ role: "owner" as "owner" | "staff" | null, verify: vi.fn(() => Promise.resolve(null)), hooks: [] as unknown[], cursor: 0 }));
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
vi.mock("expo-router", () => ({ Link: "Link", useFocusEffect: () => undefined }));
vi.mock("@ygo/mobile", () => ({ Button: "Button", Text: "Text", ThemePicker: "ThemePicker" }));
vi.mock("react-native", () => ({ ActivityIndicator: "Spinner", Pressable: "Pressable", RefreshControl: "RefreshControl", ScrollView: "ScrollView", View: "View" }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("../src/api", () => ({ api: {}, session: { get: () => ({ account: { id: "account-1" } }) }, access: { subscribe: () => () => undefined, get: () => ({}), role: () => mock.role, verify: mock.verify } }));
vi.mock("../src/components/application-form", () => ({ ApplicationForm: "ApplicationForm" }));
vi.mock("../src/components/application-status", () => ({ ApplicationStatus: "ApplicationStatus" }));
vi.mock("../src/components/open-switch", () => ({ OpenSwitch: "OpenSwitch" }));
vi.mock("../src/components/sign-out", () => ({ SignOut: "SignOut" }));
vi.mock("../src/components/sync-status", () => ({ SyncStatus: "SyncStatus" }));
vi.mock("../src/components/alert-panel", () => ({ AlertPanel: "AlertPanel" }));
vi.mock("../src/lib/inbox", () => ({ inbox: {} }));
vi.mock("@ygo/mobile/notification-parts", () => ({ NotificationsBell: "NotificationsBell" }));
import Home from "../src/app/index";

function elements(node: unknown): Array<{ type: unknown; props: Record<string, unknown> }> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as { type: unknown; props: Record<string, unknown> };
  if (typeof element.type === "function") return elements((element.type as (props: unknown) => unknown)(element.props));
  return [element, ...elements(element.props.children)];
}
const rendered = (state: string) => {
  mock.cursor = 0; mock.hooks = [];
  Home(); // the first render registers the load state
  mock.hooks[0] = { kind: "loaded", application: { state }, liveCheck: null, staffShop: null };
  mock.cursor = 0;
  return elements(Home());
};
const links = (state = "live") => rendered(state).filter((node) => node.type === "Link").map((node) => node.props.href);

describe("Home's Void a bill button (#494)", () => {
  beforeEach(() => { mock.role = "owner"; mock.verify.mockClear(); });

  it("shows it to the Owner of a Live or Suspended shop, next to New bill", () => {
    expect(links("live")).toEqual(expect.arrayContaining(["/bill", "/void-bill"]));
    expect(links("suspended")).toContain("/void-bill");
  });

  it("hides it from Staff and when the phone knows no role, while New bill stays", () => {
    for (const role of ["staff", null] as const) {
      mock.role = role;
      expect(links("live")).toContain("/bill");
      expect(links("live")).not.toContain("/void-bill");
    }
  });

  it("asks the server for the role once when the phone doesn't know it yet, and not when it does", () => {
    links("live");
    expect(mock.verify).not.toHaveBeenCalled();
    mock.role = null;
    links("live");
    expect(mock.verify).toHaveBeenCalled();
    mock.verify.mockClear();
    links("approved");
    expect(mock.verify).not.toHaveBeenCalled();
  });

  it("never shows it before the shop is Live or Suspended", () => {
    expect(links("approved")).not.toContain("/void-bill");
  });
});

describe("Home's bell and S03 (#507)", () => {
  const shown = (state: string) => rendered(state).map((node) => node.type).filter((type) => type === "NotificationsBell" || type === "AlertPanel");

  it("shows both on a Live or Suspended shop, where orders arrive", () => {
    expect(shown("live")).toEqual(["NotificationsBell", "AlertPanel"]);
    expect(shown("suspended")).toEqual(["NotificationsBell", "AlertPanel"]);
  });

  it("shows neither before the shop is Live", () => {
    expect(shown("approved")).toEqual([]);
    expect(shown("submitted")).toEqual([]);
  });
});
