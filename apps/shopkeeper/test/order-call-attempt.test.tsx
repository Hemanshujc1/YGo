import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ hooks: [] as unknown[], cursor: 0, view: null as unknown }));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const index = mock.cursor++;
    if (!(index in mock.hooks)) mock.hooks[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [mock.hooks[index], () => undefined];
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

function labels(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(labels);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as { type: unknown; props: Record<string, unknown> };
  if (typeof element.type === "function") return labels((element.type as (props: unknown) => unknown)(element.props));
  const own = element.type === "Button" && typeof element.props.label === "string" ? [element.props.label] : [];
  return [...own, ...labels(element.props.children)];
}
const buttons = (phone: string | null) => {
  mock.cursor = 0; mock.hooks = [];
  mock.view = {
    status: "ready", offset: 0, expired: false, message: null, refreshing: false, notice: null, shortLines: [], answering: null,
    order: { id: "order-1", status: "arrived", expiresAt: null, delivererId: "owner-1", deliveryFailureReadyAt: null,
      now: "2030-01-01T00:00:00.000Z", placedAt: "2030-01-01T00:00:00.000Z", rejectReason: null, customer: { name: "Meera", phone }, lines: [], address: { label: "home", flat: "", areaLine: null, pincode: "" } },
  };
  return labels(OrderScreen());
};

describe("S05 call attempt at the door (#523)", () => {
  beforeEach(() => { mock.hooks = []; });

  it("offers Call customer when the Customer has a phone number", () => {
    const shown = buttons("+919876500002");
    expect(shown).toContain(strings.orders.callCustomer);
    expect(shown).not.toContain(strings.orders.markCallAttempt);
  });

  it("offers Record call attempt, with nothing to dial, when the Customer has no phone number", () => {
    const shown = buttons(null);
    expect(shown).toContain(strings.orders.markCallAttempt);
    expect(shown).not.toContain(strings.orders.callCustomer);
  });
});
