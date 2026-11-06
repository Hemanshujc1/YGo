// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ syncAccess: vi.fn(), push: vi.fn() }));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return {
    View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
    Pressable: ({ children, onPress, accessibilityLabel }: { children?: ReactNode; onPress: () => void; accessibilityLabel: string }) => createElement("button", { onClick: onPress, "aria-label": accessibilityLabel }, children),
  };
});
vi.mock("@ygo/mobile", async () => {
  const { createElement } = await import("react");
  return { Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children) };
});
vi.mock("expo-router", () => ({ router: { push: mock.push } }));
vi.mock("../src/api", () => ({ api: { syncAccess: mock.syncAccess } }));
import { ShopLink } from "../src/components/shop-link";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("C23 shop link (ACC-4, #536)", () => {
  it("offers Join a shop to an account with no shop and opens S21", async () => {
    mock.syncAccess.mockResolvedValue({ ok: true, data: { shopId: null, state: null, shopName: null, shopGstin: null, role: null } });
    const { findByLabelText } = render(<ShopLink />);
    fireEvent.click(await findByLabelText("Join a shop"));
    expect(mock.push).toHaveBeenCalledWith("/join-shop");
  });

  it("tells a linked account which shop it works at, with no join button", async () => {
    mock.syncAccess.mockResolvedValue({ ok: true, data: { shopId: "7d2e9a4c-6b1f-4c3a-8e5d-0f2a4b6c8d1e", state: "live", shopName: "Sai General Stores", shopGstin: null, role: "staff" } });
    const { findByText, queryByLabelText } = render(<ShopLink />);
    await findByText(/You work at Sai General Stores/);
    expect(queryByLabelText("Join a shop")).toBeNull();
  });

  it("shows nothing while the server is silent or unreachable", async () => {
    mock.syncAccess.mockRejectedValue(new Error("down"));
    const { container } = render(<ShopLink />);
    await waitFor(() => expect(mock.syncAccess).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });
});
