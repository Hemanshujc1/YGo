import type { Statement } from "@ygo/contracts";
import { formatDateTime, formatDayMonth, formatDayMonthYear } from "@ygo/format";
import { toPaise } from "@ygo/pricing";
import { colors } from "@ygo/tokens";
import { strings } from "../strings";
import type { BillFonts } from "./bill-pdf";
import { money } from "./money";

const words = strings.money;
const light = (role: keyof typeof colors) => colors[role].light;
const escape = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
const face = (weight: number, data: string) => `@font-face{font-family:Inter;font-weight:${weight};src:url(data:font/ttf;base64,${data}) format("truetype")}`;
const isZero = (amount: string) => toPaise(amount) === 0n;

/**
 * A weekly statement as the page the Owner shares (#630, MNY-12): a commercial statement that says on its face it is not a tax invoice,
 * with the shop as it was when the statement was made, each completed order and what the shop owes YGo on it. Sales and amounts owed
 * only, never profit (MNY-11). Always light, in Inter with tabular figures, amounts through @ygo/format.
 */
export function statementHtml({ statement, fonts }: { statement: Statement; fonts: BillFonts }): string {
  const rows = statement.lines.map((line) => `<tr><td>${words.order(line.orderNumber)}${line.late ? ` <span class="late">${words.late}</span>` : ""}<br><span class="muted">${formatDateTime(line.completedAt)}</span></td>
<td class="n">${money(line.orderTotal)}</td><td class="n">${money(line.commission)}</td><td class="n">${money(line.feeShare)}</td><td class="n">${money(line.bookingFees)}</td>
<td class="n">${isZero(line.platformCoupon) ? "–" : `−${money(line.platformCoupon)}`}</td><td class="n owed">${money(line.owed)}</td></tr>`).join("");
  const address = [statement.shopAddress, statement.shopPincode].filter(Boolean).map((part) => escape(part ?? "")).join(", ");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${face(400, fonts.regular)}${face(500, fonts.medium)}${face(600, fonts.semibold)}
@page{size:A4;margin:16mm}
html,body{background:${light("surface")};color:${light("text")}}
body{margin:0;font-family:Inter,"Noto Sans",sans-serif;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
h1{margin:0 0 4px;font-size:24px;line-height:34px;font-weight:600}
p{margin:0}
.head{font-size:18px;line-height:26px;font-weight:600;margin-top:8px}
.muted{color:${light("muted")}}
.notice{margin-top:12px;font-weight:600}
.late{color:${light("danger")};font-weight:600}
table{width:100%;border-collapse:collapse;margin-top:20px}
th{font-weight:500;color:${light("muted")};text-align:left;border-bottom:1px solid ${light("border")};padding:6px 0}
td{padding:6px 0;border-bottom:1px solid ${light("border")};vertical-align:top}
th.n,td.n{text-align:right;padding-left:10px;white-space:nowrap}
.owed{font-weight:600}
.sums{margin-top:16px;margin-left:auto;width:50%}
.sums p{display:flex;justify-content:space-between;padding:4px 0}
.total{font-size:16px;line-height:24px;font-weight:600;border-top:1px solid ${light("border-strong")};margin-top:4px;padding-top:8px}
</style></head><body>
<h1>${escape(statement.shopName)}</h1>
${address ? `<p class="muted">${address}</p>` : ""}
<p class="head">${words.number(statement.number)}</p>
<p>${words.week(formatDayMonth(statement.periodStart), formatDayMonthYear(statement.periodEnd))} · ${words.orders(statement.orderCount)}</p>
<p class="muted">${strings.money.pdf.issued(formatDayMonthYear(statement.issuedAt))} · ${words.due(formatDayMonthYear(statement.dueOn))}</p>
<p class="notice">${words.notTaxInvoice}</p>
<table><thead><tr><th>${strings.money.pdf.orders}</th><th class="n">${words.orderTotal}</th><th class="n">${words.commission}</th><th class="n">${words.feeShare}</th><th class="n">${words.bookingFees}</th><th class="n">${words.coupon}</th><th class="n">${words.owed}</th></tr></thead><tbody>${rows}</tbody></table>
<div class="sums"><p class="total"><span>${words.total}</span><span>${money(statement.total)}</span></p></div>
<p class="muted">${words.lateNote}</p>
</body></html>`;
}
