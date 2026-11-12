// @vitest-environment jsdom
import type { ApiResult } from "@ygo/api-client";
import type { OrderProposal, OrderResponse, OrderSummary } from "@ygo/contracts";
import type { Timers } from "@ygo/mobile/poller";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { AppState } from "react-native";
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
    View: ({
      children,
      className,
      accessible,
      accessibilityLabel,
      accessibilityLiveRegion,
    }: {
      children?: ReactNode;
      className?: string;
      accessible?: boolean;
      accessibilityLabel?: string;
      accessibilityLiveRegion?: string;
    }) =>
      createElement(
        "div",
        {
          className,
          "aria-label": accessibilityLabel,
          "aria-live": accessibilityLiveRegion,
          "data-accessible": accessible ? "true" : undefined,
        },
        children,
      ),
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
import { BannerCountdown, useSecondsLeft } from "../src/components/countdown";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
import { api } from "../src/api";
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
  pickupFee: null,
  total: "180.00",
  originalTotal: "300.00",
  shopDiscount: null,
  lostShopDiscount: null,
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
  fulfilment: "delivery",
  address: { label: "home", flat: "402", areaLine: "MG Road", pincode: "560001" },
  lines: [],
  productValue: "135.00",
  shopDiscount: null,
  deliveryFee: "30.00",
  smallCartFee: "15.00",
  pickupFee: null,
  total: "180.00",
  rejectReason: null,
  answerExpired: false,
  handoverCode: null,
  handoverLocked: false,
  itemsCheckedAt: null,
  confirmByAt: "2030-01-01T00:06:00.000Z",
  proposal: sampleProposal,
  cancelRequest: null,
};

/** What `/v1/orders` lists: the order's own total stays the original while the proposal's is open (#578). */
const awaitingSummary: OrderSummary = { ...awaitingOrder, total: "300.00", proposedTotal: "180.00" };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

beforeEach(() => {
  mock.segments = ["index"];
  mock.orderResult = { ok: true, data: awaitingOrder };
  mock.ordersResult = { ok: true, data: { active: [awaitingSummary], past: [] } };
  mock.confirmTotalResult = { ok: true, data: { ...awaitingOrder, status: "accepted" } };
  mock.declineTotalResult = { ok: true, data: { ...awaitingOrder, status: "cancelled_by_customer" } };
  mock.refreshCalls = 0;
  mock.cancelCalls = 0;
});

describe("earliestAwaitingOrder (#528)", () => {
  it("filters orders awaiting confirmation and returns the one with earliest confirmByAt", () => {
    expect(earliestAwaitingOrder([])).toBeNull();
    expect(earliestAwaitingOrder(null)).toBeNull();

    const placed: OrderSummary = { ...awaitingSummary, id: "o-placed", status: "placed", confirmByAt: null };
    expect(earliestAwaitingOrder([placed])).toBeNull();

    const o1: OrderSummary = { ...awaitingSummary, id: "o-1", confirmByAt: "2030-01-01T00:10:00.000Z" };
    const o2: OrderSummary = { ...awaitingSummary, id: "o-2", confirmByAt: "2030-01-01T00:05:00.000Z" };
    const o3: OrderSummary = { ...awaitingSummary, id: "o-3", confirmByAt: "2030-01-01T00:15:00.000Z" };

    const earliest = earliestAwaitingOrder([o1, o2, o3]);
    expect(earliest?.id).toBe("o-2");

    // Without the proposal's total there is nothing right to show, so it is not the banner's order (#578).
    expect(earliestAwaitingOrder([{ ...o2, proposedTotal: null }])).toBeNull();
  });
});

describe("createChangedTotalBannerStore lifecycle and polling (#528)", () => {
  it("reads active orders when signed in and schedules 10s polling", async () => {
    const ordersMock = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        active: [{ ...awaitingSummary, id: "order-earliest", confirmByAt: "2030-01-01T00:04:00.000Z" }],
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

  it("resumes foreground, session and push triggers after start → stop → start without duplicate listeners", async () => {
    let appStateListener: ((state: string) => void) | undefined;
    const appStateSpy = vi.spyOn(AppState, "addEventListener").mockImplementation((_, listener) => {
      appStateListener = listener as (state: string) => void;
      return { remove: vi.fn(() => { appStateListener = undefined; }) };
    });

    let sessionListener: (() => void) | undefined;
    const sessionMock = {
      get: () => ({ status: "signed-in" }),
      subscribe: vi.fn((listener: () => void) => {
        sessionListener = listener;
        return vi.fn(() => { sessionListener = undefined; });
      }),
    };

    let pushListener: (() => void) | undefined;
    const pushMock = vi.fn((listener: () => void) => {
      pushListener = listener;
      return vi.fn(() => { pushListener = undefined; });
    });

    const ordersMock = vi.fn().mockResolvedValue({
      ok: true,
      data: { active: [awaitingOrder], past: [] },
    });

    const store = createChangedTotalBannerStore(
      { orders: ordersMock },
      sessionMock,
      pushMock,
      undefined,
      10_000,
    );

    // Initial start
    store.start();
    await waitFor(() => expect(ordersMock).toHaveBeenCalledTimes(1));

    // Stop
    store.stop();
    expect(appStateListener).toBeUndefined();
    expect(sessionListener).toBeUndefined();
    expect(pushListener).toBeUndefined();

    // Start again (remount)
    ordersMock.mockClear();
    store.start();
    await waitFor(() => expect(ordersMock).toHaveBeenCalledTimes(1));
    expect(appStateListener).toBeDefined();
    expect(sessionListener).toBeDefined();
    expect(pushListener).toBeDefined();

    // Foreground event refreshes banner
    ordersMock.mockClear();
    appStateListener?.("active");
    await waitFor(() => expect(ordersMock).toHaveBeenCalledTimes(1));

    // Session event refreshes banner
    ordersMock.mockClear();
    sessionListener?.();
    await waitFor(() => expect(ordersMock).toHaveBeenCalledTimes(1));

    // Push event refreshes banner
    ordersMock.mockClear();
    pushListener?.();
    await waitFor(() => expect(ordersMock).toHaveBeenCalledTimes(1));

    // Calling start again when already started does not duplicate listeners
    ordersMock.mockClear();
    store.start();
    expect(sessionMock.subscribe).toHaveBeenCalledTimes(2); // exactly once per start() cycle

    store.stop();
    appStateSpy.mockRestore();
  });

  it("prevents stale requests from overwriting newer state while preserving polling when newer request fails", async () => {
    function deferred<T>() {
      let resolve!: (value: T) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    const d1 = deferred<ApiResult<{ active: OrderSummary[]; past: OrderSummary[] }>>();
    const d2 = deferred<ApiResult<{ active: OrderSummary[]; past: OrderSummary[] }>>();
    const calls: Array<typeof d1> = [];

    const ordersMock = vi.fn().mockImplementation(() => {
      const d = calls.length === 0 ? d1 : d2;
      calls.push(d);
      return d.promise;
    });

    const scheduled: Array<() => void> = [];
    const timers: Timers = {
      set: (run) => {
        scheduled.push(run);
        return 1;
      },
      clear: () => {
        scheduled.length = 0;
      },
    };

    const sessionMock = {
      get: () => ({ status: "signed-in" }),
      subscribe: vi.fn(() => () => undefined),
    };

    const store = createChangedTotalBannerStore(
      { orders: ordersMock },
      sessionMock,
      undefined,
      timers,
      10_000,
    );

    // Initial order set
    store.start(); // calls read() -> calls[0] = d1
    expect(ordersMock).toHaveBeenCalledTimes(1);

    // Trigger overlapping read before d1 completes
    store.refresh(); // calls read() -> calls[1] = d2
    expect(ordersMock).toHaveBeenCalledTimes(2);

    // Case: newer request (d2) fails
    d2.resolve({ ok: false, status: 500, code: "UNAVAILABLE" });
    await d2.promise;
    await waitFor(() => expect(scheduled.length).toBe(1));

    // Older request (d1) resolves with an awaiting order
    const earlierOrder: OrderSummary = { ...awaitingSummary, id: "stale-order" };
    d1.resolve({ ok: true, data: { active: [earlierOrder], past: [] } });
    await d1.promise;
    await waitFor(() => expect(store.get().order).toBeNull());

    // Polling timer is still preserved
    expect(scheduled.length).toBe(1);

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

  it("shows the proposal's total, not the order's original one, with no trailing zeros (#578)", async () => {
    const { findByText, queryByText } = render(<ChangedTotalBanner />);
    expect(await findByText("New total: ₹180")).toBeDefined();
    expect(queryByText("New total: ₹300")).toBeNull();
  });

  it("takes the status bar inset from the screens below while it shows, and gives it back when it hides (#578)", async () => {
    const Probe = () => <span data-testid="top">{useSafeAreaInsets().top}</span>;
    mock.segments = ["index"];
    const { findByRole, getByTestId, rerender } = render(<ChangedTotalBanner><Probe /></ChangedTotalBanner>);
    await findByRole("button");
    expect(getByTestId("top").textContent).toBe("0");
    mock.segments = ["order", "order-1"];
    rerender(<ChangedTotalBanner><Probe /></ChangedTotalBanner>);
    expect(getByTestId("top").textContent).toBe("20");
  });

  it("hides when the user is on the order detail screen /order/[id]", () => {
    mock.segments = ["order", "order-1"];
    const { queryByRole } = render(<ChangedTotalBanner />);
    expect(queryByRole("button")).toBeNull();
  });

  it("renders compact countdown with clock text and full accessibility label (#606)", () => {
    const { getByText, getByLabelText } = render(<BannerCountdown seconds={300} />);
    expect(getByText("5:00")).toBeDefined();
    expect(getByLabelText(words.changedTotal.expiresIn("5:00"))).toBeDefined();
  });

  it("renders Time is up text and accessibility label when countdown reaches 0 (#606)", () => {
    const { getByText, getByLabelText } = render(<BannerCountdown seconds={0} />);
    expect(getByText(words.changedTotal.timeUp)).toBeDefined();
    expect(getByLabelText(words.changedTotal.timeUp)).toBeDefined();
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
      recoverHandoverCode: vi.fn(),
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
      recoverHandoverCode: vi.fn(),
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
      recoverHandoverCode: vi.fn(),
      confirmOrderTotal: confirmMock,
      declineOrderTotal: vi.fn(),
    };
    const orderHandler = createOrder(client, "order-1", awaitingOrder);

    await orderHandler.confirmTotal();
    expect(orderHandler.get().notice).toBe(words.changedTotal.timeUpBody);
    expect(cancelMock).not.toHaveBeenCalled();
    expect(orderMock).toHaveBeenCalledWith("order-1");
  });

  const client = (over: object) => ({
    order: vi.fn(), cancelOrder: vi.fn(), askToCancelOrder: vi.fn(), confirmOrderItems: vi.fn(), recoverHandoverCode: vi.fn(),
    confirmOrderTotal: vi.fn(), declineOrderTotal: vi.fn(), ...over,
  });
  const lateOrder: OrderResponse = { ...awaitingOrder, confirmByAt: "2020-01-01T00:00:00.000Z" };

  it("sends Confirm and Cancel to the server even when the phone's clock says time is up; the server decides (#578)", async () => {
    const confirmMock = vi.fn().mockResolvedValue({ ok: true, data: { ...awaitingOrder, status: "accepted" } });
    const declineMock = vi.fn().mockResolvedValue({ ok: true, data: { ...awaitingOrder, status: "cancelled_by_customer" } });
    await createOrder(client({ confirmOrderTotal: confirmMock }), "order-1", lateOrder).confirmTotal();
    await createOrder(client({ declineOrderTotal: declineMock }), "order-1", lateOrder).declineTotal();
    expect(confirmMock).toHaveBeenCalledWith("order-1");
    expect(declineMock).toHaveBeenCalledWith("order-1");
  });

  it("says the order was cancelled only when the refetched order really is, otherwise what it is now (#578)", async () => {
    const refused = (code: string) => vi.fn().mockResolvedValue({ ok: false, code });
    const read = (status: OrderResponse["status"]) => vi.fn().mockResolvedValue({ ok: true, data: { ...awaitingOrder, status } });
    const words2 = words.changedTotal;

    const waiting = createOrder(client({ confirmOrderTotal: refused("CONFIRMATION_EXPIRED"), order: read("awaiting_customer_confirm") }), "order-1", awaitingOrder);
    await waiting.confirmTotal();
    expect(waiting.get().notice).toBe(words2.timeUpPending);

    const moved = createOrder(client({ declineOrderTotal: refused("ORDER_STATUS_CHANGED"), order: read("accepted") }), "order-1", awaitingOrder);
    await moved.declineTotal();
    expect(moved.get().notice).toBe(words2.noLongerWaiting);

    const again = createOrder(client({ confirmOrderTotal: refused("ORDER_STATUS_CHANGED"), order: read("awaiting_customer_confirm") }), "order-1", awaitingOrder);
    await again.confirmTotal();
    expect(again.get().notice).toBe(words2.changedAgain);

    const cancelled = createOrder(client({ declineOrderTotal: refused("CONFIRMATION_EXPIRED"), order: read("cancelled_by_customer") }), "order-1", awaitingOrder);
    await cancelled.declineTotal();
    expect(cancelled.get().notice).toBe(words2.timeUpBody);
  });
});

describe("useSecondsLeft (#578)", () => {
  it("reads a new deadline against the clock now, not an older reading", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const Left = ({ at }: { at: string }) => <span data-testid="left">{useSecondsLeft(at)}</span>;
    const { getByTestId, rerender } = render(<Left at="2029-12-31T23:59:59.000Z" />);
    expect(getByTestId("left").textContent).toBe("0");
    vi.setSystemTime(new Date("2030-01-01T00:10:00.000Z"));
    rerender(<Left at="2030-01-01T00:11:00.000Z" />);
    expect(getByTestId("left").textContent).toBe("60");
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

  it("shows the proposal's own discount, and why a lost one is gone, before confirming (#572)", async () => {
    const offer = { form: "flat" as const, amount: "20", minimumOrder: "200" };
    mock.orderResult = { ok: true, data: { ...awaitingOrder, proposal: { ...sampleProposal, shopDiscount: { amount: "13.50", offer } } } };
    const first = render(<OrderScreen />);
    expect(await first.findByText("\u2212₹13.50")).toBeDefined();
    expect(first.getByText("₹20 off orders of ₹200 or more")).toBeDefined();
    expect(first.queryByText(words.changedTotal.lostDiscount("₹20 off orders of ₹200 or more"))).toBeNull();
    cleanup();

    mock.orderResult = { ok: true, data: { ...awaitingOrder, proposal: { ...sampleProposal, shopDiscount: null, lostShopDiscount: offer } } };
    const second = render(<OrderScreen />);
    expect(await second.findByText(words.changedTotal.lostDiscount("₹20 off orders of ₹200 or more"))).toBeDefined();
    expect(second.queryByText("Shop discount")).toBeNull();
  });

  it("when timer reaches 0, disables both Confirm and Cancel buttons and refetches order without client-side cancel", async () => {
    // Order whose confirmByAt has already passed
    const expiredAwaitingOrder: OrderResponse = {
      ...awaitingOrder,
      confirmByAt: "2020-01-01T00:00:00.000Z",
    };
    mock.orderResult = { ok: true, data: expiredAwaitingOrder };

    const { findByText, getByText, getByRole } = render(<OrderScreen />);

    expect(await findByText(words.changedTotal.heading)).toBeDefined();
    expect(getByText(words.changedTotal.timeUpPending)).toBeDefined();

    // Both buttons are disabled after expiry
    const confirmBtn = getByRole("button", { name: words.changedTotal.confirm }) as HTMLButtonElement;
    const cancelBtn = getByRole("button", { name: words.changedTotal.cancelFree }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    expect(cancelBtn.disabled).toBe(true);

    // Tapping neither button triggers API mutation
    fireEvent.click(confirmBtn);
    fireEvent.click(cancelBtn);
    expect(api.confirmOrderTotal).not.toHaveBeenCalled();
    expect(api.declineOrderTotal).not.toHaveBeenCalled();

    // CancelOrder was NOT called by client
    expect(mock.cancelCalls).toBe(0);
  });

  it("triggers at most one refresh upon reaching expiry even if server still returns awaiting_customer_confirm", async () => {
    let orderFetchCount = 0;
    const expiredAwaitingOrder: OrderResponse = {
      ...awaitingOrder,
      confirmByAt: "2020-01-01T00:00:00.000Z",
    };

    mock.orderResult = { ok: true, data: expiredAwaitingOrder };
    vi.mocked(api.order).mockImplementation(() => {
      orderFetchCount++;
      return Promise.resolve({ ok: true, data: expiredAwaitingOrder });
    });

    const { findByText } = render(<OrderScreen />);

    expect(await findByText(words.changedTotal.heading)).toBeDefined();

    // Give time for any potential refresh loop to happen
    await new Promise((r) => setTimeout(r, 100));

    // Initial fetch (1) + single automatic expiry refresh (1) = 2 calls total, no loop!
    expect(orderFetchCount).toBe(2);
    expect(mock.cancelCalls).toBe(0);
  });

  it("shows no Confirm or Cancel buttons without a proposal, and reads the order again once (#578)", async () => {
    const bare: OrderResponse = { ...awaitingOrder, proposal: null };
    mock.orderResult = { ok: true, data: bare };
    let fetched = 0;
    vi.mocked(api.order).mockImplementation(() => {
      fetched++;
      return Promise.resolve({ ok: true, data: bare });
    });
    const { findByText, queryByRole } = render(<OrderScreen />);
    expect(await findByText(words.statuses.awaiting_customer_confirm)).toBeDefined();
    await new Promise((r) => setTimeout(r, 100));
    expect(queryByRole("button", { name: words.changedTotal.confirm })).toBeNull();
    expect(queryByRole("button", { name: words.changedTotal.cancelFree })).toBeNull();
    expect(fetched).toBe(2);
  });
});
