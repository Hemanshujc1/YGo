import { describe, expect, it } from "vitest";
import { billHtml } from "../src/lib/bill-pdf";
import type { BillRow } from "../src/lib/opening-stock-queue";

const rice = "00000000-0000-4000-8000-000000000002", gone = "00000000-0000-4000-8000-000000000003";
const fonts = { regular: "UkVH", medium: "TUVE", semibold: "U0VN" };
const label = (packId: string) => packId === rice ? { name: "Rice", packQuantity: "0.500", baseUnit: "kg" as const } : null;
const bill: BillRow = {
  id: "a1b2c3d4-0000-4000-8000-000000000001", reference: "A1B2-C3D4", createdAt: "2026-11-02T06:30:00.000Z", status: "synced", number: 42, code: null,
  lines: [{ packId: rice, count: 2, unitPrice: "21.00" }, { packId: gone, count: 1, unitPrice: "10" }],
  manualLines: [{ name: "Rope <thick>", count: 1, unitPrice: "15.50" }], discount: "5",
  customer: { name: "Meera", phone: "+919876543210", offers: true }, total: "62.50", payment: "upi",
};
const text = (html: string) => html.replace(/<style>[\s\S]*<\/style>/, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("the bill PDF (#53)", () => {
  it("shows the shop, number, reference, date, lines, discount, total, payment and the customer's name, without trailing zeros", () => {
    const page = text(billHtml({ bill, shopName: "Sai & Sons", label, fonts }));
    for (const part of ["Sai &amp; Sons", "Bill 42", "Reference A1B2-C3D4 · 02/11/2026, 12:00 PM", "Customer: Meera",
      "Rice · 500 g 2 ₹21 ₹42", "Item 1 ₹10 ₹10", "Rope &lt;thick&gt; 1 ₹15.50 ₹15.50", "Items ₹67.50", "Discount ₹5", "Total ₹62.50", "Paid by UPI"]) {
      expect(page).toContain(part);
    }
    expect(page).not.toMatch(/\.00\b/);
  });

  it("never shows the customer's phone or the offers tick", () => {
    const html = billHtml({ bill, shopName: "Sai", label, fonts });
    expect(html).not.toMatch(/98765|9876543210|offers/i);
  });

  it("says Number pending before sync or while held, and leaves out what the bill doesn't have", () => {
    const plain = { ...bill, status: "held" as const, number: null, discount: undefined, customer: undefined };
    const page = text(billHtml({ bill: plain, shopName: null, label, fonts }));
    expect(page).toContain("Number pending");
    expect(page).not.toMatch(/Bill \d|Customer|Discount|Items ₹/);
    expect(billHtml({ bill: plain, shopName: null, label, fonts })).not.toContain("<h1>");
  });

  it("is always light, in embedded Inter at 400, 500 and 600 with tabular figures", () => {
    const html = billHtml({ bill, shopName: "Sai", label, fonts });
    for (const [weight, data] of [[400, "UkVH"], [500, "TUVE"], [600, "U0VN"]]) {
      expect(html).toContain(`font-weight:${weight};src:url(data:font/ttf;base64,${data})`);
    }
    expect(html).toContain("font-variant-numeric:tabular-nums");
    expect(html).toContain("background:#FFFFFF;color:#0D1A20");
    expect(html).not.toContain("prefers-color-scheme");
  });
});
