// @vitest-environment jsdom
import type { OrderProposal, OrderResponse } from "@ygo/contracts";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


const mock = vi.hoisted(() => ({
  navigate: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  canGoBack: vi.fn(() => true),
  segments: ["index"] as string[],
  orderResult: null as unknown,
  ordersResult: null as unknown,
}));

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return {
    ActivityIndicator: () => createElement("div", { "data-testid": "spinner" }),
    AppState: {
      addEventListener: vi.fn(() => ({ remove: vi.fn() })),
    },
    Linking: { openURL: vi.fn() },
    Pressable: ({
      children,
      onPress,
      accessibilityLabel,
      accessibilityRole,
      disabled,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      accessibilityLabel?: string;
      accessibilityRole?: string;
      disabled?: boolean;
    }) =>
      createElement(
        "button",
        {
          onClick: disabled ? undefined : onPress,
          "aria-label": accessibilityLabel,
          role: accessibilityRole,
          disabled,
        },
        children,
      ),
    RefreshControl: () => null,
    ScrollView: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
    View: ({ children, className }: { children?: ReactNode; className?: string }) =>
      createElement("div", { className }, children),
  };
});

vi.mock("react-native-safe-area-context", async () => {
  const { createContext, useContext } = await import("react");
  const SafeAreaInsetsContext = createContext({ top: 20, bottom: 0, left: 0, right: 0 });
  return { SafeAreaInsetsContext, useSafeAreaInsets: () => useContext(SafeAreaInsetsContext) };
});

vi.mock("react-native-reanimated", () => ({
  default: {
    createAnimatedComponent: (c: unknown) => c,
  },
  useReducedMotion: () => false,
  useSharedValue: (v: unknown) => ({ value: v }),
  useAnimatedProps: () => ({}),
  withTiming: (v: unknown) => v,
  Easing: { out: () => undefined, cubic: undefined },
}));

vi.mock("react-native-svg", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ children }: { children?: ReactNode }) => createElement("svg", null, children),
    Circle: () => null,
    Path: () => null,
  };
});

vi.mock("expo-router", () => ({
  router: {
    navigate: mock.navigate,
    replace: mock.replace,
    back: mock.back,
    canGoBack: () => mock.canGoBack(),
  },
  useLocalSearchParams: () => ({ id: "order-1" }),
  useSegments: () => mock.segments,
}));

vi.mock("@ygo/mobile", async () => {
  const { createElement, useEffect } = await import("react");
  return {
    Button: ({
      label,
      onPress,
      disabled,
      busy,
    }: {
      label: string;
      onPress?: () => void;
      disabled?: boolean;
      busy?: boolean;
    }) =>
      createElement(
        "button",
        {
          onClick: disabled ? undefined : onPress,
          disabled: disabled || busy,
        },
        busy ? `${label} (busy)` : label,
      ),
    Confirm: () => null,
    StatusChip: ({ word }: { word: string }) => createElement("span", null, word),
    Text: ({ children, className }: { children?: ReactNode; className?: string }) =>
      createElement("span", { className }, children),
    useInFront: ({ start, stop }: { start?: () => void; stop?: () => void }) => {
      useEffect(() => {
        start?.();
        return () => stop?.();
      }, [start, stop]);
    },
  };
});

vi.mock("../src/api", () => ({
  api: {
    order: vi.fn(() => Promise.resolve(mock.orderResult)),
    orders: vi.fn(() => Promise.resolve(mock.ordersResult)),
    confirmOrderTotal: vi.fn(),
    declineOrderTotal: vi.fn(),
    cancelOrder: vi.fn(),
    recoverHandoverCode: vi.fn(),
  },
  session: {
    get: () => ({ status: "signed-in" }),
    subscribe: vi.fn(() => () => undefined),
  },
}));

vi.mock("../src/lib/push", () => ({
  push: {
    onReceived: vi.fn(() => () => undefined),
  },
}));

vi.stubGlobal("__DEV__", false);

vi.mock("../src/lib/receipt", () => ({
  hasReceipt: () => false,
  makeReceipt: vi.fn(),
}));

vi.mock("../src/components/icons", () => ({
  ChevronLeft: () => null,
  Phone: () => null,
}));

vi.mock("lucide-react-native", () => ({
  ChevronLeft: () => null,
  Phone: () => null,
}));

import OrderScreen from "../src/app/order/[id]";
import { strings } from "../src/strings";

const words = strings.order;

// A pickup on C09/C19 and its changed total (FUL-7, #65): no address, the shop to collect from, the booking fee, the code once it is ready.
const pickup: OrderResponse = {
  id: "order-1", number: 1042, status: "preparing", placedAt: "2030-01-01T00:00:00.000Z",
  shop: { id: "shop-1", name: "Sai General Stores", phone: "+919876543210" },
  fulfilment: "pickup", address: null,
  lines: [{ name: "Toor Dal", brand: "Tata", baseUnit: "kg", quantity: "1", count: 2, part: null, unitPrice: "135.00", lineTotal: "270.00" }],
  productValue: "270.00", shopDiscount: null, deliveryFee: "0.00", smallCartFee: null, pickupFee: "10.00", total: "280.00",
  rejectReason: null, answerExpired: false, handoverCode: null, handoverLocked: false, itemsCheckedAt: null, confirmByAt: null, proposal: null, cancelRequest: null,
};
const proposal: OrderProposal = {
  id: "00000000-0000-4000-8000-000000000010", revision: 2, sourceStatus: "placed", createdAt: "2030-01-01T00:01:00.000Z", confirmByAt: "2030-01-01T00:06:00.000Z",
  productValue: "135.00", originalProductValue: "270.00", deliveryFee: "0.00", smallCartFee: null, pickupFee: "10.00", total: "145.00", originalTotal: "280.00",
  shopDiscount: null, lostShopDiscount: null,
  lines: [{
    listingId: "00000000-0000-4000-8000-000000000001", name: "Toor Dal", brand: "Tata", baseUnit: "kg", quantity: "1", originalCount: 2, count: 1,
    originalPart: null, part: null, unitPrice: "135.00", originalLineTotal: "270.00", lineTotal: "135.00", changeReason: "out_of_stock",
  }],
};
const show = (order: OrderResponse) => {
  mock.orderResult = { ok: true, data: order };
  return render(<OrderScreen />);
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  mock.segments = ["index"];
});

describe("a pickup order (FUL-7, #65)", () => {
  it("shows the shop to collect from and the counter payment, with no delivery row or address", async () => {
    const { findByText, getByText, queryByText } = show(pickup);
    expect(await findByText(words.collectFrom)).toBeDefined();
    expect(getByText("Sai General Stores")).toBeDefined();
    expect(getByText(words.payAtCounter)).toBeDefined();
    expect(queryByText(words.deliverTo)).toBeNull();
    expect(queryByText(strings.cart.delivery)).toBeNull();
    expect(queryByText(words.pay)).toBeNull();
  });

  it("names the booking fee, charged on collection, inside the total", async () => {
    const { findByText, getByText } = show(pickup);
    expect(await findByText(strings.cart.fulfilment.bookingFee)).toBeDefined();
    expect(getByText(strings.cart.fulfilment.bookingFeeNote)).toBeDefined();
    expect(getByText("₹10")).toBeDefined();
    expect(getByText("₹280")).toBeDefined();
  });

  it("shows no booking fee row when the pickup has none, and none on a delivery", async () => {
    const free = show({ ...pickup, pickupFee: "0.00", total: "270.00" });
    await free.findByText(words.collectFrom);
    expect(free.queryByText(strings.cart.fulfilment.bookingFee)).toBeNull();
    cleanup();
    const delivery = show({ ...pickup, fulfilment: "delivery", pickupFee: null, address: { label: "home", flat: "402", areaLine: "MG Road", pincode: "560001" }, deliveryFee: "30.00", total: "300.00" });
    await delivery.findByText(words.deliverTo);
    expect(delivery.queryByText(strings.cart.fulfilment.bookingFee)).toBeNull();
    expect(delivery.getByText(strings.cart.delivery)).toBeDefined();
  });

  it("reads ready as ready to collect and shows the code from Ready, to give at the counter", async () => {
    const { findByText, getByText } = show({ ...pickup, status: "ready", handoverCode: "4821" });
    expect(await findByText(words.pickupReady)).toBeDefined();
    expect(getByText(words.pickupCode)).toBeDefined();
    expect(getByText("4821")).toBeDefined();
  });

  it("shows no code before Ready, and a delivery's ready stays Ready", async () => {
    const before = show({ ...pickup, status: "accepted", handoverCode: null });
    await before.findByText(words.statuses.accepted);
    expect(before.queryByText(words.pickupCode)).toBeNull();
    cleanup();
    const delivery = show({ ...pickup, status: "ready", fulfilment: "delivery", pickupFee: null, address: { label: "home", flat: "402", areaLine: null, pincode: "560001" } });
    expect(await delivery.findByText(words.statuses.ready)).toBeDefined();
    expect(delivery.queryByText(words.pickupReady)).toBeNull();
  });

  it("keeps the booking fee in a changed total, with no address and the new total", async () => {
    const { findByText, getByText, queryByText } = show({ ...pickup, status: "awaiting_customer_confirm", total: "280.00", confirmByAt: "2030-01-01T00:06:00.000Z", proposal });
    expect(await findByText(words.changedTotal.heading)).toBeDefined();
    expect(getByText(strings.cart.fulfilment.bookingFee)).toBeDefined();
    expect(getByText("₹10")).toBeDefined();
    expect(getByText("₹145")).toBeDefined();
    expect(getByText(words.collectFrom)).toBeDefined();
    expect(getByText(words.payAtCounter)).toBeDefined();
    expect(queryByText(strings.cart.delivery)).toBeNull();
  });

  it("offers a new code only when the counter has locked this one, and shows the new code after it (#597)", async () => {
    const open = show({ ...pickup, status: "ready", handoverCode: "4821" });
    await open.findByText("4821");
    expect(open.queryByText(words.newCode)).toBeNull();
    cleanup();
    const locked = show({ ...pickup, status: "ready", handoverCode: "4821", handoverLocked: true });
    expect(await locked.findByText(words.codeLocked)).toBeDefined();
    const { api } = await import("../src/api");
    vi.mocked(api.recoverHandoverCode).mockResolvedValue({ ok: true, data: { ...pickup, status: "ready", handoverCode: "7305", handoverLocked: false } });
    fireEvent.click(locked.getByText(words.newCode));
    expect(await locked.findByText("7305")).toBeDefined();
    await waitFor(() => expect(locked.queryByText(words.newCode)).toBeNull());
    expect(api.recoverHandoverCode).toHaveBeenCalledWith(pickup.id);
  });

  it("says so when the new code could not be had", async () => {
    const locked = show({ ...pickup, status: "ready", handoverCode: "4821", handoverLocked: true });
    await locked.findByText(words.codeLocked);
    const { api } = await import("../src/api");
    vi.mocked(api.recoverHandoverCode).mockRejectedValue(new Error("offline"));
    fireEvent.click(locked.getByText(words.newCode));
    expect(await locked.findByText(words.recoverOffline)).toBeDefined();
  });
});
