import type { Statement } from "@ygo/contracts";
import { formatDateTime, formatDayMonthYear, formatMoney } from "@ygo/format";
import { strings } from "./strings";

const text = strings.statements;

/**
 * One weekly statement as the page and the print view both show it (#631, MNY-12): amounts owed to YGo, never earnings or profit.
 * Not a tax invoice, which the last line says in the exact words the PRD gives.
 */
export function StatementDocument({ statement }: { statement: Statement }) {
  const address = [statement.shopAddress, statement.shopPincode].filter(Boolean).join(", ");
  return <article className="statement-document">
    <h1 className="text-title-large font-semibold">{text.heading(statement.number)}</h1>
    <dl className="mt-4 grid gap-x-8 gap-y-2 sm:grid-cols-2">
      <div><dt className="text-sm text-muted">{text.shop}</dt><dd className="font-medium">{statement.shopName}</dd></div>
      <div><dt className="text-sm text-muted">{text.period}</dt><dd>{formatDayMonthYear(statement.periodStart)} – {formatDayMonthYear(statement.periodEnd)}</dd></div>
      <div><dt className="text-sm text-muted">{text.shopAddress}</dt><dd>{address || "—"}</dd></div>
      <div><dt className="text-sm text-muted">{text.due}</dt><dd>{formatDayMonthYear(statement.dueOn)}</dd></div>
    </dl>
    <div className="mt-6 overflow-x-auto rounded-xl border border-border bg-surface"><table className="w-full text-left">
      <thead><tr className="border-b border-border text-muted">
        {[text.order, text.completed, text.route, text.orderTotal, text.commission, text.feeShares, text.bookingFees, text.coupons, text.owed].map((label) => <th key={label} className="p-3 font-medium">{label}</th>)}
      </tr></thead>
      <tbody>{statement.lines.map((line) => <tr key={line.orderId} className="border-b border-border last:border-0">
        <td className="p-3">#{line.orderNumber}</td>
        <td className="p-3">{formatDateTime(line.completedAt)}{line.late && <span className="ml-2 font-medium">{text.late}</span>}</td>
        <td className="p-3">{line.fulfilment === "delivery" ? text.delivery : text.pickup}</td>
        <td className="p-3">{formatMoney(line.orderTotal)}</td>
        <td className="p-3">{formatMoney(line.commission)}</td>
        <td className="p-3">{formatMoney(line.feeShare)}</td>
        <td className="p-3">{formatMoney(line.bookingFees)}</td>
        <td className="p-3">{formatMoney(line.platformCoupon)}</td>
        <td className="p-3 font-medium">{formatMoney(line.owed)}</td>
      </tr>)}</tbody>
    </table></div>
    <p className="mt-4 text-title font-semibold">{text.statementTotal}: {formatMoney(statement.total)}</p>
    <p className="mt-2 text-muted">{text.notTaxInvoice}</p>
  </article>;
}
