import { describe, expect, it } from "vitest";
import { type DraftInput, draftBill } from "../src/lib/bill-draft";

const packId = "00000000-0000-4000-8000-000000000002";
const blank: DraftInput = { lines: [], typed: [], discount: "", customer: { name: "", phone: "", offers: false }, payment: "cash" };
const rope = { key: "1", name: " Rope ", price: "15", count: "2" };

describe("the Bill screen's form (#53)", () => {
  it("builds a bill of catalog and typed lines less a discount, with the customer and their consent", () => {
    const draft = draftBill({ ...blank, lines: [{ packId, unitPrice: "21.00", count: "3" }], typed: [rope], discount: "3",
      customer: { name: "Meera", phone: "98765 43210", offers: true }, payment: "upi" });
    expect(draft).toMatchObject({ sum: "93.00", total: "90.00" });
    expect(draft.payload).toEqual({ lines: [{ packId, count: 3, unitPrice: "21.00" }], manualLines: [{ name: "Rope", count: 2, unitPrice: "15" }], discount: "3",
      customer: { name: "Meera", phone: "+919876543210", offers: true }, total: "90.00", payment: "upi" });
  });

  it("leaves out an empty or zero discount and empty customer fields, so a plain bill stays as before", () => {
    expect(draftBill({ ...blank, typed: [rope], discount: "0" }).payload).toEqual({ lines: [], manualLines: [{ name: "Rope", count: 2, unitPrice: "15" }], total: "30.00", payment: "cash" });
    expect(draftBill({ ...blank, lines: [{ packId, unitPrice: "21", count: "1" }] }).payload).toEqual({ lines: [{ packId, count: 1, unitPrice: "21" }], total: "21.00", payment: "cash" });
  });

  it("drops the offers tick without a readable phone, and keeps a name on its own", () => {
    expect(draftBill({ ...blank, typed: [rope], customer: { name: "Meera", phone: "", offers: true } }).payload?.customer).toEqual({ name: "Meera", offers: false });
  });

  it("names each wrong field and queues nothing", () => {
    const draft = draftBill({ ...blank, lines: [{ packId, unitPrice: "21", count: "0" }],
      typed: [{ key: "a", name: "", price: "15", count: "1" }, { key: "b", name: "Tape", price: "1.505", count: "1" }, { key: "c", name: "Box", price: "5", count: "10000" }],
      discount: "1.5.0", customer: { name: " ", phone: "12345", offers: true } });
    expect(draft.problems).toEqual({ counts: { [packId]: true }, typed: { a: "name", b: "price", c: "count" }, discount: "format", customerName: false, phone: true });
    expect(draft).toMatchObject({ sum: null, total: null, payload: null });
    expect(draftBill({ ...blank, typed: [rope], customer: { name: "x".repeat(81), phone: "", offers: false } }).problems.customerName).toBe(true);
    expect(draftBill({ ...blank, typed: [rope], customer: { name: "\ud800", phone: "", offers: false } }).problems.customerName).toBe(true);
    expect(draftBill({ ...blank, typed: [{ key: "a", name: "\ud800", price: "15", count: "1" }] }).problems.typed.a).toBe("name");
  });

  it("refuses a discount of more than the items, and allows one of all of them", () => {
    const over = draftBill({ ...blank, typed: [rope], discount: "30.01" });
    expect(over).toMatchObject({ sum: "30.00", total: null, payload: null });
    expect(over.problems.discount).toBe("tooBig");
    expect(draftBill({ ...blank, typed: [rope], discount: "30" }).payload).toMatchObject({ discount: "30", total: "0.00" });
  });

  it("waits for a line and a payment", () => {
    expect(draftBill(blank).payload).toBeNull();
    expect(draftBill({ ...blank, typed: [rope], payment: null }).payload).toBeNull();
  });
});
