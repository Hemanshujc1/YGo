import type { CartQuote } from "@ygo/contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ygo/mobile", () => ({ Text: "Text" }));
vi.mock("react-native", () => ({ View: "View" }));
import { QuoteRows } from "../src/components/quote-rows";

type El = { type: unknown; props: Record<string, unknown> };
function elements(node: unknown): El[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as El;
  if (typeof element.type === "function") return elements((element.type as (props: unknown) => unknown)(element.props));
  return [element, ...elements(element.props.children)];
}
const texts = (quote: CartQuote, was?: { productValue: string; total: string }, pickup?: { fee: string | null }) => elements(QuoteRows({ quote, was, pickup })).flatMap(({ props: { children } }) => typeof children === "string" ? [children] : []);

describe("the quote rows (#571, CRT-5)", () => {
  const quote: CartQuote = { productValue: "100.00", shopDiscount: null, deliveryFee: "30.00", smallCartFee: null, total: "130.00" };

  it("shows no discount row when none applied", () => {
    expect(texts(quote)).toEqual(["Items", "₹100", "Delivery", "₹30", "Total to pay", "₹130"]);
  });

  it("shows the discount and its offer between the items and the delivery, as a minus, with no trailing zeros", () => {
    expect(texts({ ...quote, shopDiscount: { amount: "5.00", offer: { form: "percentage", percentage: "5", cap: "50" } }, total: "125.00" }))
      .toEqual(["Items", "₹100", "Shop discount", "5% off, up to ₹50", "−₹5", "Delivery", "₹30", "Total to pay", "₹125"]);
    expect(texts({ ...quote, productValue: "999.50", shopDiscount: { amount: "200.00", offer: { form: "flat", amount: "200", minimumOrder: "1000" } }, total: "829.50" }))
      .toContain("₹200 off orders of ₹1,000 or more");
  });

  it("shows no small cart fee row for a zero fee, and the fee when there is one (#578)", () => {
    expect(texts({ ...quote, smallCartFee: "0.00" })).not.toContain("Small cart fee");
    expect(texts({ ...quote, smallCartFee: "15.00", total: "145.00" })).toContain("Small cart fee");
  });

  it("strikes the replaced items and total only where they differ (#578)", () => {
    expect(texts({ ...quote, productValue: "50.00", total: "80.00" }, { productValue: "100.00", total: "130.00" })).toEqual(["Items", "₹100", "₹50", "Delivery", "₹30", "Total to pay", "₹130", "₹80"]);
    expect(texts(quote, { productValue: "100.00", total: "130.00" })).toEqual(["Items", "₹100", "Delivery", "₹30", "Total to pay", "₹130"]);
  });

  it("for a pickup shows no delivery or small cart row, and names the booking fee when there is one (FUL-7, #65)", () => {
    const pickup: CartQuote = { ...quote, deliveryFee: "0.00", total: "110.00" };
    expect(texts(pickup, undefined, { fee: "10.00" })).toEqual(["Items", "₹100", "Booking fee", "Charged when you collect", "₹10", "Total to pay", "₹110"]);
    expect(texts({ ...pickup, total: "100.00" }, undefined, { fee: "0.00" })).toEqual(["Items", "₹100", "Total to pay", "₹100"]);
    expect(texts({ ...pickup, total: "100.00" }, undefined, { fee: null })).toEqual(["Items", "₹100", "Total to pay", "₹100"]);
  });
});
