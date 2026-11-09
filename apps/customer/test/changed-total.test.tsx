// @vitest-environment jsdom
import type { OrderProposal, OrderResponse, OrderSummary } from "@ygo/contracts";
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
  confirmTotalResult: null as unknown,
  declineTotalResult: null as unknown,
  refreshCalls: 0,
  cancelCalls: 0,
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

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

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
    confirmOrderTotal: vi.fn(() => Promise.resolve(mock.confirmTotalResult)),
    declineOrderTotal: vi.fn(() => Promise.resolve(mock.declineTotalResult)),
    cancelOrder: vi.fn(() => {
      mock.cancelCalls++;
      return Promise.resolve({ ok: true, data: mock.orderResult });
    }),
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

import { ChangedTotalBanner } from "../src/components/changed-total-banner";
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
import { createChangedTotalBannerStore, earliestAwaitingOrder } from "../src/lib/changed-total-banner";
import { createOrder } from "../src/lib/order";
import { strings } from "../src/strings";

const words = strings.order;

const sampleProposal: OrderProposal = {
  id: "00000000-0000-4000-8000-000000000010",
  revision: 2,
  sourceStatus: "placed",
  createdAt: "2030-01-01T00:01:00.000Z",
  confirmByAt: "2030-01-01T00:06:00.000Z",
  productValue: "135.00",
  originalProductValue: "270.00",
  deliveryFee: "30.00",
  smallCartFee: "15.00",
  total: "180.00",
  originalTotal: "300.00",
  lines: [
    {
      listingId: "00000000-0000-4000-8000-000000000001",
      name: "Toor Dal",
      brand: "Tata",
      baseUnit: "kg",
      quantity: "1",
      originalCount: 2,
      count: 1,
      originalPart: null,
      part: null,
      unitPrice: "135.00",
      originalLineTotal: "270.00",
      lineTotal: "135.00",
      changeReason: "out_of_stock",
    },
    {
      listingId: "00000000-0000-4000-8000-000000000002",
      name: "Sugar",
      brand: "Madhur",
      baseUnit: "kg",
      quantity: "1",
      originalCount: 1,
      count: 1,
      originalPart: null,
      part: null,
      unitPrice: "45.00",
      originalLineTotal: "45.00",
      lineTotal: "45.00",
      changeReason: null,
    },
  ],
};

const awaitingOrder: OrderResponse = {
  id: "order-1",
  number: 1042,
  status: "awaiting_customer_confirm",
  placedAt: "2030-01-01T00:00:00.000Z",
  shop: { id: "shop-1", name: "Sai General Stores", phone: "+919876543210" },
  address: { label: "home", flat: "402", areaLine: "MG Road", pincode: "560001" },
  lines: [],
  productValue: "135.00",
  deliveryFee: "30.00",
  smallCartFee: "15.00",
  total: "180.00",
  rejectReason: null,
  answerExpired: false,
  handoverCode: null,
  itemsCheckedAt: null,
  confirmByAt: "2030-01-01T00:06:00.000Z",
  proposal: sampleProposal,
  cancelRequest: null,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

beforeEach(() => {
  mock.segments = ["index"];
  mock.orderResult = { ok: true, data: awaitingOrder };
  mock.ordersResult = { ok: true, data: { active: [awaitingOrder], past: [] } };
  mock.confirmTotalResult = { ok: true, data: { ...awaitingOrder, status: "accepted" } };
  mock.declineTotalResult = { ok: true, data: { ...awaitingOrder, status: "cancelled_by_customer" } };
  mock.refreshCalls = 0;
  mock.cancelCalls = 0;
});

describe("earliestAwaitingOrder (#528)", () => {
  it("filters orders awaiting confirmation and returns the one with earliest confirmByAt", () => {
    expect(earliestAwaitingOrder([])).toBeNull();
    expect(earliestAwaitingOrder(null)).toBeNull();

    const placed: OrderSummary = { ...awaitingOrder, id: "o-placed", status: "placed", confirmByAt: null };
    expect(earliestAwaitingOrder([placed])).toBeNull();

    const o1: OrderSummary = { ...awaitingOrder, id: "o-1", confirmByAt: "2030-01-01T00:10:00.000Z" };
    const o2: OrderSummary = { ...awaitingOrder, id: "o-2", confirmByAt: "2030-01-01T00:05:00.000Z" };
    const o3: OrderSummary = { ...awaitingOrder, id: "o-3", confirmByAt: "2030-01-01T00:15:00.000Z" };

    const earliest = earliestAwaitingOrder([o1, o2, o3]);
    expect(earliest?.id).toBe("o-2");
  });
});

describe("createChangedTotalBannerStore lifecycle and polling (#528)", () => {
  it("reads active orders when signed in and schedules 10s polling", async () => {
    const ordersMock = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        active: [{ ...awaitingOrder, id: "order-earliest", confirmByAt: "2030-01-01T00:04:00.000Z" }],
        past: [],
      },
    });
    const sessionMock = {
      get: () => ({ status: "signed-in" }),
      subscribe: vi.fn(() => () => undefined),
    };

    let pushCb: (() => void) | undefined;
    const store = createChangedTotalBannerStore(
      { orders: ordersMock },
      sessionMock,
      (cb) => {
        pushCb = cb;
        return () => undefined;
      },
      undefined,
      10_000,
    );

    store.start();
    await waitFor(() => expect(ordersMock).toHaveBeenCalledTimes(1));
    expect(store.get().order?.id).toBe("order-earliest");

    // Push notification received triggers refresh
    ordersMock.mockClear();
    pushCb?.();
    await waitFor(() => expect(ordersMock).toHaveBeenCalledTimes(1));

    store.stop();
  });
});

describe("ChangedTotalBanner component (#528)", () => {
  it("renders on home and shows new total, formatted without trailing zeros, and countdown", async () => {
    mock.segments = ["index"];
    const { findByRole, getByText } = render(<ChangedTotalBanner />);

    const bannerButton = await findByRole("button");
    expect(bannerButton).toBeDefined();
    expect(getByText(words.changedTotalBanner.title)).toBeDefined();
    expect(getByText("New total: ₹180")).toBeDefined();
    expect(getByText(words.changedTotalBanner.review)).toBeDefined();

    // Tapping the banner navigates to /order/[id]
    fireEvent.click(bannerButton);
    expect(mock.navigate).toHaveBeenCalledWith({
      pathname: "/order/[id]",
      params: { id: "order-1" },
    });
  });

  it("hides when the user is on the order detail screen /order/[id]", () => {
    mock.segments = ["order", "order-1"];
    const { queryByRole } = render(<ChangedTotalBanner />);
    expect(queryByRole("button")).toBeNull();
  });
});

describe("createOrder C10 actions (#528)", () => {
  it("confirmTotal calls confirmOrderTotal and transitions on success", async () => {
    const confirmMock = vi.fn().mockResolvedValue({ ok: true, data: { ...awaitingOrder, status: "accepted" } });
    const client = {
      order: vi.fn(),
      cancelOrder: vi.fn(),
      askToCancelOrder: vi.fn(),
      confirmOrderItems: vi.fn(),
      confirmOrderTotal: confirmMock,
      declineOrderTotal: vi.fn(),
    };
    const orderHandler = createOrder(client, "order-1", awaitingOrder);

    await orderHandler.confirmTotal();
    expect(confirmMock).toHaveBeenCalledWith("order-1");
    expect(orderHandler.get().order?.status).toBe("accepted");
  });

  it("declineTotal calls declineOrderTotal and cancels at no cost on success", async () => {
    const declineMock = vi.fn().mockResolvedValue({ ok: true, data: { ...awaitingOrder, status: "cancelled_by_customer" } });
    const client = {
      order: vi.fn(),
      cancelOrder: vi.fn(),
      askToCancelOrder: vi.fn(),
      confirmOrderItems: vi.fn(),
      confirmOrderTotal: vi.fn(),
      declineOrderTotal: declineMock,
    };
    const orderHandler = createOrder(client, "order-1", awaitingOrder);

    await orderHandler.declineTotal();
    expect(declineMock).toHaveBeenCalledWith("order-1");
    expect(orderHandler.get().order?.status).toBe("cancelled_by_customer");
  });

  it("shows timeUp notice on CONFIRMATION_EXPIRED and refetches without client cancel", async () => {
    const confirmMock = vi.fn().mockResolvedValue({ ok: false, code: "CONFIRMATION_EXPIRED" });
    const orderMock = vi.fn().mockResolvedValue({ ok: true, data: { ...awaitingOrder, status: "cancelled_by_customer" } });
    const cancelMock = vi.fn();
    const client = {
      order: orderMock,
      cancelOrder: cancelMock,
      askToCancelOrder: vi.fn(),
      confirmOrderItems: vi.fn(),
      confirmOrderTotal: confirmMock,
      declineOrderTotal: vi.fn(),
    };
    const orderHandler = createOrder(client, "order-1", awaitingOrder);

    await orderHandler.confirmTotal();
    expect(orderHandler.get().notice).toBe(words.changedTotal.timeUpBody);
    expect(cancelMock).not.toHaveBeenCalled();
    expect(orderMock).toHaveBeenCalledWith("order-1");
  });
});

describe("OrderScreen C10 Changed total screen (#528)", () => {
  it("renders struck-through original quantities, reasons, fee breakdown, and action buttons", async () => {
    const { findByText, getByText, getAllByText, getByRole } = render(<OrderScreen />);

    // Header & reason chip
    expect(await findByText(words.changedTotal.heading)).toBeDefined();
    expect(getByText("Out of stock")).toBeDefined();

    // Struck-through and proposed labels
    expect(getByText("Tata · 2 × 1 kg")).toBeDefined();
    expect(getByText("Tata · 1 × 1 kg")).toBeDefined();

    // Struck-through original line total and new line total
    expect(getAllByText("₹270").length).toBe(2);
    expect(getAllByText("₹135").length).toBe(2);

    // Unchanged item Sugar
    expect(getByText("Madhur · 1 × 1 kg")).toBeDefined();

    // Fee breakdown: product value, delivery fee, small cart fee, total
    expect(getByText("₹30")).toBeDefined(); // Delivery fee
    expect(getByText("₹15")).toBeDefined(); // Small cart fee
    expect(getByText("₹300")).toBeDefined(); // Struck-through original total
    expect(getByText("₹180")).toBeDefined(); // New proposed total

    // Buttons
    const confirmButton = getByRole("button", { name: words.changedTotal.confirm });
    expect(confirmButton).toBeDefined();
    expect(getByRole("button", { name: words.changedTotal.cancelFree })).toBeDefined();

    // Tapping confirm calls api.confirmOrderTotal
    fireEvent.click(confirmButton);
    await waitFor(() => {
      expect(mock.confirmTotalResult).toBeDefined();
    });
  });

  it("when timer reaches 0, disables Confirm button and refetches order without client-side cancel", async () => {
    // Order whose confirmByAt has already passed
    const expiredAwaitingOrder: OrderResponse = {
      ...awaitingOrder,
      confirmByAt: "2020-01-01T00:00:00.000Z",
    };
    mock.orderResult = { ok: true, data: expiredAwaitingOrder };

    const { findByText, getByText, getByRole } = render(<OrderScreen />);

    expect(await findByText(words.changedTotal.heading)).toBeDefined();
    expect(getByText(words.changedTotal.timeUpBody)).toBeDefined();

    // Confirm button is disabled
    const confirmBtn = getByRole("button", { name: words.changedTotal.confirm }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);

    // CancelOrder was NOT called by client
    expect(mock.cancelCalls).toBe(0);
  });
});
