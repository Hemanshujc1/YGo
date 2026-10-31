import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessView } from "../src/lib/offline-access";

const mock = vi.hoisted(() => ({ view: {} as AccessView, path: "/", cursor: 0, hooks: [] as unknown[], effects: [] as (() => void)[],
  cleanups: [] as (() => void)[], foreground: (() => {}) as (state: string) => void, verify: vi.fn(), cleanup: vi.fn(), expire: vi.fn(), allowed: vi.fn(), start: vi.fn(), stop: vi.fn() }));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const index = mock.cursor++; if (!(index in mock.hooks)) mock.hooks[index] = initial;
    return [mock.hooks[index], (value: unknown) => { mock.hooks[index] = value; }];
  },
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
  useEffect: (effect: () => unknown, deps: unknown[]) => {
    const index = mock.cursor++, before = mock.hooks[index] as unknown[] | undefined;
    if (!before || deps.some((dep, i) => dep !== before[i])) {
      mock.hooks[index] = deps;
      mock.effects.push(() => { const cleanup = effect(); if (typeof cleanup === "function") mock.cleanups.push(cleanup as () => void); });
    }
  },
}));
vi.mock("@ygo/mobile", () => ({ Button: "Button", SupportEmail: "SupportEmail", Text: "Text", useSession: () => ({ account: { id: "account" } }) }));
vi.mock("expo-router", () => ({ Link: "Link", usePathname: () => mock.path }));
vi.mock("react-native", () => ({ ScrollView: "ScrollView", AppState: { addEventListener: (_event: string, callback: (state: string) => void) => {
  mock.foreground = callback; return { remove: vi.fn() };
} } }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("../src/components/sign-out", () => ({ SignOut: "SignOut" }));
vi.mock("../src/lib/stock-sync", () => ({ stockSync: { start: mock.start, stop: mock.stop } }));
vi.mock("../src/api", () => ({ supportEmail: "help@example.com", session: { get: () => ({ account: { id: "account" } }) }, access: {
  get: () => mock.view, subscribe: vi.fn(), verify: mock.verify, cleanup: mock.cleanup, expire: mock.expire, allowed: mock.allowed,
} }));
import { StockAccess } from "../src/components/stock-access";
function render() { mock.cursor = 0; const tree = StockAccess({ children: "protected screen" }); for (const effect of mock.effects.splice(0)) effect(); return tree; }
function elements(node: unknown): { type: unknown; props: Record<string, unknown> }[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as { type: unknown; props: Record<string, unknown> };
  return [element, ...elements(element.props.children)];
}
async function ready() { render(); for (let i = 0; i < 8; i++) await Promise.resolve(); return render(); }

describe("offline Stock entry boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks(); vi.useFakeTimers(); mock.hooks = []; mock.effects = []; mock.cleanups = []; mock.path = "/";
    mock.view = { mode: "offline", accountId: "account", shopId: "shop", expiresAt: Date.now() + 1000 };
    mock.verify.mockResolvedValue(undefined); mock.cleanup.mockResolvedValue(undefined); mock.allowed.mockReturnValue(true);
  });
  afterEach(() => { for (const cleanup of mock.cleanups) cleanup(); vi.useRealTimers(); });
  it("offers saved Stock, retry and guarded sign-out while blocking online-only routes", async () => {
    const tree = await ready(); expect(tree).not.toBe("protected screen");
    expect(elements(tree).find((node) => node.props.href === "/stock")).toBeDefined();
    expect(elements(tree).find((node) => node.type === "SignOut")).toBeDefined();
    mock.path = "/stock"; expect(render()).toBe("protected screen");
    mock.path = "/orders"; expect(render()).not.toBe("protected screen");
    const retry = elements(render()).find((node) => node.props.label === "Retry connection");
    (retry?.props.onPress as () => void)(); expect(mock.verify).toHaveBeenCalledTimes(2);
    // iOS "inactive" is not leaving; only coming back from the background checks and syncs again (#395).
    mock.foreground("inactive"); mock.foreground("active"); expect(mock.verify).toHaveBeenCalledTimes(2); expect(mock.stop).not.toHaveBeenCalled();
    mock.foreground("background"); expect(mock.stop).toHaveBeenCalledOnce();
    mock.start.mockClear(); mock.foreground("active"); expect(mock.verify).toHaveBeenCalledTimes(3);
    await Promise.resolve(); await Promise.resolve(); expect(mock.start).toHaveBeenCalledOnce();
  });
  it("keeps accessible cached Stock visible while background verification is pending", () => {
    mock.path = "/stock";
    mock.verify.mockReturnValue(new Promise(() => {}));
    expect(render()).toBe("protected screen");
  });
  it("hides Stock at the deadline and checks a foreground clock rollback without syncing", async () => {
    mock.path = "/stock"; await ready();
    mock.expire.mockImplementation(() => { mock.view = { ...mock.view, mode: "expired" }; });
    vi.advanceTimersByTime(1000); expect(mock.expire).toHaveBeenCalled();
    expect(render()).not.toBe("protected screen"); expect(mock.verify).toHaveBeenCalledTimes(1);
  });
  it("offers cleanup/support with blocked sign-out, then avoids recreating storage after erasure", async () => {
    mock.view = { mode: "erasing", accountId: "account", shopId: "shop" };
    let tree: unknown = await ready(); expect(elements(tree).find((node) => node.type === "SignOut")?.props.disabled).toBe(true);
    (elements(tree).find((node) => node.props.label === "Retry cleanup")?.props.onPress as () => void)();
    expect(mock.cleanup).toHaveBeenCalled(); expect(elements(tree).some((node) => node.props.address === "help@example.com")).toBe(true);
    mock.view = { mode: "ended", accountId: "account" }; tree = render();
    expect(elements(tree).find((node) => node.type === "SignOut")).toBeDefined();
  });
  it("keeps online tools hidden when encrypted access storage cannot be checked", async () => {
    mock.view = { mode: "online", accountId: "account", shopId: "shop" };
    mock.verify.mockRejectedValue(new Error("key locked"));
    expect(await ready()).not.toBe("protected screen");
  });
});
