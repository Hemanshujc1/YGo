// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { AdminOrderRow, AdminOrdersResponse } from "@ygo/contracts";
import { LiveOrders, POLL_MS } from "./live-orders";
import { strings } from "./strings";

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const shopA = "00000000-0000-4000-8000-000000000a01";
const shopB = "00000000-0000-4000-8000-000000000a02";

const row = (n: number, extra: Partial<AdminOrderRow> = {}): AdminOrderRow => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  number: 1000 + n,
  shopId: shopA,
  shopName: "Sai General Stores",
  customerName: "Meera",
  fulfilment: "delivery",
  status: "placed",
  placedAt: `2030-01-01T10:0${n}:00.000Z`,
  statusChangedAt: `2030-01-01T10:0${n}:00.000Z`,
  total: "150.00",
  statusAgeSeconds: 30,
  unanswered: false,
  cursor: `2030-01-01T10:0${n}:00.000000Z|00000000-0000-4000-8000-00000000000${n}`,
  ...extra,
});

const page = (orders: AdminOrderRow[], extra: Partial<AdminOrdersResponse> = {}): AdminOrdersResponse => ({
  orders, nextCursor: null, counts: { active: 3, unanswered: 1 }, serverTime: "2030-01-01T10:10:00.000Z", unansweredAfterSeconds: 120, ...extra,
});
const ok = <T,>(data: T) => ({ ok: true as const, data });

function setup(first: AdminOrdersResponse) {
  const api = { listAdminOrders: vi.fn(), currentRole: vi.fn(() => "admin") };
  const router = createMemoryRouter([{ path: "/", loader: () => first, element: <LiveOrders api={api as unknown as Parameters<typeof LiveOrders>[0]["api"]} /> }]);
  render(<RouterProvider router={router} />);
  return api;
}

describe("A14 Live orders screen (ADM-4, ADM-7, #66)", () => {
  it("lists orders with the status pill, age, total without trailing zeros, and the unanswered mark", async () => {
    setup(page([row(1, { unanswered: true, statusAgeSeconds: 130 }), row(2, { status: "preparing", total: "99.50", fulfilment: "pickup", customerName: null })]));
    await screen.findByRole("heading", { name: strings.liveOrders });
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("#1001");
    expect(rows[0]?.textContent).toContain(strings.orderStatuses.placed);
    expect(rows[0]?.textContent).toContain(strings.liveOrdersUnansweredTag);
    expect(rows[0]?.textContent).toContain("2 min");
    expect(rows[0]?.textContent).toContain("₹150");
    expect(rows[0]?.textContent).not.toContain("150.00");
    expect(rows[1]?.textContent).toContain("₹99.50");
    expect(rows[1]?.textContent).toContain(strings.fulfilment.pickup);
    expect(rows[1]?.textContent).not.toContain(strings.liveOrdersUnansweredTag);
    expect(screen.getByRole("link", { name: "#1001" }).getAttribute("href")).toBe("/orders/00000000-0000-4000-8000-000000000001");
  });

  it("shows the chips with the server's counts and the re-alert time from the server", async () => {
    setup(page([row(1)], { counts: { active: 7, unanswered: 2 }, unansweredAfterSeconds: 120 }));
    expect(await screen.findByRole("tab", { name: "Active 7" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Unanswered at 2 min 2" })).toBeTruthy();
  });

  it("asks the server for the chosen group and shop", async () => {
    const api = setup(page([row(1), row(2, { shopId: shopB, shopName: "Kothrud Mart" })]));
    api.listAdminOrders.mockResolvedValue(ok(page([row(3)])));
    fireEvent.click(await screen.findByRole("tab", { name: "Unanswered at 2 min 1" }));
    await waitFor(() => expect(api.listAdminOrders).toHaveBeenLastCalledWith({ group: "unanswered" }));
    fireEvent.change(screen.getByLabelText(strings.liveOrdersFilterShop), { target: { value: shopB } });
    await waitFor(() => expect(api.listAdminOrders).toHaveBeenLastCalledWith({ group: "unanswered", shopId: shopB }));
  });

  it("polls every 10 seconds and shows what changed, keeping the pages already loaded", async () => {
    const api = setup(page([row(3), row(2)], { nextCursor: row(2).cursor }));
    api.listAdminOrders.mockResolvedValueOnce(ok(page([row(3, { status: "accepted" }), row(2)], { nextCursor: row(2).cursor })));
    api.listAdminOrders.mockResolvedValueOnce(ok(page([row(1)])));
    await screen.findByRole("heading", { name: strings.liveOrders });
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });
    expect(api.listAdminOrders).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getAllByText(strings.orderStatuses.accepted).length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: strings.liveOrdersMore }));
    await waitFor(() => expect(screen.getByText("#1001")).toBeTruthy());
    expect(api.listAdminOrders).toHaveBeenLastCalledWith({ group: "active", cursor: row(2).cursor });
    // A poll after paging updates the rows it knows and does not drop the older page.
    api.listAdminOrders.mockResolvedValueOnce(ok(page([row(3, { status: "ready" }), row(2), row(1, { status: "preparing" })])));
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });
    await waitFor(() => expect(screen.getAllByText(strings.orderStatuses.ready).length).toBeGreaterThan(0));
    // The older page is refreshed too, not left as it was.
    expect(screen.getAllByText(strings.orderStatuses.preparing).length).toBeGreaterThan(0);
    expect(screen.getByText("#1001")).toBeTruthy();
  });

  it("refreshes on the Refresh button and shows an alert when a load fails", async () => {
    const api = setup(page([row(1)]));
    api.listAdminOrders.mockResolvedValue({ ok: false, status: 500, code: "INTERNAL" });
    fireEvent.click(await screen.findByRole("button", { name: strings.liveOrdersRefresh }));
    expect((await screen.findByRole("alert")).textContent).toBe(strings.liveOrdersLoadFailed);
  });

  it("says so when nothing matches", async () => {
    setup(page([]));
    expect(await screen.findByText(strings.liveOrdersEmpty)).toBeTruthy();
  });
});
