// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { Statement, StatementSummary } from "@ygo/contracts";
import { adminRoutes } from "./routes";
import { strings } from "./strings";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const text = strings.statements;
const shop = "00000000-0000-4000-8000-000000000a01";
const summary = (number: number, extra: Partial<StatementSummary> = {}): StatementSummary => ({
  id: `00000000-0000-4000-8000-0000000000${number}`, number, shopId: shop, shopName: "Sai General Stores", periodStart: "2026-11-02", periodEnd: "2026-11-08",
  issuedAt: "2026-11-09T02:00:00.000Z", dueOn: "2026-11-16", orderCount: 2, total: "62.50", ...extra,
});
const statement = (extra: Partial<Statement> = {}): Statement => ({
  ...summary(7), shopAddress: "12 MG Road", shopPincode: "411038",
  lines: [
    { orderId: "00000000-0000-4000-8000-000000000b01", orderNumber: 1001, completedAt: "2026-11-03T08:30:00.000Z", late: false, fulfilment: "delivery", orderTotal: "150.00",
      commission: "13.00", feeShare: "10.00", bookingFees: "0.00", platformCoupon: "5.00", owed: "18.00" },
    { orderId: "00000000-0000-4000-8000-000000000b02", orderNumber: 1002, completedAt: "2026-10-30T08:30:00.000Z", late: true, fulfilment: "pickup", orderTotal: "200.00",
      commission: "20.00", feeShare: "0.00", bookingFees: "24.50", platformCoupon: "0.00", owed: "44.50" },
  ],
  ...extra,
});
const ok = <T,>(data: T) => ({ ok: true as const, data });

function setup(path: string, role: "admin" | "area_manager" = "admin", overrides: Record<string, unknown> = {}) {
  let ended = false;
  const api = {
    role: vi.fn(async () => ok(role)),
    currentRole: vi.fn(() => (ended ? null : role)),
    me: vi.fn().mockResolvedValue(ok({ id: shop, email: "a@example.com", name: "Admin", phone: "+919876543210", theme: "system", role })),
    setTheme: vi.fn(),
    signOut: vi.fn(async () => { ended = true; return ok(undefined); }),
    shopBalances: vi.fn().mockResolvedValue(ok({ balances: [{ shopId: shop, shopName: "Sai General Stores", onStatements: "62.50", thisWeek: "10.00", total: "72.50" }] })),
    listStatements: vi.fn().mockResolvedValue(ok({ statements: [summary(7), summary(6)], nextBefore: null })),
    getStatement: vi.fn().mockResolvedValue(ok(statement())),
    listShopApplications: vi.fn().mockResolvedValue(ok({ applications: [] })),
    ...overrides,
  };
  const router = createMemoryRouter(adminRoutes(api as unknown as Parameters<typeof adminRoutes>[0]), { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return { api, router };
}

describe("A18 Statements (ADM-6, MNY-8, MNY-12, #631)", () => {
  it("shows every shop's balance and the statements newest first, from the navigation, with no trailing zeros", async () => {
    const { api } = setup("/applications");
    fireEvent.click(await screen.findByRole("link", { name: text.title }));
    await screen.findByRole("heading", { name: text.title });
    expect(api.shopBalances).toHaveBeenCalledOnce();
    expect(api.listStatements).toHaveBeenCalledWith();
    const body = document.body.textContent ?? "";
    expect(body).toContain("Sai General Stores");
    for (const amount of ["₹62.50", "₹10", "₹72.50"]) expect(body).toContain(amount);
    expect(body).not.toMatch(/\.00|\.50\d/);
    const rows = screen.getAllByRole("link", { name: /^#\d+$/ }).map((link) => link.textContent);
    expect(rows).toEqual(["#7", "#6"]);
  });

  it("says so when nothing is owed and no statement exists yet", async () => {
    setup("/statements", "admin", { shopBalances: vi.fn().mockResolvedValue(ok({ balances: [] })), listStatements: vi.fn().mockResolvedValue(ok({ statements: [], nextBefore: null })) });
    await screen.findByText(text.noBalances);
    expect(screen.getByText(text.none)).toBeTruthy();
  });

  it("loads more by nextBefore, keeping the server's order, and starts again when the week changes or clears", async () => {
    const listStatements = vi.fn()
      .mockResolvedValueOnce(ok({ statements: [summary(9), summary(8)], nextBefore: 8 }))
      .mockResolvedValueOnce(ok({ statements: [summary(7), summary(6)], nextBefore: null }))
      .mockResolvedValueOnce(ok({ statements: [summary(5)], nextBefore: 5 }))
      .mockResolvedValueOnce(ok({ statements: [summary(9), summary(8)], nextBefore: 8 }));
    setup("/statements", "admin", { listStatements });
    await screen.findByRole("link", { name: "#9" });
    fireEvent.click(screen.getByRole("button", { name: text.loadMore }));
    await waitFor(() => expect(screen.getAllByRole("link", { name: /^#\d+$/ }).map((l) => l.textContent)).toEqual(["#9", "#8", "#7", "#6"]));
    expect(listStatements).toHaveBeenLastCalledWith({ before: 8 });
    expect(screen.queryByRole("button", { name: text.loadMore })).toBeNull();

    fireEvent.change(screen.getByLabelText(text.week), { target: { value: "2026-11-02" } });
    await waitFor(() => expect(screen.getAllByRole("link", { name: /^#\d+$/ }).map((l) => l.textContent)).toEqual(["#5"]));
    expect(listStatements).toHaveBeenLastCalledWith({ week: "2026-11-02" });
    fireEvent.click(screen.getByRole("button", { name: text.loadMore }));
    await waitFor(() => expect(listStatements).toHaveBeenCalledTimes(4));
    expect(listStatements).toHaveBeenLastCalledWith({ week: "2026-11-02", before: 5 });
  });

  it("clearing the week asks for the first page again", async () => {
    const listStatements = vi.fn().mockResolvedValue(ok({ statements: [summary(9)], nextBefore: null }));
    setup("/statements", "admin", { listStatements });
    await screen.findByRole("link", { name: "#9" });
    fireEvent.change(screen.getByLabelText(text.week), { target: { value: "2026-11-02" } });
    await waitFor(() => expect(listStatements).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: text.clearWeek }));
    await waitFor(() => expect(listStatements).toHaveBeenCalledTimes(3));
    expect(listStatements).toHaveBeenLastCalledWith({});
  });

  // A week-filter answer that arrives after the input has gone back to the week shown must not replace the rows or the paging.
  function deferred() {
    let resolve!: (value: unknown) => void;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
  }
  const numbers = () => screen.getAllByRole("link", { name: /^#\d+$/ }).map((link) => link.textContent);

  it("ignores a week's late answer after the week is cleared before it arrives", async () => {
    const late = deferred();
    const listStatements = vi.fn().mockResolvedValueOnce(ok({ statements: [summary(9), summary(8)], nextBefore: 8 })).mockReturnValueOnce(late.promise);
    setup("/statements", "admin", { listStatements });
    await screen.findByRole("link", { name: "#9" });
    fireEvent.change(screen.getByLabelText(text.week), { target: { value: "2026-11-02" } });
    await waitFor(() => expect(listStatements).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByLabelText(text.week), { target: { value: "" } });
    await act(async () => { late.resolve(ok({ statements: [summary(1)], nextBefore: null })); });
    expect(numbers()).toEqual(["#9", "#8"]);
    expect(listStatements).toHaveBeenCalledTimes(2);
    expect((screen.getByRole("button", { name: text.loadMore }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("ignores a week's late answer after the input goes back to the week shown before it arrives", async () => {
    const late = deferred();
    const listStatements = vi.fn()
      .mockResolvedValueOnce(ok({ statements: [summary(9)], nextBefore: 9 }))
      .mockResolvedValueOnce(ok({ statements: [summary(5)], nextBefore: 5 }))
      .mockReturnValueOnce(late.promise)
      .mockResolvedValueOnce(ok({ statements: [summary(4)], nextBefore: null }));
    setup("/statements", "admin", { listStatements });
    await screen.findByRole("link", { name: "#9" });
    fireEvent.change(screen.getByLabelText(text.week), { target: { value: "2026-11-02" } });
    await waitFor(() => expect(numbers()).toEqual(["#5"]));
    fireEvent.change(screen.getByLabelText(text.week), { target: { value: "2026-11-09" } });
    await waitFor(() => expect(listStatements).toHaveBeenCalledTimes(3));
    fireEvent.change(screen.getByLabelText(text.week), { target: { value: "2026-11-02" } });
    await act(async () => { late.resolve(ok({ statements: [summary(1)], nextBefore: null })); });
    expect(numbers()).toEqual(["#5"]);
    // The paging is still the shown week's: Load more continues from #5.
    fireEvent.click(screen.getByRole("button", { name: text.loadMore }));
    await waitFor(() => expect(numbers()).toEqual(["#5", "#4"]));
    expect(listStatements).toHaveBeenLastCalledWith({ week: "2026-11-02", before: 5 });
  });

  it("keeps a Load more in flight when a day that is not a Monday is picked, and appends its rows", async () => {
    const more = deferred();
    const listStatements = vi.fn().mockResolvedValueOnce(ok({ statements: [summary(9)], nextBefore: 9 })).mockReturnValueOnce(more.promise);
    setup("/statements", "admin", { listStatements });
    await screen.findByRole("link", { name: "#9" });
    fireEvent.click(screen.getByRole("button", { name: text.loadMore }));
    await waitFor(() => expect(listStatements).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByLabelText(text.week), { target: { value: "2026-11-04" } });
    expect((await screen.findByRole("alert")).textContent).toBe(text.pickMonday);
    await act(async () => { more.resolve(ok({ statements: [summary(8)], nextBefore: 8 })); });
    expect(numbers()).toEqual(["#9", "#8"]);
    expect(listStatements).toHaveBeenCalledTimes(2);
    // Back to a Monday: Load more is offered again and continues from the page kept, #8.
    fireEvent.change(screen.getByLabelText(text.week), { target: { value: "" } });
    await waitFor(() => expect(screen.queryByText(text.pickMonday)).toBeNull());
    expect(numbers()).toEqual(["#9", "#8"]);
    fireEvent.click(screen.getByRole("button", { name: text.loadMore }));
    await waitFor(() => expect(listStatements).toHaveBeenLastCalledWith({ before: 8 }));
  });

  it("keeps the week input as typed when a Load more fails", async () => {
    const more = deferred();
    const listStatements = vi.fn().mockResolvedValueOnce(ok({ statements: [summary(9)], nextBefore: 9 })).mockReturnValueOnce(more.promise);
    setup("/statements", "admin", { listStatements });
    await screen.findByRole("link", { name: "#9" });
    fireEvent.click(screen.getByRole("button", { name: text.loadMore }));
    await waitFor(() => expect(listStatements).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByLabelText(text.week), { target: { value: "2026-11-04" } });
    await act(async () => { more.resolve({ ok: false, status: 500, code: "INTERNAL" }); });
    expect((screen.getByLabelText(text.week) as HTMLInputElement).value).toBe("2026-11-04");
    expect(screen.getAllByRole("alert").map((alert) => alert.textContent)).toContain(text.pickMonday);
    expect(numbers()).toEqual(["#9"]);
    // Load more is hidden while the day is not a Monday.
    expect(screen.queryByRole("button", { name: text.loadMore })).toBeNull();
  });

  it("puts the week back and keeps the list when the week's statements cannot be loaded", async () => {
    const listStatements = vi.fn().mockResolvedValueOnce(ok({ statements: [summary(7)], nextBefore: null })).mockResolvedValue({ ok: false, status: 500, code: "INTERNAL" });
    setup("/statements", "admin", { listStatements });
    await screen.findByRole("link", { name: "#7" });
    fireEvent.change(screen.getByLabelText(text.week), { target: { value: "2026-11-09" } });
    expect((await screen.findByRole("alert")).textContent).toBe(text.loadFailed);
    expect((screen.getByLabelText(text.week) as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("link", { name: "#7" })).toBeTruthy();
  });

  it("says 'Pick a Monday' for any other day, without asking the server", async () => {
    const { api } = setup("/statements");
    await screen.findByRole("link", { name: "#7" });
    api.listStatements.mockClear();
    fireEvent.change(screen.getByLabelText(text.week), { target: { value: "2026-11-04" } });
    expect((await screen.findByRole("alert")).textContent).toBe(text.pickMonday);
    expect(api.listStatements).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(text.week), { target: { value: "2026-11-09" } });
    await waitFor(() => expect(api.listStatements).toHaveBeenCalledWith({ week: "2026-11-09" }));
    expect(screen.queryByText(text.pickMonday)).toBeNull();
  });

  it("says no statements for the week when a week has none", async () => {
    const listStatements = vi.fn().mockResolvedValueOnce(ok({ statements: [summary(7)], nextBefore: null })).mockResolvedValue(ok({ statements: [], nextBefore: null }));
    setup("/statements", "admin", { listStatements });
    await screen.findByRole("link", { name: "#7" });
    fireEvent.change(screen.getByLabelText(text.week), { target: { value: "2026-11-09" } });
    await screen.findByText(text.noneForWeek);
  });

  it("shows a statement with its shop as at issue, each order's route, Late, the total and the exact disclaimer, and no earnings wording", async () => {
    const { api } = setup("/statements");
    fireEvent.click(await screen.findByRole("link", { name: "#7" }));
    await screen.findByRole("heading", { name: "Statement #7" });
    expect(api.getStatement).toHaveBeenCalledWith(summary(7).id);
    const body = document.body.textContent ?? "";
    for (const expected of ["Sai General Stores", "12 MG Road, 411038", "16 Nov 2026", "#1001", "#1002", "Delivery", "Pickup", "Total owed to YGo: ₹62.50", "₹24.50", "₹150", "₹5"]) expect(body).toContain(expected);
    expect(body).toContain("This is not a tax invoice. No GST is charged.");
    expect(body).not.toMatch(/\.00/);
    expect(body).not.toMatch(/earn|profit|margin|you keep/i);
    const rows = screen.getAllByRole("row");
    expect(rows.map((row) => within(row).queryByText(text.late) !== null)).toEqual([false, false, true]);
    const link = screen.getByRole("link", { name: text.downloadPdf });
    expect(link.getAttribute("href")).toBe(`/statements/${summary(7).id}/print`);
  });

  it("shows no address line text when the shop had none at issue", async () => {
    setup(`/statements/${summary(7).id}`, "admin", { getStatement: vi.fn().mockResolvedValue(ok(statement({ shopAddress: null, shopPincode: null }))) });
    await screen.findByRole("heading", { name: "Statement #7" });
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("prints the statement once it is drawn: titled for the file, in black on white A4 landscape, with no sidebar or controls", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => undefined);
    setup(`/statements/${summary(7).id}/print`);
    await screen.findByRole("heading", { name: "Statement #7" });
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(document.title).toBe("YGo statement #7");
    expect(document.querySelector(".statement-print style")?.textContent).toContain("size: A4 landscape");
    expect(document.querySelector(".statement-print style")?.textContent).toContain("background: #fff");
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(document.body.textContent).toContain("This is not a tax invoice. No GST is charged.");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(print).toHaveBeenCalledTimes(1);
  });

  it("hides Statements from an Area Manager, who is sent to Applications without the server being asked", async () => {
    const { api, router } = setup("/applications", "area_manager");
    await screen.findByText(strings.noAssignedShops);
    expect(screen.queryByRole("link", { name: text.title })).toBeNull();
    await router.navigate("/statements");
    await waitFor(() => expect(router.state.location.pathname).toBe("/applications"));
    for (const path of [`/statements/${summary(7).id}`, `/statements/${summary(7).id}/print`]) {
      await router.navigate(path);
      await waitFor(() => expect(router.state.location.pathname).toBe("/applications"));
    }
    for (const call of [api.shopBalances, api.listStatements, api.getStatement]) expect(call).not.toHaveBeenCalled();
  });
});
