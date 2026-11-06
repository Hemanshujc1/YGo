import type { ReceiptResponse } from "@ygo/contracts";
import { formatDateTime, formatNumber } from "@ygo/format";
import { colors } from "@ygo/tokens";
import { strings } from "../strings";
import { money } from "./money";
import { packLabel } from "./shop-page";

/** Inter's three weights as base64 TTF, read from the app's own files when a receipt is shared. */
export type ReceiptFonts = { regular: string; medium: string; semibold: string };

const words = strings.order.receipt.pdf;
const light = (role: keyof typeof colors) => colors[role].light;
/** Every shop-held or server-sent text goes through this: a shop name or product name could hold markup. */
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
const face = (weight: number, data: string) => `@font-face{font-family:Inter;font-weight:${weight};src:url(data:font/ttf;base64,${data}) format("truetype")}`;
const some = (amount: string) => Number(amount) > 0;

/** "Aashirvaad · 2 × 5 kg", or "500 g of a 1 kg pack" for the part of a pack bought. Quantities, not money. */
function lineLabel(line: ReceiptResponse["lines"][number]): string {
  const pack = packLabel(line.quantity, line.baseUnit);
  return [line.brand, line.part ? strings.order.part(packLabel(line.part, line.baseUnit), pack) : `${formatNumber(line.count)} × ${pack}`].filter(Boolean).join(" · ");
}

/**
 * The shop's receipt for an online order (#61): always light, in Inter with tabular figures, amounts through
 * @ygo/format. It is in the shop's name and address, and shows only what the order froze: the lines, the delivery
 * fee and small-order fee when charged, the total, and how it was paid when that was recorded. Nothing of the
 * platform's, no tax line, and nothing that says or implies a profit (MNY-11).
 */
export function receiptHtml({ receipt, fonts }: { receipt: ReceiptResponse; fonts: ReceiptFonts }): string {
  const rows = receipt.lines.map((line) => `<tr><td>${escapeHtml(line.name)}<br><span class="muted">${escapeHtml(lineLabel(line))}</span></td><td class="n">${money(line.unitPrice)}</td><td class="n">${money(line.lineTotal)}</td></tr>`).join("");
  const sum = (label: string, amount: string) => `<p><span>${label}</span><span>${money(amount)}</span></p>`;
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
<h1>${escapeHtml(receipt.shop.name)}</h1>
<p>${escapeHtml(receipt.shop.address)} · ${escapeHtml(words.pincode(receipt.shop.pincode))}</p>
${receipt.shop.gstin ? `<p>${escapeHtml(words.gstin(receipt.shop.gstin))}</p>` : ""}
<p class="head">${words.number(receipt.number)}</p>
<p class="muted">${formatDateTime(receipt.placedAt)}</p>
<p>${words.address[receipt.status]}: ${escapeHtml(strings.confirm[receipt.address.label])}${receipt.address.areaLine ? ` · ${escapeHtml(receipt.address.areaLine)}` : ""}</p>
<table><thead><tr><th>${words.item}</th><th class="n">${words.price}</th><th class="n">${words.amount}</th></tr></thead><tbody>${rows}</tbody></table>
<div class="sums">
${sum(words.items, receipt.productValue)}
${some(receipt.deliveryFee) ? sum(words.deliveryFee, receipt.deliveryFee) : ""}
${receipt.smallCartFee && some(receipt.smallCartFee) ? sum(words.smallCartFee, receipt.smallCartFee) : ""}
<p class="total"><span>${words.total}</span><span>${money(receipt.total)}</span></p>
</div>
${receipt.payment ? `<p class="paid">${words.paidBy(words.payments[receipt.payment])}</p>` : ""}
</body></html>`;
}
