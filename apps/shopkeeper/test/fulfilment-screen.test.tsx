import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ hooks: [] as unknown[], cursor: 0, started: false, role: "owner" as "owner" | "staff" | null, api: { fulfilmentModes: vi.fn(), setFulfilmentMode: vi.fn() } }));
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
vi.mock("react-native", () => ({ ActivityIndicator: "Spinner", Pressable: "Pressable", ScrollView: "ScrollView", View: "View" }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("../src/api", () => ({ api: mock.api }));
vi.mock("../src/components/toggle", () => ({ Toggle: "Toggle" }));
vi.mock("../src/lib/back-path", () => ({ backPath: () => "/" }));
vi.mock("../src/lib/account-role", () => ({ useAccountRole: () => mock.role }));
import FulfilmentScreen from "../src/app/fulfilment";
import { strings } from "../src/strings";

type El = { type: unknown; props: Record<string, unknown> };
function elements(node: unknown): El[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as El;
  if (typeof element.type === "function") return elements((element.type as (props: unknown) => unknown)(element.props));
  return [element, ...elements(element.props.children)];
}
const draw = () => { mock.cursor = 0; return elements(FulfilmentScreen()); };
const texts = (nodes: El[]) => nodes.flatMap(({ props: { children } }) => typeof children === "string" ? [children] : []);
const toggle = (nodes: El[], mode: "instant" | "scheduled" | "pickup") => nodes.find((n) => n.type === "Toggle" && n.props.label === strings.fulfilment.modes[mode]);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const words = strings.fulfilment;
const modes = (over: Partial<Record<"instant" | "scheduled" | "pickup", object>> = {}) => ({
  modes: (["instant", "scheduled", "pickup"] as const).map((mode) => ({ mode, shopOn: mode !== "pickup", adminForcedOff: false, open: mode !== "pickup", ...over[mode] })),
});

async function open(data = modes()) {
  mock.api.fulfilmentModes.mockResolvedValue({ ok: true, data });
  draw(); await settle();
  return draw();
}
beforeEach(() => { vi.clearAllMocks(); mock.hooks = []; mock.started = false; mock.role = "owner"; });

describe("S38 Order types (#65)", () => {
  it("shows each mode with the Owner's own switch, pickup off to start", async () => {
    const shown = await open();
    expect(toggle(shown, "instant")?.props.on).toBe(true);
    expect(toggle(shown, "scheduled")?.props.on).toBe(true);
    expect(toggle(shown, "pickup")?.props.on).toBe(false);
    expect(texts(shown)).not.toContain(words.forcedOff);
  });

  it("switches pickup on and shows the saved answer", async () => {
    const shown = await open();
    mock.api.setFulfilmentMode.mockResolvedValue({ ok: true, data: modes({ pickup: { shopOn: true, open: true } }) });
    (toggle(shown, "pickup")?.props.onPress as () => void)();
    await settle();
    expect(mock.api.setFulfilmentMode).toHaveBeenCalledWith("pickup", true);
    expect(toggle(draw(), "pickup")?.props.on).toBe(true);
  });

  it("says a pickup rate-card rule is needed and leaves the switch off", async () => {
    const shown = await open();
    mock.api.setFulfilmentMode.mockResolvedValue({ ok: false, status: 409, code: "PICKUP_NOT_CONFIGURED" });
    (toggle(shown, "pickup")?.props.onPress as () => void)();
    await settle();
    const after = draw();
    expect(texts(after)).toContain(strings.errors.PICKUP_NOT_CONFIGURED);
    expect(toggle(after, "pickup")?.props.on).toBe(false);
  });

  it("moves the switch back and says so when a save gets no answer", async () => {
    const shown = await open();
    mock.api.setFulfilmentMode.mockRejectedValue(new Error("offline"));
    (toggle(shown, "instant")?.props.onPress as () => void)();
    await settle();
    const after = draw();
    expect(toggle(after, "instant")?.props.on).toBe(true);
    expect(texts(after)).toContain(words.saveFailed);
  });

  it("shows the move while it saves and sends one change at a time", async () => {
    const shown = await open();
    let finish: (value: unknown) => void = () => undefined;
    mock.api.setFulfilmentMode.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    (toggle(shown, "scheduled")?.props.onPress as () => void)();
    const during = draw();
    expect(toggle(during, "scheduled")?.props).toMatchObject({ on: false, busy: true });
    (toggle(during, "instant")?.props.onPress as () => void)();
    expect(mock.api.setFulfilmentMode).toHaveBeenCalledTimes(1);
    finish({ ok: true, data: modes({ scheduled: { shopOn: false, open: false } }) });
    await settle();
    expect(toggle(draw(), "scheduled")?.props).toMatchObject({ on: false, busy: false });
  });

  it("says Admin forced a mode off and keeps the Owner's own switch where it was", async () => {
    const shown = await open(modes({ instant: { shopOn: true, adminForcedOff: true, open: false } }));
    expect(texts(shown).filter((t) => t === words.forcedOff)).toHaveLength(1);
    expect(toggle(shown, "instant")?.props.on).toBe(true);
  });

  it("lets Staff see the switches but not change them", async () => {
    mock.role = "staff";
    const shown = await open();
    expect(texts(shown)).toContain(words.staffOnly);
    expect(toggle(shown, "pickup")?.props.busy).toBe(true);
  });

  it("offers Try again when the load fails, and loads on the retry", async () => {
    mock.api.fulfilmentModes.mockResolvedValue(null);
    draw(); await settle();
    const failed = draw();
    expect(texts(failed)).toContain(words.loadFailed);
    mock.api.fulfilmentModes.mockResolvedValue({ ok: true, data: modes() });
    (failed.find((n) => n.type === "Button" && n.props.label === words.retry)?.props.onPress as () => void)();
    await settle();
    expect(toggle(draw(), "instant")).toBeDefined();
  });
});
