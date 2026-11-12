// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { AdminOrderDetail } from "@ygo/contracts";
import { OrderDetail } from "./order-detail";
import { strings } from "./strings";

afterEach(() => cleanup());

const id = "00000000-0000-4000-8000-000000000001";
const detail = (extra: Partial<AdminOrderDetail> = {}, order: Partial<AdminOrderDetail["order"]> = {}): AdminOrderDetail => ({
  order: { id, number: 1001, shopId: "00000000-0000-4000-8000-000000000a01", shopName: "Sai General Stores", customerName: "Meera", fulfilment: "delivery", status: "placed",
    placedAt: "2030-01-01T10:00:00.000Z", statusChangedAt: "2030-01-01T10:00:00.000Z", total: "150.00", statusAgeSeconds: 200, unanswered: true, ...order },
  lines: [{ name: "Atta", brand: "Aashirvaad", count: 2, partQuantity: null, packQuantity: "1.000", baseUnit: "kg", unitPrice: "65.00", lineTotal: "130.00" }],
  money: { productValue: "130.00", shopDiscount: "0.00", deliveryFee: "20.00", smallCartFee: null, pickupFee: null, total: "150.00" },
  breakdown: { rateCardVersion: "3", sources: { commission: { type: "global", id: null, version: "3" } }, commission: "13.00",
    deliveryFee: { amount: "20.00", platformShare: "10.00", shopShare: "10.00" }, smallCartFee: null, shopKeeps: "117.00", platformContribution: "23.00", reasons: [] },
  timeline: [{ at: "2030-01-01T10:00:00.000Z", from: null, to: "placed", actorRole: "customer", actorName: "Meera", reasonCode: null }],
  forcedActions: [],
  people: { customerName: "Meera", delivererName: null },
  forcedMoves: ["rejected_by_shop", "expired", "cancelled_by_shop"],
  ...extra,
});
const ok = <T,>(data: T) => ({ ok: true as const, data });

function setup(first: AdminOrderDetail, role = "admin") {
  const api = { currentRole: vi.fn(() => role), forceOrderTransition: vi.fn(), getAdminOrder: vi.fn() };
  const router = createMemoryRouter([{ path: "/", loader: () => first, element: <OrderDetail api={api as unknown as Parameters<typeof OrderDetail>[0]["api"]} /> }]);
  render(<RouterProvider router={router} />);
  return api;
}

describe("A15 Order detail and forced transition (ADM-4, ORD-1, MNY-7, #66)", () => {
  it("shows frozen lines and money, the breakdown with its sources, the timeline and the people, with no trailing zeros", async () => {
    setup(detail());
    await screen.findByRole("heading", { name: "Order #1001" });
    const text = document.body.textContent ?? "";
    expect(text).toContain("Atta");
    expect(text).toContain("1 kg");
    expect(text).not.toContain("1.000");
    expect(text).toContain("₹65");
    expect(text).not.toContain("65.00");
    expect(text).toContain("₹117");
    expect(text).toContain("commission: global card, version 3");
    expect(text).toContain("YGo ₹10, shop ₹10");
    expect(text).toContain(`Placed: ${strings.orderStatuses.placed}`);
    expect(text).toContain("Meera");
  });

  it("explains a missing breakdown for an older order", async () => {
    setup(detail({ breakdown: null }));
    expect(await screen.findByText(strings.orderDetailBreakdownMissing)).toBeTruthy();
  });

  it("lists only the moves the server offers, and asks for a reason before forcing", async () => {
    const api = setup(detail());
    api.forceOrderTransition.mockResolvedValue(ok(detail({ forcedMoves: [], forcedActions: [{ at: "2030-01-01T10:05:00.000Z", adminName: "Asha", from: "placed", to: "expired", reason: "Shop phone is off" }] }, { status: "expired" })));
    await screen.findByRole("heading", { name: strings.orderForceTitle });
    expect(screen.getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value)).toEqual(["rejected_by_shop", "expired", "cancelled_by_shop"]);
    expect((screen.getByRole("button", { name: strings.orderForceStart }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: strings.orderStatuses.expired }));
    fireEvent.click(screen.getByRole("button", { name: strings.orderForceStart }));
    // An empty reason is refused here and nothing is sent.
    fireEvent.click(screen.getByRole("button", { name: strings.orderForceConfirm }));
    expect((await screen.findByRole("alert")).textContent).toBe(strings.orderForceReasonRequired);
    expect(api.forceOrderTransition).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(strings.reason), { target: { value: "  Shop phone is off  " } });
    fireEvent.click(screen.getByRole("button", { name: strings.orderForceConfirm }));
    await waitFor(() => expect(api.forceOrderTransition).toHaveBeenCalledWith(id, { from: "placed", to: "expired", reason: "Shop phone is off" }));
    // Forced: the closed order offers nothing more, and the audit reason shows.
    expect(await screen.findByText(strings.orderForceNone)).toBeTruthy();
    expect(screen.getByText("Shop phone is off")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reloads the order and says so when it changed while Admin was looking", async () => {
    const api = setup(detail());
    api.forceOrderTransition.mockResolvedValue({ ok: false, status: 409, code: "ORDER_STATUS_CHANGED" });
    api.getAdminOrder.mockResolvedValue(ok(detail({ forcedMoves: ["cancelled_by_shop"] }, { status: "accepted" })));
    fireEvent.click(await screen.findByRole("radio", { name: strings.orderStatuses.expired }));
    fireEvent.click(screen.getByRole("button", { name: strings.orderForceStart }));
    fireEvent.change(screen.getByLabelText(strings.reason), { target: { value: "Stuck" } });
    fireEvent.click(screen.getByRole("button", { name: strings.orderForceConfirm }));
    expect((await screen.findByRole("alert")).textContent).toBe(strings.orderForceStale);
    await waitFor(() => expect(screen.getAllByRole("radio")).toHaveLength(1));
    expect(screen.getAllByText(strings.orderStatuses.accepted).length).toBeGreaterThan(0);
  });

  it("offers a final order no move", async () => {
    setup(detail({ forcedMoves: [] }, { status: "delivered" }));
    expect(await screen.findByText(strings.orderForceNone)).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("gives an Area Manager the order to look at and no way to force it", async () => {
    setup(detail({ forcedMoves: [] }), "area_manager");
    expect(await screen.findByText(strings.orderForceViewOnly)).toBeTruthy();
    expect(screen.queryByRole("button", { name: strings.orderForceStart })).toBeNull();
    expect(screen.queryByRole("heading", { name: strings.orderForceTitle })).toBeNull();
  });
});
