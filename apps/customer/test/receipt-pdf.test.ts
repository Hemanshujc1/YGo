import type { ReceiptResponse } from "@ygo/contracts";
import { colors } from "@ygo/tokens";
import { describe, expect, it } from "vitest";
import { escapeHtml, receiptHtml } from "../src/lib/receipt-pdf";

const fonts = { regular: "UkVH", medium: "TUVE", semibold: "U0VN" };
const receipt = (over: Partial<ReceiptResponse> = {}): ReceiptResponse => ({
  number: 1042, status: "delivered", placedAt: "2030-01-01T04:30:00.000Z",
  shop: { name: "Sai General Stores", address: "Shop 3, Paud Road", pincode: "411038", gstin: "27ABCDE1234F1Z5" },
  address: { label: "home", areaLine: "Kothrud" },
  lines: [
    { name: "Toor Dal", brand: "Tata", baseUnit: "kg", quantity: "1.000", count: 2, part: null, unitPrice: "150.00", lineTotal: "300.00" },
    { name: "Atta", brand: null, baseUnit: "kg", quantity: "5.000", count: 1, part: "0.500", unitPrice: "30.00", lineTotal: "30.00" },
  ],
  productValue: "330.00", shopDiscount: null, deliveryFee: "20.00", smallCartFee: "10.50", pickupFee: null, total: "360.50", payment: "upi", ...over,
});

describe("receipt PDF (#61)", () => {
  const html = receiptHtml({ receipt: receipt(), fonts });

  it("is light in both themes, in Inter with tabular figures", () => {
    expect(html).toContain(`background:${colors.surface.light}`);
    expect(html).not.toContain(colors.surface.dark);
    expect(html).toContain("font-variant-numeric:tabular-nums");
    for (const weight of [400, 500, 600]) expect(html).toContain(`font-weight:${weight};src:url(data:font/ttf;base64,`);
    expect(html).toContain('"Noto Sans"');
  });

  it("is in the shop's name and address and shows the frozen lines and amounts with no trailing zeros", () => {
    expect(html).toContain("<h1>Sai General Stores</h1>");
    expect(html).toContain("Shop 3, Paud Road");
    expect(html).toContain("GSTIN: 27ABCDE1234F1Z5");
    expect(html).toContain("Order #1042");
    expect(html).toContain("Delivered to: Home · Kothrud");
    expect(html).not.toMatch(/\+91|phone/i);
    expect(html).toContain("Tata · 2 × 1 kg");
    expect(html).toContain("500 g of a 5 kg pack");
    for (const text of ["₹150", "₹300", "₹330", "₹20", "₹10.50", "₹360.50", "Paid by UPI"]) expect(html).toContain(text);
    expect(html).not.toMatch(/\.00|1\.000|5\.000/);
  });

  it("words the address by status: Delivered to, or Order address for a pickup", () => {
    const picked = receiptHtml({ receipt: receipt({ status: "picked_up" }), fonts });
    expect(picked).toContain("Order address: Home · Kothrud");
    expect(picked).not.toContain("Delivered to");
    expect(html).not.toContain("Order address");
  });

  it("keeps money and quantity formats apart: a count and a pack size never get a rupee sign", () => {
    expect(html).toContain("2 × 1 kg");
    expect(html).not.toContain("₹2 ");
  });

  it("says nothing of a profit, a platform, a tax or a discount (MNY-11)", () => {
    const text = html.replace(/<style>[\s\S]*<\/style>/, "").replace(/<[^>]+>/g, " ");
    expect(text).not.toMatch(/profit|margin|commission|platform|ygo|gst(?!in)|tax|discount|saving|saved|mrp|contribution/i);
  });

  it("leaves the GSTIN line out when the shop has none, never printing a placeholder (#537)", () => {
    const none = receiptHtml({ receipt: receipt({ shop: { name: "Sai", address: "Paud Road", pincode: "411038", gstin: null } }), fonts });
    expect(none).not.toMatch(/GSTIN|null|undefined/);
  });

  it("leaves out a fee that wasn't charged and a payment that wasn't recorded", () => {
    const plain = receiptHtml({ receipt: receipt({ deliveryFee: "0.00", smallCartFee: null, payment: null }), fonts });
    expect(plain).not.toContain("Delivery fee");
    expect(plain).not.toContain("Small order fee");
    expect(plain).not.toContain("Paid by");
    expect(plain).toContain("₹360.50");
  });

  it("escapes every value the shop or the catalogue wrote", () => {
    const evil = `<img src=x onerror="alert('1')"> & Co`;
    const out = receiptHtml({
      receipt: receipt({ shop: { name: evil, address: evil, pincode: "<b>", gstin: evil }, address: { label: "home", areaLine: evil }, lines: [{ name: evil, brand: evil, baseUnit: "each", quantity: "1", count: 1, part: null, unitPrice: "5", lineTotal: "5" }] }),
      fonts,
    });
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<b>");
    expect(out).toContain("&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt; &amp; Co");
    expect(escapeHtml("a&b")).toBe("a&amp;b");
  });

  it("shows the shop discount with its offer when one applied, as a minus that makes the rows add up, and nothing when none did (#571)", () => {
    const none = receiptHtml({ receipt: receipt(), fonts });
    expect(none).not.toContain("Shop discount");
    const discounted = receiptHtml({ receipt: receipt({ shopDiscount: { amount: "33.00", offer: { form: "percentage", percentage: "10", cap: "50" } }, total: "327.50" }), fonts });
    expect(discounted).toContain("Shop discount");
    expect(discounted).toContain("10% off, up to ₹50");
    expect(discounted).toContain("\u2212₹33");
    expect(discounted).not.toMatch(/\.00/);
    expect(discounted.indexOf("₹330")).toBeLessThan(discounted.indexOf("Shop discount"));
    expect(discounted.indexOf("Shop discount")).toBeLessThan(discounted.indexOf("Delivery fee"));
    const flat = receiptHtml({ receipt: receipt({ shopDiscount: { amount: "200.00", offer: { form: "flat", amount: "200", minimumOrder: "1000" } } }), fonts });
    expect(flat).toContain("₹200 off orders of ₹1,000 or more");
  });
});
