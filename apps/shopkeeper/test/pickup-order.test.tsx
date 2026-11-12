import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  hooks: [] as unknown[], cursor: 0, view: null as unknown, refresh: undefined as unknown,
  api: { readyForPickup: undefined as unknown, completePickup: undefined as unknown, shopDeliverers: undefined as unknown },
  replace: undefined as unknown,
}));
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
  useSyncExternalStore: () => mock.view,
  useEffect: () => undefined,
}));
vi.mock("expo-router", () => ({ Link: "Link", router: { replace: (...args: unknown[]) => (mock.replace as (...a: unknown[]) => void)(...args) }, useLocalSearchParams: () => ({ id: "order-1" }) }));
vi.mock("@ygo/mobile", () => ({ Button: "Button", Confirm: "Confirm", StatusChip: "StatusChip", Text: "Text", useInFront: () => undefined }));
vi.mock("react-native", () => ({
  ActivityIndicator: "Spinner", Image: "Image", Linking: {}, Modal: "Modal", Pressable: "Pressable",
  RefreshControl: "RefreshControl", ScrollView: "ScrollView", TextInput: "TextInput", View: "View",
}));
vi.mock("expo-camera", () => ({ CameraView: "CameraView", useCameraPermissions: () => [null, () => Promise.resolve({ granted: false })] }));
vi.mock("expo-image-manipulator", () => ({ SaveFormat: { JPEG: "jpeg" }, manipulateAsync: () => Promise.resolve({ uri: "" }) }));
vi.mock("react-native-qrcode-svg", () => ({ default: "QRCode" }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("../src/api", () => ({
  api: new Proxy({}, { get: (_, name: string) => (mock.api as Record<string, unknown>)[name] }),
  access: { role: () => "owner" },
  session: { get: () => ({ account: { id: "owner-1" } }) },
}));
vi.mock("../src/components/countdown", () => ({ Countdown: "Countdown", useSecondsLeft: () => null }));
vi.mock("../src/components/icons", () => ({ Minus: "Minus", Plus: "Plus" }));
vi.mock("../src/components/reason-picker", () => ({ ReasonPicker: "ReasonPicker" }));
vi.mock("../src/lib/shop-orders", async (importActual) => ({
  ...((await importActual()) as Record<string, unknown>),
  createShopOrder: () => ({ subscribe: () => () => undefined, get: () => mock.view, refresh: (...args: unknown[]) => (mock.refresh as (...a: unknown[]) => void)(...args) }),
}));
import OrderScreen from "../src/app/orders/[id]";
import { strings } from "../src/strings";

type El = { type: unknown; props: Record<string, unknown> };
function elements(node: unknown): El[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as El;
  if (typeof element.type === "function") return elements((element.type as (props: unknown) => unknown)(element.props));
  return [element, ...elements(element.props.children)];
}
const draw = () => { mock.cursor = 0; return elements(OrderScreen()); };
const buttons = (nodes: El[]) => nodes.filter((n) => n.type === "Button");
const button = (nodes: El[], label: string) => buttons(nodes).find((n) => n.props.label === label);
const press = (node: El | undefined) => (node?.props.onPress as () => void)();
const texts = (nodes: El[]) => nodes.flatMap(({ props: { children } }) => typeof children === "string" ? [children] : Array.isArray(children) && children.every((c) => typeof c === "string") ? [children.join("")] : []);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const words = strings.orders;

function show(order: Record<string, unknown>) {
  mock.cursor = 0; mock.hooks = [];
  mock.view = {
    status: "ready", offset: 0, expired: false, message: null, refreshing: false, notice: null, shortLines: [], answering: null,
    order: {
      id: "order-1", number: 7, status: "preparing", expiresAt: null, delivererId: null, deliveryFailureReadyAt: null, shopUpiId: null,
      now: "2030-01-01T00:00:00.000Z", placedAt: "2030-01-01T00:00:00.000Z", rejectReason: null, customer: { name: "Meera", phone: null },
      lines: [], productValue: "100.00", deliveryFee: "0.00", smallCartFee: null, pickupFee: null, total: "100.00",
      fulfilment: "pickup", address: null, ...order,
    },
  };
  return draw();
}
const type = (nodes: El[], code: string) => (nodes.find((n) => n.type === "TextInput" && n.props.accessibilityLabel === words.pickupCode)?.props.onChangeText as (text: string) => void)(code);

beforeEach(() => {
  mock.api.readyForPickup = vi.fn().mockResolvedValue({ ok: true, data: {} });
  mock.api.completePickup = vi.fn().mockResolvedValue({ ok: true, data: {} });
  mock.api.shopDeliverers = vi.fn();
  mock.refresh = vi.fn();
  mock.replace = vi.fn();
});

describe("S05 pickup order (FUL-7, #65)", () => {
  it("shows Pickup and the counter total in place of an address, and offers no deliverer", () => {
    const shown = show({});
    expect(texts(shown)).toEqual(expect.arrayContaining([words.pickupLabel, words.collectAtCounter, words.collectCounterNote]));
    expect(texts(shown)).not.toContain(words.deliverTo);
    expect(texts(shown)).not.toContain(words.collect);
    expect(button(shown, words.assign)).toBeUndefined();
    expect(button(shown, words.chooseDeliverer)).toBeUndefined();
    expect(button(shown, words.ready)).toBeUndefined();
  });

  it("makes a preparing pickup ready with Ready for pickup", async () => {
    const shown = show({});
    press(button(shown, words.readyForPickup));
    await settle();
    expect(mock.api.readyForPickup).toHaveBeenCalledWith("order-1");
    expect(mock.refresh).toHaveBeenCalled();
  });

  it("says why when Ready for pickup is refused", async () => {
    mock.api.readyForPickup = vi.fn().mockResolvedValue({ ok: false, status: 409, code: "ORDER_STATUS_CHANGED" });
    press(button(show({}), words.readyForPickup));
    await settle();
    expect(texts(draw())).toContain(strings.errors.ORDER_STATUS_CHANGED);
    expect(mock.refresh).not.toHaveBeenCalled();
  });

  it("asks for the code and the payment on a ready pickup, with no photo and no delivery steps", () => {
    const shown = show({ status: "ready" });
    expect(shown.some((n) => n.type === "TextInput" && n.props.accessibilityLabel === words.pickupCode)).toBe(true);
    expect(button(shown, words.completePickup)?.props.disabled).toBe(true);
    for (const label of [words.completeDelivery, words.outForDelivery, words.proofException]) expect(button(shown, label)).toBeUndefined();
    expect(button(shown, words.readyForPickup)).toBeUndefined();
  });

  it("completes a pickup with the code and cash, then goes back to Orders", async () => {
    type(show({ status: "ready" }), "1234");
    const shown = draw();
    expect(button(shown, words.completePickup)?.props.disabled).toBe(false);
    press(button(shown, words.completePickup));
    await settle();
    expect(mock.api.completePickup).toHaveBeenCalledWith("order-1", { handoverCode: "1234", payment: "cash" });
    expect(mock.replace).toHaveBeenCalledWith("/orders");
  });

  it("completes a pickup paid by UPI", async () => {
    type(show({ status: "ready" }), "4321");
    press(button(draw(), words.upi));
    press(button(draw(), words.completePickup));
    await settle();
    expect(mock.api.completePickup).toHaveBeenCalledWith("order-1", { handoverCode: "4321", payment: "upi" });
  });

  it("says a wrong or locked code did not match and stays on the order", async () => {
    for (const code of ["HANDOVER_CODE_WRONG", "HANDOVER_CODE_LOCKED"] as const) {
      mock.api.completePickup = vi.fn().mockResolvedValue({ ok: false, status: 400, code });
      type(show({ status: "ready" }), "0000");
      press(button(draw(), words.completePickup));
      await settle();
      expect(texts(draw())).toContain(strings.errors[code]);
    }
    expect(mock.replace).not.toHaveBeenCalled();
  });

  it("says the order changed when it is no longer ready", async () => {
    mock.api.completePickup = vi.fn().mockResolvedValue({ ok: false, status: 409, code: "ORDER_STATUS_CHANGED" });
    type(show({ status: "ready" }), "1234");
    press(button(draw(), words.completePickup));
    await settle();
    expect(texts(draw())).toContain(strings.errors.ORDER_STATUS_CHANGED);
    expect(mock.replace).not.toHaveBeenCalled();
  });

  it("sends a pickup once when Complete pickup is tapped twice", async () => {
    type(show({ status: "ready" }), "1234");
    const shown = draw();
    press(button(shown, words.completePickup));
    press(button(draw(), words.completePickup));
    await settle();
    expect(mock.api.completePickup).toHaveBeenCalledTimes(1);
  });

  it("shows the booking fee, and what it is, only when there is one", () => {
    const withFee = texts(show({ pickupFee: "10.00", total: "110.00" }));
    expect(withFee).toEqual(expect.arrayContaining([words.bookingFee, "₹10", words.bookingFeeNote]));
    for (const pickupFee of ["0.00", null]) expect(texts(show({ pickupFee }))).not.toContain(words.bookingFee);
  });

  it("keeps delivery as it was: the address, the door total and the deliverer choice", () => {
    const shown = show({ fulfilment: "delivery", pickupFee: null, address: { label: "home", flat: "4B", areaLine: null, pincode: "411001" } });
    expect(texts(shown)).toEqual(expect.arrayContaining([words.deliverTo, words.collect, words.assign]));
    expect(texts(shown)).not.toContain(words.pickupLabel);
    expect(button(shown, words.chooseDeliverer)).toBeDefined();
    expect(button(shown, words.readyForPickup)).toBeUndefined();
  });
});
