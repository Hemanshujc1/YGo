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
const texts = (quote: CartQuote) => elements(QuoteRows({ quote })).flatMap(({ props: { children } }) => typeof children === "string" ? [children] : []);

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
});
