// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ syncAccess: vi.fn(), push: vi.fn(), focus: null as null | (() => (() => void) | undefined) }));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return {
    View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
    Pressable: ({ children, onPress, accessibilityLabel }: { children?: ReactNode; onPress: () => void; accessibilityLabel: string }) => createElement("button", { onClick: onPress, "aria-label": accessibilityLabel }, children),
  };
});
vi.mock("@ygo/mobile", async () => {
  const { createElement } = await import("react");
  return {
    shopkeeperAppUrl: "ygo-shopkeeper://",
    Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
    // The real row is a Pressable that opens the link; the test only needs its title, body and link.
    SwitchApp: ({ title, body, url }: { title: string; body: string; url: string }) => createElement("a", { "aria-label": title, href: url }, body),
  };
});
vi.mock("expo-router", async () => {
  const { useEffect } = await import("react");
  return {
    router: { push: mock.push },
    // Runs the effect on mount like a first focus; the test calls mock.focus() to focus the screen again.
    useFocusEffect: (effect: () => (() => void) | undefined) => { mock.focus = effect; useEffect(effect, [effect]); },
  };
});
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

  it.each(["owner", "staff"] as const)("offers Switch to shop, naming the shop, to a linked %s and no Join button", async (role) => {
    mock.syncAccess.mockResolvedValue({ ok: true, data: { shopId: "7d2e9a4c-6b1f-4c3a-8e5d-0f2a4b6c8d1e", state: "live", shopName: "Sai General Stores", shopGstin: null, role } });
    const { findByLabelText, queryByLabelText } = render(<ShopLink />);
    const row = await findByLabelText("Switch to shop");
    expect(row.textContent).toBe("Sai General Stores");
    expect(row.getAttribute("href")).toBe("ygo-shopkeeper://");
    expect(queryByLabelText("Join a shop")).toBeNull();
  });

  it("shows Join a shop, not Switch to shop, once Staff are deactivated (the server then reports no shop)", async () => {
    mock.syncAccess.mockResolvedValue({ ok: true, data: { shopId: null, state: null, shopName: null, shopGstin: null, role: null } });
    const { findByLabelText, queryByLabelText } = render(<ShopLink />);
    await findByLabelText("Join a shop");
    expect(queryByLabelText("Switch to shop")).toBeNull();
  });

  it("shows nothing while the server is silent or unreachable", async () => {
    mock.syncAccess.mockRejectedValue(new Error("down"));
    const { container } = render(<ShopLink />);
    await waitFor(() => expect(mock.syncAccess).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("shows the shop on coming back from S21 after joining, not the stale Join button", async () => {
    mock.syncAccess.mockResolvedValueOnce({ ok: true, data: { shopId: null, state: null, shopName: null, shopGstin: null, role: null } });
    const { findByLabelText, queryByLabelText } = render(<ShopLink />);
    await findByLabelText("Join a shop");
    mock.syncAccess.mockResolvedValueOnce({ ok: true, data: { shopId: "7d2e9a4c-6b1f-4c3a-8e5d-0f2a4b6c8d1e", state: "live", shopName: "Sai General Stores", shopGstin: null, role: "staff" } });
    act(() => { mock.focus?.(); });
    await findByLabelText("Switch to shop");
    expect(queryByLabelText("Join a shop")).toBeNull();
  });
});
