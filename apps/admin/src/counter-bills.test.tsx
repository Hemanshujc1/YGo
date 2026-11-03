// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { AdminCounterBill, AdminShopApplication } from "@ygo/contracts";
import { formatDateTime } from "@ygo/format";
import { CounterBills } from "./counter-bills";
import { strings } from "./strings";

afterEach(() => cleanup());

const shopId = "00000000-0000-4000-8000-000000000501";
const application = { id: shopId, shopName: "Fresh Mart" } as AdminShopApplication;
const line = { packId: "00000000-0000-4000-8000-000000000701", name: "Toor Dal", packQuantity: "5.000", baseUnit: "kg", count: 2, unitPrice: "21.00" };
const bill = (id: number, extra: Partial<AdminCounterBill> = {}): AdminCounterBill => ({
  id: `00000000-0000-4000-8000-00000000090${id}`, reference: `0F3A-91B${id}`, number: null, heldReason: "too_old", totalMismatch: false, payment: "cash",
  total: "42.00", checkedTotal: "42.00", clockSuspect: false, madeAt: "2030-01-01T05:00:00.000Z", receivedAt: "2030-01-02T05:00:00.000Z",
  madeBy: { name: "Asha", role: "owner" }, lines: [line], manualLines: [], discount: "0", invalidPayload: null, original: null, voided: null, resolved: false, resolutions: [], ...extra,
});

function setup(bills: AdminCounterBill[], resolveCounterBill = vi.fn()) {
  const api = { resolveCounterBill } as unknown as Parameters<typeof CounterBills>[0]["api"];
  const router = createMemoryRouter([{ path: "/", loader: () => ({ application, bills }), element: <CounterBills api={api} /> }]);
  render(<RouterProvider router={router} />);
  return { resolveCounterBill };
}
const buttonNames = (card: HTMLElement) => within(card).getAllByRole("button").map((button) => button.textContent);

describe("Counter bills screen (#470)", () => {
  it("shows an open bill with its reason, totals without trailing zeros, who made it and its lines", async () => {
    setup([bill(1, { totalMismatch: true, checkedTotal: "45.50", clockSuspect: true })]);
    const card = (await screen.findByRole("heading", { name: "0F3A-91B1" })).closest("li") as HTMLElement;
    expect(within(card).getByText(strings.counterBillHeld.too_old)).toBeTruthy();
    expect(within(card).getByText(strings.counterBillFlagged)).toBeTruthy();
    expect(within(card).getByText(strings.counterBillClock)).toBeTruthy();
    expect(card.textContent).toContain("₹42");
    expect(card.textContent).toContain("₹45.50");
    expect(card.textContent).not.toContain(".00");
    expect(card.textContent).toContain(strings.counterBillMadeBy("Asha", "Owner"));
    expect(card.textContent).toContain("Toor Dal 5 kg × 2 at ₹21");
    expect(screen.getByRole("heading", { name: `${strings.counterBillsOf("Fresh Mart")}` })).toBeTruthy();
  });

  it("shows a typed line and the discount beside the catalog lines, and never the customer (#53)", async () => {
    setup([bill(1, { manualLines: [{ name: "Loose sugar", count: 3, unitPrice: "12.50" }], discount: "9.50", total: "70.00", checkedTotal: "70.00" })]);
    const card = (await screen.findByRole("heading", { name: "0F3A-91B1" })).closest("li") as HTMLElement;
    expect(card.textContent).toContain("Loose sugar (typed) × 3 at ₹12.50");
    expect(card.textContent).toContain("Discount −₹9.50");
  });

  it("shows very large totals and prices to the last paise, as the server sent them (#475)", async () => {
    const big = { ...line, unitPrice: "4999499999995000.75" };
    setup([bill(1, { heldReason: "reference_taken", total: "9998999999990001.50", checkedTotal: "9998999999990001.55", lines: [big],
      original: { id: "00000000-0000-4000-8000-000000000999", number: 3, total: "9998999999990001.05", payment: "upi", madeAt: "2030-01-01T04:00:00.000Z", lines: [big], manualLines: [], discount: "0", voided: null } })]);
    const card = (await screen.findByRole("heading", { name: "0F3A-91B1" })).closest("li") as HTMLElement;
    expect(card.textContent).toContain("₹9,99,89,99,99,99,90,001.50");
    expect(card.textContent).toContain("₹9,99,89,99,99,99,90,001.55");
    expect(card.textContent).toContain("₹9,99,89,99,99,99,90,001.05");
    expect(card.textContent).toContain("Toor Dal 5 kg × 2 at ₹4,99,94,99,99,99,95,000.75");
  });

  it("offers only the actions that fit each kind of bill", async () => {
    setup([
      bill(1, { heldReason: "too_old" }), bill(2, { heldReason: "reference_taken" }), bill(3, { heldReason: "invalid", total: null, checkedTotal: null, payment: null, lines: [], invalidPayload: '{"total":"9"}' }),
      bill(4, { heldReason: null, number: 7, totalMismatch: true }), bill(5, { heldReason: "too_large" }),
    ]);
    const card = async (reference: string) => (await screen.findByRole("heading", { name: reference })).closest("li") as HTMLElement;
    const a = strings.counterBillActions;
    expect(buttonNames(await card("0F3A-91B1"))).toEqual([a.number, a.note]);
    expect(buttonNames(await card("0F3A-91B2"))).toEqual([a.number, a.duplicate, a.note]);
    expect(buttonNames(await card("0F3A-91B3"))).toEqual([a.review, a.note]);
    expect(buttonNames(await card("0F3A-91B4"))).toEqual([a.review, a.note]);
    expect(within(await card("0F3A-91B3")).getByText(strings.counterBillPayload)).toBeTruthy();
    expect((await card("0F3A-91B5")).textContent).toContain(strings.counterBillStock.none);
    expect((await card("0F3A-91B1")).textContent).toContain(strings.counterBillStock.moves);
  });

  it("shows the first bill of a clash beside the held one", async () => {
    setup([bill(1, { heldReason: "reference_taken", original: { id: "00000000-0000-4000-8000-000000000999", number: 3, total: "42.00", payment: "upi", madeAt: "2030-01-01T04:00:00.000Z", lines: [line], manualLines: [], discount: "0", voided: null } })]);
    const card = (await screen.findByRole("heading", { name: "0F3A-91B1" })).closest("li") as HTMLElement;
    expect(card.textContent).toContain(strings.counterBillOriginal);
    expect(card.textContent).toContain(`${strings.counterBillNumbered(3)} · ₹42 · UPI`);
  });

  it("shows a void on a flagged bill and on a clash's first bill, in dealt-with, with only a note to add (#495)", async () => {
    const voided = { reason: "other" as const, note: "Typed the wrong price", stockMoved: false, actorName: "Asha", createdAt: "2030-01-03T05:00:00.000Z" };
    setup([
      bill(1, { heldReason: null, number: 7, totalMismatch: true, voided, resolved: true }),
      bill(2, { heldReason: "reference_taken", original: { id: "00000000-0000-4000-8000-000000000999", number: 3, total: "42.00", payment: "upi", madeAt: "2030-01-01T04:00:00.000Z", lines: [line], manualLines: [], discount: "0", voided: { ...voided, reason: "billed_twice", note: null, stockMoved: true } } }),
    ]);
    const card = async (reference: string) => (await screen.findByRole("heading", { name: reference })).closest("li") as HTMLElement;
    const done = (await screen.findByRole("heading", { name: strings.counterBillsDone })).closest("section") as HTMLElement;
    expect(within(done).getByRole("heading", { name: "0F3A-91B1" })).toBeTruthy();
    const flagged = await card("0F3A-91B1");
    expect(flagged.textContent).toContain(strings.counterBillVoided);
    expect(flagged.textContent).toContain("Other · Typed the wrong price · No stock moved");
    expect(buttonNames(flagged)).toEqual([strings.counterBillActions.note]);
    const clash = await card("0F3A-91B2");
    expect(clash.textContent).toContain("Billed twice · Stock given back");
  });

  it("shows no panel on a bill reviewed and then voided, and names no Admin for a void by someone who has left (#495)", async () => {
    const voided = { reason: "wrong_item" as const, note: null, stockMoved: false, actorName: null, createdAt: "2030-01-03T05:00:00.000Z" };
    setup([bill(1, { heldReason: null, number: 7, totalMismatch: true, voided, resolved: true,
      resolutions: [{ action: "reviewed", note: "Looked", stockMoved: false, actorName: "Ravi Admin", createdAt: "2030-01-02T05:00:00.000Z" }] })]);
    const card = (await screen.findByRole("heading", { name: "0F3A-91B1" })).closest("li") as HTMLElement;
    expect(within(card).queryAllByRole("button")).toEqual([]);
    expect(card.textContent).toContain(strings.counterBillVoidBy(strings.counterBillUnknownPerson, formatDateTime(voided.createdAt)));
  });

  it("asks for a note before it sends anything", async () => {
    const { resolveCounterBill } = setup([bill(1)]);
    fireEvent.click(await screen.findByRole("button", { name: strings.counterBillActions.number }));
    expect((await screen.findByRole("alert")).textContent).toBe(strings.counterBillNoteRequired);
    fireEvent.change(screen.getByRole("textbox", { name: strings.counterBillNote }), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: strings.counterBillActions.note }));
    expect(resolveCounterBill).not.toHaveBeenCalled();
  });

  it("numbers a bill with the note, then moves it to the dealt-with list showing what was done", async () => {
    const saved = bill(1, { heldReason: null, number: 4, resolved: true, resolutions: [{ action: "numbered", note: "Sold at the counter", stockMoved: true, actorName: "Ravi Admin", createdAt: "2030-01-03T05:00:00.000Z" }] });
    const { resolveCounterBill } = setup([bill(1), bill(2)], vi.fn().mockResolvedValue({ ok: true, data: saved }));
    const card = (await screen.findByRole("heading", { name: "0F3A-91B1" })).closest("li") as HTMLElement;
    fireEvent.change(within(card).getByRole("textbox", { name: strings.counterBillNote }), { target: { value: " Sold at the counter " } });
    fireEvent.click(within(card).getByRole("button", { name: strings.counterBillActions.number }));
    await waitFor(() => expect(resolveCounterBill).toHaveBeenCalledWith(shopId, saved.id, { action: "number", note: "Sold at the counter" }));
    const done = (await screen.findByRole("region", { name: strings.counterBillsDone }));
    expect(done.textContent).toContain("0F3A-91B1");
    expect(done.textContent).toContain(`${strings.counterBillResolution.numbered} · ${strings.counterBillStockMoved}`);
    expect(done.textContent).toContain("Sold at the counter");
    expect(within(done).queryByRole("button")).toBeNull();
    expect(screen.getByRole("region", { name: strings.counterBillsOpen }).textContent).toContain("0F3A-91B2");
  });

  it("shows the server's reason when another Admin closed the bill first, and keeps the note", async () => {
    setup([bill(1)], vi.fn().mockResolvedValue({ ok: false, status: 409, code: "COUNTER_BILL_RESOLVED" }));
    fireEvent.change(await screen.findByRole("textbox", { name: strings.counterBillNote }), { target: { value: "My note" } });
    fireEvent.click(screen.getByRole("button", { name: strings.counterBillActions.number }));
    expect((await screen.findByRole("alert")).textContent).toBe(strings.errors.COUNTER_BILL_RESOLVED);
    expect((screen.getByRole("textbox", { name: strings.counterBillNote }) as HTMLTextAreaElement).value).toBe("My note");
  });

  it("says when nothing needs a decision", async () => {
    setup([]);
    expect(await screen.findByText(strings.counterBillsNoneOpen)).toBeTruthy();
    expect(screen.queryByRole("region", { name: strings.counterBillsDone })).toBeNull();
  });
});
