import { describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ hooks: [] as unknown[], cursor: 0, view: null as unknown }));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const index = mock.cursor++;
    if (!(index in mock.hooks)) mock.hooks[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [mock.hooks[index], () => undefined];
  },
  useRef: (initial: unknown) => {
    const index = mock.cursor++;
    if (!(index in mock.hooks)) mock.hooks[index] = { current: initial };
    return mock.hooks[index];
  },
  useSyncExternalStore: () => mock.view,
  useEffect: () => undefined,
}));
vi.mock("expo-router", () => ({ Link: "Link", router: {}, useLocalSearchParams: () => ({ id: "order-1" }) }));
vi.mock("@ygo/mobile", () => ({ Button: "Button", Confirm: "Confirm", StatusChip: "StatusChip", Text: "Text", useInFront: () => undefined }));
vi.mock("react-native", () => ({
  ActivityIndicator: "Spinner", Image: "Image", Linking: {}, Modal: "Modal", Pressable: "Pressable",
  RefreshControl: "RefreshControl", ScrollView: "ScrollView", TextInput: "TextInput", View: "View",
}));
vi.mock("expo-camera", () => ({ CameraView: "CameraView", useCameraPermissions: () => [null, () => Promise.resolve({ granted: false })] }));
vi.mock("expo-image-manipulator", () => ({ SaveFormat: { JPEG: "jpeg" }, manipulateAsync: () => Promise.resolve({ uri: "" }) }));
vi.mock("react-native-qrcode-svg", () => ({ default: "QRCode" }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("../src/lib/delivery-cache", () => ({ deliveryCache: {}, openDelivery: () => Promise.resolve(null) }));
vi.mock("../src/lib/stock-sync", () => ({ stockSync: { subscribe: () => () => undefined, get: () => ({ running: false, outcome: null }), run: () => Promise.resolve(null) } }));
vi.mock("../src/api", () => ({ api: {}, access: { role: () => "owner" }, session: { get: () => ({ account: { id: "owner-1" } }) } }));
vi.mock("../src/components/countdown", () => ({ Countdown: "Countdown", useSecondsLeft: () => null }));
vi.mock("../src/components/icons", () => ({ Minus: "Minus", Plus: "Plus" }));
vi.mock("../src/components/reason-picker", () => ({ ReasonPicker: "ReasonPicker" }));
vi.mock("../src/lib/shop-orders", async (importActual) => ({
  ...((await importActual()) as Record<string, unknown>),
  createShopOrder: () => ({ subscribe: () => () => undefined, get: () => mock.view }),
}));
import OrderScreen from "../src/app/orders/[id]";
import { strings } from "../src/strings";

type Found = { buttons: { label: string; disabled: boolean }[]; texts: string[] };
function walk(node: unknown, found: Found): Found {
  if (Array.isArray(node)) { node.forEach((child) => walk(child, found)); return found; }
  if (typeof node === "string") { found.texts.push(node); return found; }
  if (!node || typeof node !== "object" || !("props" in node)) return found;
  const element = node as { type: unknown; props: Record<string, unknown> };
  if (typeof element.type === "function") return walk((element.type as (props: unknown) => unknown)(element.props), found);
  if (element.type === "Button" && typeof element.props.label === "string") found.buttons.push({ label: element.props.label, disabled: element.props.disabled === true });
  return walk(element.props.children, found);
}
const screen = (status: string, offline: boolean) => {
  mock.cursor = 0; mock.hooks = [];
  mock.view = {
    status: "ready", offset: 0, expired: false, message: null, refreshing: false, notice: null, shortLines: [], answering: null, cached: false, offline,
    order: { id: "order-1", status, expiresAt: null, delivererId: "owner-1", deliveryFailureReadyAt: null,
      now: "2030-01-01T00:00:00.000Z", placedAt: "2030-01-01T00:00:00.000Z", rejectReason: null, customer: { name: "Meera", phone: null }, lines: [], address: { label: "home", flat: "", areaLine: null, pincode: "" } },
  };
  return walk(OrderScreen(), { buttons: [], texts: [] });
};

describe("S05 steps that need internet (#617)", () => {
  it.each([["ready", strings.orders.outForDelivery], ["out_for_delivery", strings.orders.arrived]])("turns off the %s step with a note once the phone has no internet, though the order was read online", (status, label) => {
    const online = screen(status, false);
    expect(online.buttons.find((button) => button.label === label)?.disabled).toBe(false);
    expect(online.texts).not.toContain(strings.orders.needsInternet);
    const offline = screen(status, true);
    expect(offline.buttons.find((button) => button.label === label)?.disabled).toBe(true);
    expect(offline.texts).toContain(strings.orders.needsInternet);
  });
});
