import type { Statement } from "@ygo/contracts";
import { formatDayMonthYear } from "@ygo/format";
import { describe, expect, it } from "vitest";
import { statementHtml } from "../src/lib/statement-pdf";

const fonts = { regular: "UkVH", medium: "TUVE", semibold: "U0VN" };
const id = "7d2e9a4c-6b1f-4c3a-8e5d-0f2a4b6c8d1e";
const statement: Statement = {
  id, number: 7, shopId: id, shopName: "Sai & Sons", periodStart: "2026-11-02", periodEnd: "2026-11-08", issuedAt: "2026-11-09T00:30:00.000Z", dueOn: "2026-11-16",
  orderCount: 2, total: "107.50", shopAddress: "12 <MG> Road", shopPincode: "411038",
  lines: [
    { orderId: id, orderNumber: 1001, completedAt: "2026-11-03T06:30:00.000Z", late: false, fulfilment: "delivery", orderTotal: "500.00", commission: "50.00", feeShare: "10.00", bookingFees: "0.00", platformCoupon: "0.00", owed: "60.00" },
    { orderId: id, orderNumber: 1002, completedAt: "2026-10-30T06:30:00.000Z", late: true, fulfilment: "pickup", orderTotal: "300.00", commission: "30.00", feeShare: "0.00", bookingFees: "5.00", platformCoupon: "7.50", owed: "27.50" },
  ],
};
const text = (html: string) => html.replace(/<style>[\s\S]*<\/style>/, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("the statement PDF (#630, MNY-12)", () => {
  it("says on its face that it is not a tax invoice, with the number, the shop, the week, the due date and the total", () => {
    const page = text(statementHtml({ statement, fonts }));
    for (const part of ["Statement 7", "Sai &amp; Sons", "12 &lt;MG&gt; Road", "411038", `Due ${formatDayMonthYear("2026-11-16")}`, "Total owed to YGo ₹107.50", "not a tax invoice"]) {
      expect(page).toContain(part);
    }
  });

  it("lists each order with what the shop owes on it, and marks a late one", () => {
    const page = text(statementHtml({ statement, fonts }));
    expect(page).toContain("Order #1001");
    expect(page).toContain("Order #1002");
    expect(page).toContain("Late");
    expect(page).toContain("₹27.50");
    expect(page.match(/Late/g)).toHaveLength(1);
  });

  it("shows amounts without trailing zeros, and never says or implies profit", () => {
    const html = statementHtml({ statement, fonts });
    expect(text(html)).not.toMatch(/\.00\b/);
    expect(text(html)).not.toMatch(/profit|margin|earning/i);
  });
});
