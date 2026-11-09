// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { BelowFloorException, BelowFloorExceptionsResponse } from "@ygo/contracts";
import { formatDateTime } from "@ygo/format";
import { BelowFloorExceptions } from "./below-floor-exceptions";
import { strings } from "./strings";

afterEach(() => cleanup());

const shopA = "00000000-0000-4000-8000-000000000a01";
const shopB = "00000000-0000-4000-8000-000000000a02";
const am1 = "00000000-0000-4000-8000-000000000b01";
const am2 = "00000000-0000-4000-8000-000000000b02";

const row = (n: number, extra: Partial<BelowFloorException> = {}): BelowFloorException => ({
  revisionId: `00000000-0000-4000-8000-00000000rev${n}`,
  orderId: `00000000-0000-4000-8000-00000000ord${n}`,
  orderNumber: 1000 + n,
  shopId: shopA,
  shopName: "Sai General Stores",
  placedAt: `2030-01-0${n}T10:00:00.000Z`,
  status: "accepted",
  originalTotal: "100.00",
  revisedTotal: "60.00",
  shortfall: "10.00",
  platformContribution: "15.00",
  reason: null,
  reviewed: null,
  ...extra,
});

const counts: BelowFloorExceptionsResponse["counts"] = {
  open: 2,
  total: 3,
  shops: [
    { shopId: shopA, name: "Sai General Stores", total: 2, open: 1 },
    { shopId: shopB, name: "Kothrud Mart", total: 1, open: 1 },
  ],
  areaManagers: [
    { accountId: am1, name: "Ravi Patil", total: 2, open: 1 },
    { accountId: am2, name: "Sneha Deshmukh", total: 1, open: 1 },
  ],
};

const page = (exceptions: BelowFloorException[], nextCursor: string | null = null): BelowFloorExceptionsResponse => ({
  exceptions,
  nextCursor,
  counts,
});

const ok = <T,>(data: T) => ({ ok: true as const, data });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(first: BelowFloorExceptionsResponse, apiOverrides: Record<string, unknown> = {}) {
  const calls = {
    listBelowFloorExceptions: vi.fn(),
    reviewBelowFloorException: vi.fn(),
    currentRole: vi.fn(() => "admin"),
    ...apiOverrides,
  };
  const router = createMemoryRouter([
    {
      path: "/",
      loader: () => first,
      element: <BelowFloorExceptions api={calls as unknown as Parameters<typeof BelowFloorExceptions>[0]["api"]} />,
    },
  ]);
  render(<RouterProvider router={router} />);
  return calls as {
    listBelowFloorExceptions: ReturnType<typeof vi.fn>;
    reviewBelowFloorException: ReturnType<typeof vi.fn>;
    currentRole: ReturnType<typeof vi.fn>;
  };
}

const table = () => screen.getByRole("table");
const bodyRows = () => within(table()).getAllByRole("row").slice(1);

describe("A30 Below contribution floor exceptions screen (MNY-4, ADM-7, #529)", () => {
  it("renders open exceptions with order #, shop, placed, status, formatted amounts (no trailing zeros), reason and review action", async () => {
    setup(page([
      row(1, { originalTotal: "100.00", revisedTotal: "60.00", shortfall: "9.50", platformContribution: "15.00" }),
      row(2, { shopId: shopB, shopName: "Kothrud Mart", originalTotal: "200.00", revisedTotal: "140.00", shortfall: "8.00", platformContribution: "12.00" }),
    ]));

    await screen.findByRole("heading", { name: strings.belowFloorExceptions });
    const rows = bodyRows();
    expect(rows).toHaveLength(2);

    const first = rows[0];
    expect(first).toBeDefined();
    if (!first) throw new Error("Expected at least one row");
    expect(first.textContent).toContain("#1001");
    expect(first.textContent).toContain("Sai General Stores");
    expect(first.textContent).toContain(formatDateTime("2030-01-01T10:00:00.000Z"));
    expect(first.textContent).toContain(strings.orderStatuses.accepted);
    // No trailing zeros check: ₹100 not ₹100.00, ₹60 not ₹60.00, ₹9.50 (keeps paise), ₹15 not ₹15.00
    expect(first.textContent).toContain("₹100");
    expect(first.textContent).not.toContain("₹100.00");
    expect(first.textContent).toContain("₹60");
    expect(first.textContent).not.toContain("₹60.00");
    expect(first.textContent).toContain("₹9.50");
    expect(first.textContent).toContain("₹15");
    expect(first.textContent).not.toContain("₹15.00");
    expect(first.textContent).toContain(strings.belowFloorReason);

    // Summary counts per shop
    const byShop = screen.getByRole("heading", { name: strings.belowFloorExceptionsPerShop }).closest("section") as HTMLElement;
    expect(byShop.textContent).toContain(`Sai General Stores${strings.belowFloorExceptionsCount(2, 1)}`);
    expect(byShop.textContent).toContain(`Kothrud Mart${strings.belowFloorExceptionsCount(1, 1)}`);

    // Review buttons
    expect(screen.getAllByRole("button", { name: strings.belowFloorExceptionsReview })).toHaveLength(2);
  });

  it("empty states: displays message when no open exceptions are waiting and when no reviewed exceptions exist", async () => {
    setup(page([]));
    expect(await screen.findByText(strings.belowFloorExceptionsNoneOpen)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("switches between Open and Reviewed tabs, asking server for matching status", async () => {
    const calls = setup(page([row(1)]));
    calls.listBelowFloorExceptions.mockResolvedValue(ok(page([
      row(2, { reviewed: { at: "2030-01-05T10:00:00.000Z", by: "Asha Kulkarni" } }),
    ])));

    // Switch to Reviewed tab
    fireEvent.click(await screen.findByRole("tab", { name: strings.belowFloorExceptionsReviewed }));
    await waitFor(() => expect(bodyRows()[0]?.textContent).toContain("Asha Kulkarni"));

    expect(calls.listBelowFloorExceptions).toHaveBeenCalledWith({ status: "reviewed" });
    expect(bodyRows()[0]?.textContent).toContain(
      strings.belowFloorExceptionsReviewedBy("Asha Kulkarni", formatDateTime("2030-01-05T10:00:00.000Z")),
    );
    expect(screen.queryByRole("button", { name: strings.belowFloorExceptionsReview })).toBeNull();
    expect(screen.getByRole("tab", { name: strings.belowFloorExceptionsReviewed }).getAttribute("aria-selected")).toBe("true");

    // Switch back to Open tab
    calls.listBelowFloorExceptions.mockResolvedValue(ok(page([row(1)])));
    fireEvent.click(screen.getByRole("tab", { name: strings.belowFloorExceptionsOpen }));
    await waitFor(() => expect(bodyRows()[0]?.textContent).toContain("#1001"));
    expect(calls.listBelowFloorExceptions).toHaveBeenCalledWith({ status: "open" });
  });

  it("filters by shop and by area manager (for Admin)", async () => {
    const calls = setup(page([row(1)]), { currentRole: () => "admin" });
    calls.listBelowFloorExceptions.mockResolvedValue(ok(page([row(1)])));
    await screen.findByRole("heading", { name: strings.belowFloorExceptions });

    // Shop dropdown exists and can be changed
    const shopSelect = screen.getByLabelText(strings.belowFloorExceptionsFilterShop);
    fireEvent.change(shopSelect, { target: { value: shopA } });
    await waitFor(() => expect(calls.listBelowFloorExceptions).toHaveBeenCalledWith({ status: "open", shopId: shopA }));

    // Area Manager dropdown exists for Admin and can be changed
    const amSelect = screen.getByLabelText(strings.belowFloorExceptionsFilterAreaManager);
    fireEvent.change(amSelect, { target: { value: am1 } });
    await waitFor(() => expect(calls.listBelowFloorExceptions).toHaveBeenCalledWith({ status: "open", shopId: shopA, areaManagerId: am1 }));
  });

  it("Area Manager view: does not show Area Manager filter dropdown", async () => {
    setup(page([row(1)]), { currentRole: () => "area_manager" });
    await screen.findByRole("heading", { name: strings.belowFloorExceptions });

    expect(screen.getByLabelText(strings.belowFloorExceptionsFilterShop)).toBeTruthy();
    expect(screen.queryByLabelText(strings.belowFloorExceptionsFilterAreaManager)).toBeNull();
  });

  it("marks an exception reviewed with in-flight state and reloads", async () => {
    const calls = setup(page([row(1), row(2)]));
    calls.reviewBelowFloorException.mockResolvedValue(ok(row(1, { reviewed: { at: "2030-01-02T10:00:00.000Z", by: "Asha" } })));
    calls.listBelowFloorExceptions.mockResolvedValue(ok(page([row(2)])));

    const buttons = await screen.findAllByRole("button", { name: strings.belowFloorExceptionsReview });
    const firstButton = buttons[0];
    expect(firstButton).toBeTruthy();
    if (firstButton) fireEvent.click(firstButton);

    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    expect(calls.reviewBelowFloorException).toHaveBeenCalledWith(row(1).revisionId);
    expect(calls.listBelowFloorExceptions).toHaveBeenCalledWith({ status: "open" });
    expect(bodyRows()[0]?.textContent).toContain("#1002");
  });

  it("shows error alert when marking reviewed fails and keeps table row", async () => {
    const calls = setup(page([row(1)]));
    calls.reviewBelowFloorException.mockResolvedValue({ ok: false, status: 500, code: "INTERNAL" });

    fireEvent.click(await screen.findByRole("button", { name: strings.belowFloorExceptionsReview }));
    expect((await screen.findByRole("alert")).textContent).toBe(strings.belowFloorExceptionsReviewFailed);
    expect(bodyRows()).toHaveLength(1);
    expect(calls.listBelowFloorExceptions).not.toHaveBeenCalled();
  });

  it("paginates with Show more button", async () => {
    const calls = setup(page([row(2)], "cursor-1"));
    calls.listBelowFloorExceptions.mockResolvedValue(ok({
      exceptions: [row(1)],
      nextCursor: null,
      counts,
    }));

    const moreBtn = await screen.findByRole("button", { name: strings.belowFloorExceptionsMore });
    fireEvent.click(moreBtn);

    await waitFor(() => expect(bodyRows()).toHaveLength(2));
    expect(calls.listBelowFloorExceptions).toHaveBeenCalledWith({ status: "open", cursor: "cursor-1" });
    expect(screen.queryByRole("button", { name: strings.belowFloorExceptionsMore })).toBeNull();
  });

  it("handles overlapping pagination and filter changes deterministically without stale page leaking", async () => {
    const calls = setup(page([row(1)], "cursor-1"));
    const pageDeferred = deferred<unknown>();
    calls.listBelowFloorExceptions.mockReturnValueOnce(pageDeferred.promise);

    // User clicks "Show more" -> pagination is in flight
    fireEvent.click(await screen.findByRole("button", { name: strings.belowFloorExceptionsMore }));
    expect(calls.listBelowFloorExceptions).toHaveBeenCalledWith({ status: "open", cursor: "cursor-1" });

    // While pagination is pending, user changes shop filter to shopB
    const filterDeferred = deferred<unknown>();
    calls.listBelowFloorExceptions.mockReturnValueOnce(filterDeferred.promise);
    const shopSelect = screen.getByLabelText(strings.belowFloorExceptionsFilterShop);
    fireEvent.change(shopSelect, { target: { value: shopB } });

    // Filter request resolves first with shopB row 2
    filterDeferred.resolve(ok(page([row(2, { shopId: shopB, shopName: "Kothrud Mart" })])));
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    expect(bodyRows()[0]?.textContent).toContain("Kothrud Mart");

    // Stale pagination request resolves later with row 3
    pageDeferred.resolve(ok(page([row(3)])));
    await new Promise((r) => setTimeout(r, 20));
    expect(bodyRows()).toHaveLength(1);
    expect(bodyRows()[0]?.textContent).toContain("Kothrud Mart");
    expect(screen.queryByText("#1003")).toBeNull();
  });

  it("handles out-of-order rapid filter changes deterministically, keeping latest selection", async () => {
    const calls = setup(page([row(1)]));
    await screen.findByRole("heading", { name: strings.belowFloorExceptions });

    const reqA = deferred<unknown>();
    const reqB = deferred<unknown>();
    calls.listBelowFloorExceptions.mockReturnValueOnce(reqA.promise).mockReturnValueOnce(reqB.promise);

    const shopSelect = screen.getByLabelText(strings.belowFloorExceptionsFilterShop);
    // User selects shopA
    fireEvent.change(shopSelect, { target: { value: shopA } });
    // User quickly selects shopB before shopA responds
    fireEvent.change(shopSelect, { target: { value: shopB } });

    // Request B resolves first with row 2 (shopB)
    reqB.resolve(ok(page([row(2, { shopId: shopB, shopName: "Kothrud Mart" })])));
    await waitFor(() => expect(bodyRows()).toHaveLength(1));

    // Request A resolves later with row 3 (shopA)
    reqA.resolve(ok(page([row(3, { shopId: shopA, shopName: "Sai General Stores" })])));
    await new Promise((r) => setTimeout(r, 20));

    // View must strictly keep shopB result and drop stale shopA
    expect(bodyRows()).toHaveLength(1);
    expect(bodyRows()[0]?.textContent).toContain("Kothrud Mart");
    expect(screen.queryByText("#1003")).toBeNull();
  });

  it("tracks concurrent review operations independently across different rows", async () => {
    const calls = setup(page([row(1), row(2)]));
    await screen.findByRole("heading", { name: strings.belowFloorExceptions });

    const rev1 = deferred<unknown>();
    const rev2 = deferred<unknown>();
    calls.reviewBelowFloorException
      .mockImplementation((id: string) => (id === row(1).revisionId ? rev1.promise : rev2.promise));

    const buttons = screen.getAllByRole("button", { name: strings.belowFloorExceptionsReview });
    expect(buttons).toHaveLength(2);

    // Click review on row 1
    const btn1 = buttons[0];
    const btn2 = buttons[1];
    expect(btn1).toBeDefined();
    expect(btn2).toBeDefined();
    if (btn1 && btn2) {
      fireEvent.click(btn1);
      fireEvent.click(btn2);
    }

    expect(calls.reviewBelowFloorException).toHaveBeenCalledWith(row(1).revisionId);
    expect(calls.reviewBelowFloorException).toHaveBeenCalledWith(row(2).revisionId);

    // Both buttons indicate review is underway
    await waitFor(() => {
      const reviewingButtons = screen.getAllByRole("button", { name: strings.belowFloorExceptionsReviewing });
      expect(reviewingButtons).toHaveLength(2);
    });

    // Resolve row 1
    calls.listBelowFloorExceptions.mockResolvedValue(ok(page([row(2)])));
    rev1.resolve(ok(row(1, { reviewed: { at: "2030-01-02T10:00:00.000Z", by: "Admin" } })));
    await waitFor(() => expect(screen.getAllByRole("button", { name: strings.belowFloorExceptionsReviewing })).toHaveLength(1));

    // Resolve row 2
    calls.listBelowFloorExceptions.mockResolvedValue(ok(page([])));
    rev2.resolve(ok(row(2, { reviewed: { at: "2030-01-02T10:05:00.000Z", by: "Admin" } })));
    await waitFor(() => expect(screen.queryByRole("table")).toBeNull());
  });

  it("review completion reloads using the updated filter when user switched filter in-flight", async () => {
    const calls = setup(page([row(1)]));
    await screen.findByRole("heading", { name: strings.belowFloorExceptions });

    const revPromise = deferred<unknown>();
    calls.reviewBelowFloorException.mockReturnValueOnce(revPromise.promise);

    // User clicks review on row 1
    fireEvent.click(screen.getByRole("button", { name: strings.belowFloorExceptionsReview }));
    expect(calls.reviewBelowFloorException).toHaveBeenCalledWith(row(1).revisionId);

    // While review is in-flight, user switches shop to shopB
    calls.listBelowFloorExceptions.mockResolvedValueOnce(ok(page([row(2, { shopId: shopB })])));
    const shopSelect = screen.getByLabelText(strings.belowFloorExceptionsFilterShop);
    fireEvent.change(shopSelect, { target: { value: shopB } });
    await waitFor(() => expect(calls.listBelowFloorExceptions).toHaveBeenCalledWith({ status: "open", shopId: shopB }));

    // Now review completes
    calls.listBelowFloorExceptions.mockResolvedValueOnce(ok(page([row(3, { shopId: shopB })])));
    revPromise.resolve(ok(row(1, { reviewed: { at: "2030-01-02T10:00:00.000Z", by: "Admin" } })));

    // Review reload must query with shopId: shopB, not reset to empty
    await waitFor(() => expect(calls.listBelowFloorExceptions).toHaveBeenLastCalledWith({ status: "open", shopId: shopB }));
  });
});
