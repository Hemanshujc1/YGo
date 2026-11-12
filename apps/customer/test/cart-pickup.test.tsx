// @vitest-environment jsdom
import type { CartResponse, SavedAddress } from "@ygo/contracts";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  replace: vi.fn(),
  navigate: vi.fn(),
  push: vi.fn(),
  placeOrder: vi.fn(),
  server: null as unknown,
  address: null as unknown,
  pricedFor: null as unknown,
}));

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return {
    ActivityIndicator: () => createElement("div"),
    Modal: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
    Pressable: ({ children, onPress, accessibilityRole, accessibilityState, accessibilityLabel }: {
      children?: ReactNode; onPress?: () => void; accessibilityRole?: string; accessibilityState?: { checked?: boolean }; accessibilityLabel?: string;
    }) => createElement("button", { onClick: onPress, role: accessibilityRole, "aria-checked": accessibilityState?.checked, "aria-label": accessibilityLabel }, children),
    ScrollView: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
    View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("expo-router", () => ({
  router: { replace: mock.replace, navigate: mock.navigate, push: mock.push },
  useLocalSearchParams: () => ({ shopId: "shop-1", pincode: "411038", latitude: "18.5", longitude: "73.8" }),
  useNavigation: () => ({}),
}));
vi.mock("@ygo/mobile", async () => {
  const { createElement } = await import("react");
  return {
    Button: ({ label, onPress, disabled }: { label: string; onPress?: () => void; disabled?: boolean }) =>
      createElement("button", { onClick: disabled ? undefined : onPress, disabled }, label),
    Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
  };
});
vi.mock("../src/api", () => ({ api: { placeOrder: mock.placeOrder } }));
vi.mock("../src/components/stepper", () => ({ Stepper: () => null }));
vi.mock("../src/components/top-bar", () => ({ TopBar: () => null }));
vi.mock("../src/lib/go-home", () => ({ goHome: vi.fn() }));
vi.mock("../src/lib/push", () => ({ push: { ask: vi.fn() } }));
vi.mock("../src/lib/use-order", () => ({ openPlaced: vi.fn() }));
vi.mock("../src/lib/use-cart", () => ({
  useCart: () => ({
    cart: { setCount: vi.fn(), retry: vi.fn(), adopt: vi.fn() },
    view: { status: "ready", server: mock.server, lines: [{ listingId: "l1", count: 2 }], saving: false, message: null, notice: null, pricedFor: mock.pricedFor },
  }),
  useDeliverTo: () => ({
    deliverTo: { load: vi.fn(), choose: vi.fn() },
    view: { status: "ready", addresses: mock.address ? [mock.address] : [], address: mock.address },
  }),
}));

import CartScreen from "../src/app/cart/[shopId]";
import { strings } from "../src/strings";

const words = strings.cart;
const place = { pincode: "411038", latitude: 18.5, longitude: 73.8 };
const home: SavedAddress = {
  id: "addr-1", label: "home", flat: "Flat 4B", areaLine: "Kothrud", pincode: "411038", point: { latitude: 18.5, longitude: 73.8 },
  contactName: null, contactPhone: null, createdAt: "2030-01-01T00:00:00.000Z",
} as unknown as SavedAddress;
const line = { listingId: "l1", name: "Toor Dal", brand: null, baseUnit: "kg", quantity: "1", count: 2, part: null, price: "135.00", state: "orderable", left: 10, lineTotal: "270.00" };
const delivery = { productValue: "270.00", shopDiscount: null, deliveryFee: "30.00", smallCartFee: null, total: "300.00" };
const pickupQuote = { productValue: "270.00", shopDiscount: null, pickupFee: "10.00", total: "280.00", placeable: true, reasons: [] };
const cartOf = (over: Partial<CartResponse> = {}): CartResponse => ({
  shop: { id: "shop-1", name: "Sai General Stores" }, revision: 3, lines: [line] as CartResponse["lines"],
  quote: delivery, placeable: true, reasons: [], pickup: pickupQuote, ...over,
});

beforeEach(() => {
  mock.server = cartOf();
  mock.address = home;
  mock.pricedFor = place;
  mock.placeOrder.mockResolvedValue({ ok: false, status: 409, code: "OWN_SHOP" });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("C07 choosing delivery or pickup (FUL-7, #65)", () => {
  it("offers both when the shop has pickup open, starting on delivery with its quote, address and total", () => {
    const { getAllByText, getByRole, getByText, queryByText } = render(<CartScreen />);
    expect(getByRole("radio", { name: words.fulfilment.delivery }).getAttribute("aria-checked")).toBe("true");
    expect(getByRole("radio", { name: words.fulfilment.pickup }).getAttribute("aria-checked")).toBe("false");
    // The choice's own label and the quote's delivery row.
    expect(getAllByText(words.delivery)).toHaveLength(2);
    expect(getByText(words.deliverTo)).toBeDefined();
    expect(getByText(words.place("₹300"))).toBeDefined();
    expect(queryByText(words.fulfilment.bookingFee)).toBeNull();
  });

  it("offers no choice when the shop has no pickup open for this cart", () => {
    mock.server = cartOf({ pickup: null });
    const { queryByRole, getByText } = render(<CartScreen />);
    expect(queryByRole("radio", { name: words.fulfilment.pickup })).toBeNull();
    expect(getByText(words.place("₹300"))).toBeDefined();
    expect(getByText(words.footer)).toBeDefined();
  });

  it("pickup shows its own quote with the booking fee and the collection note, and needs no address", () => {
    mock.address = null;
    const { getByRole, getByText, queryByText, queryAllByText } = render(<CartScreen />);
    fireEvent.click(getByRole("radio", { name: words.fulfilment.pickup }));
    expect(getByText(words.fulfilment.bookingFee)).toBeDefined();
    expect(getByText("₹10")).toBeDefined();
    expect(getByText(words.place("₹280"))).toBeDefined();
    expect(getByText(words.fulfilment.pickupFrom("Sai General Stores"))).toBeDefined();
    expect(getByText(words.fulfilment.pickupNote)).toBeDefined();
    expect(getByText(words.fulfilment.footer)).toBeDefined();
    // Only the choice's own label is left: the quote has no delivery row.
    expect(queryAllByText(words.delivery)).toHaveLength(1);
    expect(queryByText(words.deliverTo)).toBeNull();
    expect(queryByText(words.noAddress)).toBeNull();
    expect((getByText(words.place("₹280")) as HTMLButtonElement).disabled).toBe(false);
  });

  it("delivery with no address stays disabled, pickup does not", () => {
    mock.address = null;
    const { getByText } = render(<CartScreen />);
    expect((getByText(words.place("₹300")) as HTMLButtonElement).disabled).toBe(true);
  });

  it("places a pickup with the pickup total and the place the cart was priced for", async () => {
    const { getByRole, getByText } = render(<CartScreen />);
    fireEvent.click(getByRole("radio", { name: words.fulfilment.pickup }));
    fireEvent.click(getByText(words.place("₹280")));
    await waitFor(() => expect(mock.placeOrder).toHaveBeenCalledWith("shop-1", { revision: 3, total: "280.00", fulfilment: "pickup", ...place }));
  });

  it("places a delivery with the address, as before", async () => {
    const { getByText } = render(<CartScreen />);
    fireEvent.click(getByText(words.place("₹300")));
    await waitFor(() => expect(mock.placeOrder).toHaveBeenCalledWith("shop-1", { revision: 3, total: "300.00", addressId: "addr-1" }));
  });

  it("shows the pickup's own reasons and keeps Place order off while it can't be placed", () => {
    mock.server = cartOf({ pickup: { ...pickupQuote, placeable: false, reasons: [{ code: "BELOW_CONTRIBUTION_FLOOR" }] } });
    const { getByRole, getByText } = render(<CartScreen />);
    fireEvent.click(getByRole("radio", { name: words.fulfilment.pickup }));
    expect(getByText(words.reasons.floor)).toBeDefined();
    expect((getByText(words.place("₹280")) as HTMLButtonElement).disabled).toBe(true);
  });

  it("when delivery is shut but pickup is open, shows pickup alone with no choice and no delivery reason", () => {
    mock.server = cartOf({ quote: null, placeable: false, reasons: [{ code: "NOT_DELIVERING" }] });
    const { queryByRole, getByText, queryByText } = render(<CartScreen />);
    expect(queryByRole("radio", { name: words.fulfilment.pickup })).toBeNull();
    expect(getByText(words.place("₹280"))).toBeDefined();
    expect(getByText(words.fulfilment.pickupFrom("Sai General Stores"))).toBeDefined();
    expect(queryByText(words.reasons.notDelivering)).toBeNull();
  });

  it("keeps Place order off until the cart is priced for the place it would be sent from", () => {
    mock.pricedFor = null;
    const { getByRole, getByText } = render(<CartScreen />);
    fireEvent.click(getByRole("radio", { name: words.fulfilment.pickup }));
    expect((getByText(words.place("₹280")) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a pickup with no booking fee shows no fee row", () => {
    mock.server = cartOf({ pickup: { ...pickupQuote, pickupFee: "0.00", total: "270.00" } });
    const { getByRole, queryByText } = render(<CartScreen />);
    fireEvent.click(getByRole("radio", { name: words.fulfilment.pickup }));
    expect(queryByText(words.fulfilment.bookingFee)).toBeNull();
  });
});
