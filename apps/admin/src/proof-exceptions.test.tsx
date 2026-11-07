// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { ProofException, ProofExceptionsResponse } from "@ygo/contracts";
import { formatDateTime } from "@ygo/format";
import { ProofExceptions } from "./proof-exceptions";
import { strings } from "./strings";

afterEach(() => cleanup());

const shopA = "00000000-0000-4000-8000-000000000a01";
const shopB = "00000000-0000-4000-8000-000000000a02";
const asha = "00000000-0000-4000-8000-000000000b01";
const dev = "00000000-0000-4000-8000-000000000b02";
const row = (n: number, extra: Partial<ProofException> = {}): ProofException => ({
  orderId: `00000000-0000-4000-8000-00000000c0${n}`, orderNumber: 1000 + n, shop: { id: shopA, name: "Sai General Stores" }, deliverer: { id: asha, name: "Asha" },
  reason: "customer_phone_unavailable", recordedAt: `2030-01-0${n}T10:00:00.000Z`, reviewed: null, ...extra,
});
const counts: ProofExceptionsResponse["counts"] = {
  shops: [{ shopId: shopA, name: "Sai General Stores", total: 3, open: 2 }, { shopId: shopB, name: "Kothrud Mart", total: 1, open: 1 }],
  deliverers: [
    { accountId: asha, name: "Asha", total: 3, open: 2 },
    { accountId: dev, name: "Dev", total: 1, open: 1 },
  ],
};
const page = (exceptions: ProofException[], nextCursor: string | null = null): ProofExceptionsResponse => ({ exceptions, nextCursor, counts });
const ok = <T,>(data: T) => ({ ok: true as const, data });

function setup(first: ProofExceptionsResponse, api: Record<string, unknown> = {}) {
  const calls = { listProofExceptions: vi.fn(), reviewProofException: vi.fn(), ...api };
  const router = createMemoryRouter([{ path: "/", loader: () => first, element: <ProofExceptions api={calls as unknown as Parameters<typeof ProofExceptions>[0]["api"]} /> }]);
  render(<RouterProvider router={router} />);
  return calls as { listProofExceptions: ReturnType<typeof vi.fn>; reviewProofException: ReturnType<typeof vi.fn> };
}
const table = () => screen.getByRole("table");
const bodyRows = () => within(table()).getAllByRole("row").slice(1);

describe("A28 Proof exception screen (DLV-4, #60)", () => {
  it("lists the open ones with order, shop, deliverer, a plain reason and the time, and the counts per shop and deliverer", async () => {
    setup(page([row(2), row(1, { reason: "someone_else_receiving", deliverer: { id: dev, name: null }, shop: { id: shopB, name: "Kothrud Mart" } })]));
    await screen.findByRole("heading", { name: strings.proofExceptions });
    const [first, second] = bodyRows();
    expect(first?.textContent).toContain("#1002");
    expect(first?.textContent).toContain("Sai General Stores");
    expect(first?.textContent).toContain("Asha");
    expect(first?.textContent).toContain(strings.proofExceptionReasons.customer_phone_unavailable);
    expect(first?.textContent).toContain(formatDateTime("2030-01-02T10:00:00.000Z"));
    expect(second?.textContent).toContain(strings.proofExceptionReasons.someone_else_receiving);
    expect(second?.textContent).toContain("—");
    const byShop = screen.getByRole("heading", { name: strings.proofExceptionsPerShop }).closest("section") as HTMLElement;
    expect(byShop.textContent).toContain(`Sai General Stores${strings.proofExceptionsCount(3, 2)}`);
    const byDeliverer = screen.getByRole("heading", { name: strings.proofExceptionsPerDeliverer }).closest("section") as HTMLElement;
    expect(byDeliverer.textContent).toContain(`Dev${strings.proofExceptionsCount(1, 1)}`);
    // Each deliverer once, with their total across shops.
    expect(byDeliverer.textContent).toContain(`Asha${strings.proofExceptionsCount(3, 2)}`);
    expect(screen.getAllByRole("button", { name: strings.proofExceptionsReview })).toHaveLength(2);
  });

  it("says plainly that nothing is waiting, and that nothing acts on its own", async () => {
    setup(page([]));
    expect(await screen.findByText(strings.proofExceptionsNoneOpen)).toBeTruthy();
    expect(screen.getByText(/nothing else happens automatically/i)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("marks one reviewed, then reloads the page and the counts so it leaves Open", async () => {
    const calls = setup(page([row(2), row(1)]));
    calls.reviewProofException.mockResolvedValue(ok(row(2, { reviewed: { at: "2030-01-05T10:00:00.000Z", by: "Asha Kulkarni" } })));
    calls.listProofExceptions.mockResolvedValue(ok({ ...page([row(1)]), counts: { ...counts, shops: counts.shops.map((shop) => (shop.shopId === shopA ? { ...shop, open: 1 } : shop)) } }));
    const buttons = await screen.findAllByRole("button", { name: strings.proofExceptionsReview });
    fireEvent.click(buttons.at(0) as HTMLElement);
    await waitFor(() => expect(bodyRows()).toHaveLength(1));
    expect(calls.reviewProofException).toHaveBeenCalledWith(row(2).orderId);
    expect(calls.listProofExceptions).toHaveBeenCalledWith({ status: "open" });
    expect(bodyRows()[0]?.textContent).toContain("#1001");
    const byShop = screen.getByRole("heading", { name: strings.proofExceptionsPerShop }).closest("section") as HTMLElement;
    expect(byShop.textContent).toContain(`Sai General Stores${strings.proofExceptionsCount(3, 1)}`);
  });

  it("keeps the row and says so when a mark fails, and when it was already gone", async () => {
    const calls = setup(page([row(2)]));
    calls.reviewProofException.mockResolvedValue({ ok: false, status: 404, code: "NOT_FOUND" });
    fireEvent.click(await screen.findByRole("button", { name: strings.proofExceptionsReview }));
    expect((await screen.findByRole("alert")).textContent).toBe(strings.proofExceptionsReviewFailed);
    expect(bodyRows()).toHaveLength(1);
    expect(calls.listProofExceptions).not.toHaveBeenCalled();
  });

  it("shows the Reviewed tab with who reviewed and when, and no Mark reviewed button", async () => {
    const calls = setup(page([row(2)]));
    calls.listProofExceptions.mockResolvedValue(ok(page([row(1, { reviewed: { at: "2030-01-05T10:00:00.000Z", by: "Ravi Patil" } })])));
    fireEvent.click(await screen.findByRole("tab", { name: strings.proofExceptionsReviewed }));
    await waitFor(() => expect(bodyRows()[0]?.textContent).toContain("Ravi Patil"));
    expect(calls.listProofExceptions).toHaveBeenCalledWith({ status: "reviewed" });
    expect(bodyRows()[0]?.textContent).toContain(strings.proofExceptionsReviewedBy("Ravi Patil", formatDateTime("2030-01-05T10:00:00.000Z")));
    expect(screen.queryByRole("button", { name: strings.proofExceptionsReview })).toBeNull();
    expect(screen.getByRole("tab", { name: strings.proofExceptionsReviewed }).getAttribute("aria-selected")).toBe("true");
  });

  it("says when nothing has been reviewed yet", async () => {
    const calls = setup(page([row(1)]));
    calls.listProofExceptions.mockResolvedValue(ok(page([])));
    fireEvent.click(await screen.findByRole("tab", { name: strings.proofExceptionsReviewed }));
    expect(await screen.findByText(strings.proofExceptionsNoneReviewed)).toBeTruthy();
  });

  it("filters by shop and by deliverer, keeping the tab", async () => {
    const calls = setup(page([row(1)]));
    calls.listProofExceptions.mockResolvedValue(ok(page([row(1)])));
    fireEvent.change(await screen.findByLabelText(strings.proofExceptionsFilterShop), { target: { value: shopB } });
    await waitFor(() => expect(calls.listProofExceptions).toHaveBeenLastCalledWith({ status: "open", shopId: shopB }));
    fireEvent.change(screen.getByLabelText(strings.proofExceptionsFilterDeliverer), { target: { value: dev } });
    await waitFor(() => expect(calls.listProofExceptions).toHaveBeenLastCalledWith({ status: "open", shopId: shopB, delivererId: dev }));
    fireEvent.click(screen.getByRole("tab", { name: strings.proofExceptionsReviewed }));
    await waitFor(() => expect(calls.listProofExceptions).toHaveBeenLastCalledWith({ status: "reviewed", shopId: shopB, delivererId: dev }));
    fireEvent.change(screen.getByLabelText(strings.proofExceptionsFilterShop), { target: { value: "" } });
    await waitFor(() => expect(calls.listProofExceptions).toHaveBeenLastCalledWith({ status: "reviewed", delivererId: dev }));
    // Each deliverer is offered once, though they may appear for two shops.
    expect(within(screen.getByLabelText(strings.proofExceptionsFilterDeliverer)).getAllByRole("option").map((option) => option.textContent)).toEqual([strings.proofExceptionsAll, "Asha", "Dev"]);
  });

  it("shows more when the server has another page, and stops when it has none", async () => {
    const cursor = "2030-01-02T10:00:00.000000Z|00000000-0000-4000-8000-00000000c002";
    const calls = setup(page([row(3), row(2)], cursor));
    calls.listProofExceptions.mockResolvedValue(ok(page([row(1)])));
    fireEvent.click(await screen.findByRole("button", { name: strings.proofExceptionsMore }));
    await waitFor(() => expect(bodyRows()).toHaveLength(3));
    expect(calls.listProofExceptions).toHaveBeenCalledWith({ status: "open", cursor });
    expect(bodyRows().map((r) => r.textContent?.match(/#\d+/)?.[0])).toEqual(["#1003", "#1002", "#1001"]);
    expect(screen.queryByRole("button", { name: strings.proofExceptionsMore })).toBeNull();
  });

  it("drops a slow answer that a newer tab or filter has overtaken", async () => {
    const calls = setup(page([row(3)]));
    let slow: (value: unknown) => void = () => undefined;
    calls.listProofExceptions
      .mockImplementationOnce(() => new Promise((resolve) => { slow = resolve; }))
      .mockResolvedValueOnce(ok(page([row(1, { reviewed: { at: "2030-01-05T10:00:00.000Z", by: "Ravi Patil" } })])));
    fireEvent.click(await screen.findByRole("tab", { name: strings.proofExceptionsReviewed }));
    fireEvent.click(screen.getByRole("tab", { name: strings.proofExceptionsOpen }));
    await waitFor(() => expect(calls.listProofExceptions).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(bodyRows()[0]?.textContent).toContain("#1001"));
    // The first (Reviewed) request answers last; it must not replace the newer list.
    slow(ok(page([row(2)])));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bodyRows()).toHaveLength(1);
    expect(bodyRows()[0]?.textContent).toContain("#1001");
    expect(screen.getByRole("tab", { name: strings.proofExceptionsOpen }).getAttribute("aria-selected")).toBe("true");
  });

  it("drops a page that arrives after the filter changed", async () => {
    const cursor = "2030-01-02T10:00:00.000000Z|00000000-0000-4000-8000-00000000c002";
    const calls = setup(page([row(3), row(2)], cursor));
    let late: (value: unknown) => void = () => undefined;
    calls.listProofExceptions
      .mockImplementationOnce(() => new Promise((resolve) => { late = resolve; }))
      .mockResolvedValueOnce(ok(page([row(4, { shop: { id: shopB, name: "Kothrud Mart" } })])));
    fireEvent.click(await screen.findByRole("button", { name: strings.proofExceptionsMore }));
    fireEvent.change(screen.getByLabelText(strings.proofExceptionsFilterShop), { target: { value: shopB } });
    await waitFor(() => expect(bodyRows()[0]?.textContent).toContain("#1004"));
    late(ok(page([row(1)])));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bodyRows().map((r) => r.textContent?.match(/#\d+/)?.[0])).toEqual(["#1004"]);
  });

  it("reloads the tab and filter on screen, not the ones a mark began in, when it finishes after a change", async () => {
    const calls = setup(page([row(2), row(1)]));
    let finish: (value: unknown) => void = () => undefined;
    calls.reviewProofException.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    calls.listProofExceptions.mockImplementation(async (query: { status: string }) =>
      ok(query.status === "reviewed" ? page([row(5, { reviewed: { at: "2030-01-05T10:00:00.000Z", by: "Ravi Patil" } })]) : page([row(1)])));
    fireEvent.click((await screen.findAllByRole("button", { name: strings.proofExceptionsReview })).at(0) as HTMLElement);
    fireEvent.click(screen.getByRole("tab", { name: strings.proofExceptionsReviewed }));
    await waitFor(() => expect(bodyRows()[0]?.textContent).toContain("#1005"));
    finish(ok(row(2, { reviewed: { at: "2030-01-05T10:00:00.000Z", by: "Asha Kulkarni" } })));
    await waitFor(() => expect(calls.listProofExceptions).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.listProofExceptions).toHaveBeenLastCalledWith({ status: "reviewed" });
    expect(screen.getByRole("tab", { name: strings.proofExceptionsReviewed }).getAttribute("aria-selected")).toBe("true");
    expect(bodyRows().map((r) => r.textContent?.match(/#\d+/)?.[0])).toEqual(["#1005"]);
  });

  it("sends one request and adds no duplicate rows when Show more is clicked repeatedly", async () => {
    const cursor = "2030-01-02T10:00:00.000000Z|00000000-0000-4000-8000-00000000c002";
    const calls = setup(page([row(3), row(2)], cursor));
    let answer: (value: unknown) => void = () => undefined;
    calls.listProofExceptions.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const button = await screen.findByRole("button", { name: strings.proofExceptionsMore });
    fireEvent.click(button); fireEvent.click(button); fireEvent.click(button);
    expect(calls.listProofExceptions).toHaveBeenCalledTimes(1);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    answer(ok(page([row(1)])));
    await waitFor(() => expect(bodyRows()).toHaveLength(3));
    expect(bodyRows().map((r) => r.textContent?.match(/#\d+/)?.[0])).toEqual(["#1003", "#1002", "#1001"]);
    expect(calls.listProofExceptions).toHaveBeenCalledTimes(1);
  });

  it("never lists an order twice when a page repeats one already shown", async () => {
    const cursor = "2030-01-02T10:00:00.000000Z|00000000-0000-4000-8000-00000000c002";
    const calls = setup(page([row(3), row(2)], cursor));
    calls.listProofExceptions.mockResolvedValue(ok(page([row(2), row(1)])));
    fireEvent.click(await screen.findByRole("button", { name: strings.proofExceptionsMore }));
    await waitFor(() => expect(bodyRows()).toHaveLength(3));
    expect(bodyRows().map((r) => r.textContent?.match(/#\d+/)?.[0])).toEqual(["#1003", "#1002", "#1001"]);
  });

  it("says so, and keeps what it has, when a page or a tab cannot load", async () => {
    const calls = setup(page([row(2)], "2030-01-02T10:00:00.000000Z|00000000-0000-4000-8000-00000000c002"));
    calls.listProofExceptions.mockResolvedValue({ ok: false, status: 503, code: "UNAVAILABLE" });
    fireEvent.click(await screen.findByRole("button", { name: strings.proofExceptionsMore }));
    expect((await screen.findByRole("alert")).textContent).toBe(strings.proofExceptionsLoadFailed);
    expect(bodyRows()).toHaveLength(1);
    fireEvent.click(screen.getByRole("tab", { name: strings.proofExceptionsReviewed }));
    await waitFor(() => expect(calls.listProofExceptions).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("alert").textContent).toBe(strings.proofExceptionsLoadFailed);
  });
});
