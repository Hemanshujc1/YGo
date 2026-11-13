// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderResponse } from "@ygo/contracts";

vi.stubGlobal("__DEV__", false);

const mock = vi.hoisted(() => ({
  back: vi.fn(),
  canGoBack: vi.fn(() => true),
  rateOrder: vi.fn(),
  order: vi.fn(),
  orderResult: null as unknown,
  refresh: vi.fn(),
  retry: vi.fn(),
}));

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return {
    ActivityIndicator: () => createElement("div", { "data-testid": "spinner" }),
    Pressable: ({
      children,
      onPress,
      accessibilityLabel,
      accessibilityRole,
      accessibilityState,
      disabled,
      className,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      accessibilityLabel?: string;
      accessibilityRole?: string;
      accessibilityState?: { selected?: boolean };
      disabled?: boolean;
      className?: string;
    }) =>
      createElement(
        "button",
        {
          onClick: disabled ? undefined : onPress,
          "aria-label": accessibilityLabel,
          role: accessibilityRole,
          "aria-selected": accessibilityState?.selected,
          disabled,
          className,
        },
        children,
      ),
    ScrollView: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
    View: ({ children, className, style }: { children?: ReactNode; className?: string; style?: unknown }) =>
      createElement("div", { className, style }, children),
  };
});

vi.mock("react-native-safe-area-context", async () => {
  const { createContext, useContext } = await import("react");
  const SafeAreaInsetsContext = createContext({ top: 20, bottom: 0, left: 0, right: 0 });
  return { SafeAreaInsetsContext, useSafeAreaInsets: () => useContext(SafeAreaInsetsContext) };
});

vi.mock("@ygo/mobile", async () => {
  const { createElement } = await import("react");
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
    Text: ({ children, className }: { children?: ReactNode; className?: string }) =>
      createElement("span", { className }, children),
  };
});

vi.mock("expo-router", () => ({
  router: { back: mock.back, canGoBack: mock.canGoBack },
  useLocalSearchParams: () => ({ id: "order-123" }),
}));

vi.mock("../src/api", () => ({
  api: {
    rateOrder: mock.rateOrder,
    order: mock.order,
  },
}));

vi.mock("../src/components/icons", () => ({
  ChevronLeft: () => <span>←</span>,
  Star: ({ color, fill }: { color?: string; fill?: string }) => (
    <span data-testid="star" data-color={color} data-fill={fill}>
      ★
    </span>
  ),
}));

vi.mock("../src/lib/use-order", () => ({
  useOrder: () => ({
    order: {
      refresh: mock.refresh,
      retry: mock.retry,
      get: () => mock.orderResult,
    },
    view: mock.orderResult,
  }),
}));

import RateScreen from "../src/app/order/[id]/rate";

const baseOrder: OrderResponse = {
  id: "order-123",
  number: 101,
  status: "delivered",
  placedAt: "2026-03-31T10:00:00.000Z",
  shop: {
    id: "shop-123",
    name: "Sai General Stores",
    phone: "9876543210",
  },
  fulfilment: "delivery",
  address: { label: "home", flat: "Flat 101", areaLine: null, pincode: "560001" },
  lines: [],
  productValue: "200.00",
  shopDiscount: null,
  deliveryFee: "30.00",
  smallCartFee: null,
  pickupFee: null,
  total: "230.00",
  rejectReason: null,
  answerExpired: false,
  handoverCode: null,
  handoverLocked: false,
  itemsCheckedAt: null,
  confirmByAt: null,
  proposal: null,
  cancelRequest: null,
  rating: null,
};

describe("C20 Rate screen (TRU-1, #82)", () => {
  beforeEach(() => {
    mock.orderResult = { status: "ready", order: baseOrder };
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders rate prompt and 5 star buttons", () => {
    const { getByText, getByRole } = render(<RateScreen />);
    expect(getByText("Rate your order")).toBeDefined();
    expect(getByText("How was your order from Sai General Stores?")).toBeDefined();
    expect(getByRole("button", { name: "1 star" })).toBeDefined();
    expect(getByRole("button", { name: "5 stars" })).toBeDefined();
    expect(getByRole("button", { name: "Not now" })).toBeDefined();
    const submitBtn = getByRole("button", { name: "Submit rating" });
    expect(submitBtn).toBeDefined();
    expect(submitBtn.hasAttribute("disabled")).toBe(true);
  });

  it("tapping 'Not now' calls router.back() without storing anything", () => {
    const { getByRole } = render(<RateScreen />);
    fireEvent.click(getByRole("button", { name: "Not now" }));
    expect(mock.back).toHaveBeenCalledTimes(1);
    expect(mock.rateOrder).not.toHaveBeenCalled();
  });

  it("enables submit on selecting stars and submits rating", async () => {
    mock.rateOrder.mockResolvedValueOnce({
      ok: true,
      data: {
        id: "rating-1",
        orderId: "order-123",
        stars: 4,
        createdAt: "2026-03-31T10:30:00.000Z",
      },
    });

    const { getByRole, getByText } = render(<RateScreen />);
    const star4 = getByRole("button", { name: "4 stars" });
    fireEvent.click(star4);

    const submitBtn = getByRole("button", { name: "Submit rating" });
    expect(submitBtn.hasAttribute("disabled")).toBe(false);

    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(mock.rateOrder).toHaveBeenCalledWith("order-123", { stars: 4 });
      expect(mock.refresh).toHaveBeenCalled();
    });

    // Rated state
    expect(getByText("Thank you for rating!")).toBeDefined();
    expect(getByText("Your rating helps others discover good local shops.")).toBeDefined();
    const doneBtn = getByRole("button", { name: "Done" });
    fireEvent.click(doneBtn);
    expect(mock.back).toHaveBeenCalledTimes(1);
  });

  it("renders rated state directly if order already has rating", () => {
    mock.orderResult = { status: "ready", order: { ...baseOrder, rating: 5 } };
    const { getByText, getByRole, queryByText } = render(<RateScreen />);

    expect(queryByText("How was your order from Sai General Stores?")).toBeNull();
    expect(getByText("Thank you for rating!")).toBeDefined();
    expect(getByText("You rated this order 5 stars")).toBeDefined();
    expect(getByRole("button", { name: "Done" })).toBeDefined();
  });

  it("prevents the rating form from appearing for unfinished orders", () => {
    mock.orderResult = { status: "ready", order: { ...baseOrder, status: "accepted" } };
    const { getByText, getByRole, queryByText, queryByRole } = render(<RateScreen />);

    expect(queryByText("How was your order from Sai General Stores?")).toBeNull();
    expect(queryByRole("button", { name: "Submit rating" })).toBeNull();
    expect(queryByRole("button", { name: "1 star" })).toBeNull();
    expect(getByText("You can rate this order once it is delivered or collected.")).toBeDefined();

    const doneBtn = getByRole("button", { name: "Done" });
    fireEvent.click(doneBtn);
    expect(mock.back).toHaveBeenCalledTimes(1);
  });

  it("prevents the rating form from appearing for cancelled orders", () => {
    mock.orderResult = { status: "ready", order: { ...baseOrder, status: "cancelled_by_customer" } };
    const { getByText, queryByText, queryByRole } = render(<RateScreen />);

    expect(queryByText("How was your order from Sai General Stores?")).toBeNull();
    expect(queryByRole("button", { name: "Submit rating" })).toBeNull();
    expect(getByText("You can rate this order once it is delivered or collected.")).toBeDefined();
  });

  it("handles duplicate ratings using the actual saved rating", async () => {
    mock.rateOrder.mockResolvedValueOnce({
      ok: false,
      code: "RATING_ALREADY_GIVEN",
      status: 409,
    });
    mock.refresh.mockImplementation(() => {
      mock.orderResult = { status: "ready", order: { ...baseOrder, rating: 5 } };
    });

    const { getByRole, getByText, queryByText } = render(<RateScreen />);
    fireEvent.click(getByRole("button", { name: "2 stars" }));
    fireEvent.click(getByRole("button", { name: "Submit rating" }));

    await waitFor(() => {
      expect(mock.refresh).toHaveBeenCalled();
      // Must use actual saved rating (5 stars), never the tapped 2 stars!
      expect(getByText("You rated this order 5 stars")).toBeDefined();
      expect(queryByText("You rated this order 2 stars")).toBeNull();
    });
  });

  it("shows error banner when rating submission fails with server error", async () => {
    mock.rateOrder.mockResolvedValueOnce({
      ok: false,
      code: "INTERNAL_ERROR",
      status: 500,
    });

    const { getByRole, getByText } = render(<RateScreen />);
    fireEvent.click(getByRole("button", { name: "3 stars" }));
    fireEvent.click(getByRole("button", { name: "Submit rating" }));

    await waitFor(() => {
      expect(getByText("Could not save rating. Please try again.")).toBeDefined();
    });
  });
});
