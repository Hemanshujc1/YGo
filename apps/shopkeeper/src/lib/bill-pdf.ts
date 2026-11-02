import { formatDateTime, formatNumber } from "@ygo/format";
import { packLabel } from "@ygo/mobile/pack-label";
import { counterBillTotal } from "@ygo/pricing";
import { colors } from "@ygo/tokens";
import { strings } from "../strings";
import { money } from "./money";
import type { BillRow, PackName } from "./opening-stock-queue";

/** Inter's three weights as base64 TTF, read from the app's own files when a bill is shared. */
export type BillFonts = { regular: string; medium: string; semibold: string };
export type BillPdf = { bill: BillRow; shopName: string | null; label: (packId: string) => PackName | null; fonts: BillFonts };

const words = strings.bill.pdf;
const light = (role: keyof typeof colors) => colors[role].light;
const escape = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
const face = (weight: number, data: string) => `@font-face{font-family:Inter;font-weight:${weight};src:url(data:font/ttf;base64,${data}) format("truetype")}`;

/**
 * A counter bill as the page the customer gets (#53): always light, in Inter with tabular figures, amounts through
 * @ygo/format. It shows the shop, the bill number (or "Number pending"), the reference, the date, each line, any discount,
 * the total, the payment and the customer's name; never their phone or the offers tick.
 */
export function billHtml({ bill, shopName, label, fonts }: BillPdf): string {
  const lines = [
    ...bill.lines.map((line) => {
      const pack = label(line.packId);
      return { name: pack ? `${pack.name} · ${packLabel(pack.packQuantity, pack.baseUnit, strings.orders.units)}` : words.unknownItem, count: line.count, unitPrice: line.unitPrice };
    }),
    ...(bill.manualLines ?? []).map((line) => ({ name: line.name, count: line.count, unitPrice: line.unitPrice })),
  ];
  const sum = counterBillTotal(lines) ?? "0";
  const rows = lines.map((line) => `<tr><td>${escape(line.name)}</td><td class="n">${formatNumber(line.count)}</td><td class="n">${money(line.unitPrice)}</td><td class="n">${money(counterBillTotal([line]) ?? "0")}</td></tr>`).join("");
  const name = bill.customer?.name;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${face(400, fonts.regular)}${face(500, fonts.medium)}${face(600, fonts.semibold)}
@page{size:A4;margin:16mm}
html,body{background:${light("surface")};color:${light("text")}}
body{margin:0;font-family:Inter,"Noto Sans",sans-serif;font-size:14px;line-height:21px;font-variant-numeric:tabular-nums}
h1{margin:0 0 4px;font-size:24px;line-height:34px;font-weight:600}
p{margin:0}
.head{font-size:18px;line-height:26px;font-weight:600;margin-top:8px}
.muted{color:${light("muted")}}
table{width:100%;border-collapse:collapse;margin-top:24px}
th{font-weight:500;color:${light("muted")};text-align:left;border-bottom:1px solid ${light("border")};padding:8px 0}
td{padding:8px 0;border-bottom:1px solid ${light("border")};vertical-align:top}
th.n,td.n{text-align:right;padding-left:16px;white-space:nowrap}
.sums{margin-top:16px;margin-left:auto;width:50%}
.sums p{display:flex;justify-content:space-between;padding:4px 0}
.total{font-size:18px;line-height:26px;font-weight:600;border-top:1px solid ${light("border-strong")};margin-top:4px;padding-top:8px}
.paid{margin-top:24px}
</style></head><body>
${shopName ? `<h1>${escape(shopName)}</h1>` : ""}
<p class="head">${bill.number !== null ? words.number(bill.number) : words.numberPending}</p>
<p class="muted">${words.reference(bill.reference)} · ${formatDateTime(bill.createdAt)}</p>
${name ? `<p>${escape(words.customer(name))}</p>` : ""}
<table><thead><tr><th>${words.item}</th><th class="n">${words.count}</th><th class="n">${words.price}</th><th class="n">${words.amount}</th></tr></thead><tbody>${rows}</tbody></table>
<div class="sums">
${bill.discount ? `<p><span>${words.items}</span><span>${money(sum)}</span></p><p><span>${words.discount}</span><span>${money(bill.discount)}</span></p>` : ""}
<p class="total"><span>${words.total}</span><span>${money(bill.total)}</span></p>
</div>
<p class="paid">${words.paidBy(strings.bill.payments[bill.payment])}</p>
</body></html>`;
}
