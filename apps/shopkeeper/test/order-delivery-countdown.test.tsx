import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  hooks: [] as unknown[],
  cursor: 0,
  view: null as unknown,
  seconds: [] as Array<[string | null, number]>,
}));
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
vi.mock("expo-file-system", () => ({ File: function File() { return undefined; } }));
vi.mock("expo-camera", () => ({ CameraView: "CameraView", useCameraPermissions: () => [null, () => Promise.resolve({ granted: false })] }));
vi.mock("expo-image-manipulator", () => ({ SaveFormat: { JPEG: "jpeg" }, manipulateAsync: () => Promise.resolve({ uri: "" }) }));
vi.mock("react-native-qrcode-svg", () => ({ default: "QRCode" }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("../src/lib/delivery-cache", () => ({ deliveryCache: {}, openDelivery: () => Promise.resolve(null) }));
vi.mock("../src/lib/stock-sync", () => ({ stockSync: { subscribe: () => () => undefined, get: () => ({ running: false, outcome: null }), run: () => Promise.resolve(null) } }));
vi.mock("../src/api", () => ({ api: {}, access: { role: () => "owner" }, session: { get: () => ({ account: { id: "owner-1" } }) } }));
vi.mock("../src/components/countdown", () => ({
  Countdown: "Countdown",
  useSecondsLeft: (expiresAt: string | null, offset: number) => { mock.seconds.push([expiresAt, offset]); return null; },
}));
vi.mock("../src/components/icons", () => ({ Minus: "Minus", Plus: "Plus" }));
vi.mock("../src/components/reason-picker", () => ({ ReasonPicker: "ReasonPicker" }));
vi.mock("../src/lib/shop-orders", async (importActual) => ({
  ...((await importActual()) as Record<string, unknown>),
  createShopOrder: () => ({ subscribe: () => () => undefined, get: () => mock.view }),
}));
import OrderScreen from "../src/app/orders/[id]";

const readyAt = "2030-01-01T00:02:00.000Z";
const render = () => { mock.cursor = 0; OrderScreen(); };

describe("S05 failed-delivery countdown (#56)", () => {
  beforeEach(() => {
    mock.hooks = [];
    mock.seconds = [];
    mock.view = {
      status: "ready", offset: 1234, expired: false, message: null, refreshing: false, notice: null, shortLines: [], answering: null,
      order: { id: "order-1", status: "arrived", expiresAt: null, delivererId: "owner-1", deliveryFailureReadyAt: readyAt, now: "2030-01-01T00:00:00.000Z" },
    };
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("counts against the server clock offset read when the order loaded, however often the screen re-renders", () => {
    vi.setSystemTime(new Date("2030-01-01T00:00:10.000Z"));
    render();
    vi.setSystemTime(new Date("2030-01-01T00:00:40.000Z")); // the shopkeeper taps a reason
    render();
    const failure = mock.seconds.filter(([expiresAt]) => expiresAt === readyAt);
    expect(failure).toEqual([[readyAt, 1234], [readyAt, 1234]]);
  });
});
