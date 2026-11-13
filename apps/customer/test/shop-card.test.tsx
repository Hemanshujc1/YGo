// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeedQuery, FeedShop } from "@ygo/contracts";

const mock = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return {
    View: ({ children, accessibilityLabel, className }: { children?: ReactNode; accessibilityLabel?: string; className?: string }) =>
      createElement("div", { "aria-label": accessibilityLabel, className }, children),
    Pressable: ({ children, onPress, className }: { children?: ReactNode; onPress?: () => void; className?: string }) =>
      createElement("button", { onClick: onPress, className }, children),
  };
});

vi.mock("@ygo/mobile", async () => {
  const { createElement } = await import("react");
  return {
    Text: ({ children, className }: { children?: ReactNode; className?: string }) =>
      createElement("span", { className }, children),
  };
});

vi.mock("expo-router", () => ({
  router: { push: mock.push },
}));

vi.mock("../src/components/icons", () => ({
  Star: () => <span data-testid="star-icon">★</span>,
}));

import { ShopCard } from "../src/components/shop-card";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ShopCard rating display (DSC-2, #82)", () => {
  const query: FeedQuery = { latitude: 12.9716, longitude: 77.5946, pincode: "560001" };
  const baseShop: FeedShop = {
    id: "8f7c3a52-2a3e-4e0b-9f1d-3c5b7a6e4d21",
    name: "Sai General Stores",
    estimatedMinutes: 15,
    deliveryFee: "30",
    delivers: true,
    pickup: false,
    open: true,
    opensAt: null,
    holiday: false,
    rating: null,
  };

  it("does not show rating badge when shop.rating is null", () => {
    const { queryByLabelText, queryByTestId } = render(
      <ShopCard shop={baseShop} query={query} now={Date.now()} />
    );
    expect(queryByTestId("star-icon")).toBeNull();
    expect(queryByLabelText(/star/i)).toBeNull();
  });

  it("shows formatted rating and star icon when shop.rating is present", () => {
    const { getByLabelText, getByTestId, getByText } = render(
      <ShopCard shop={{ ...baseShop, rating: 4.5 }} query={query} now={Date.now()} />
    );
    expect(getByTestId("star-icon")).toBeDefined();
    expect(getByLabelText("4.5 stars")).toBeDefined();
    expect(getByText("4.5")).toBeDefined();
  });

  it("formats integer rating with no trailing zero", () => {
    const { getByLabelText, getByText } = render(
      <ShopCard shop={{ ...baseShop, rating: 5 }} query={query} now={Date.now()} />
    );
    expect(getByLabelText("5 stars")).toBeDefined();
    expect(getByText("5")).toBeDefined();
  });
});
