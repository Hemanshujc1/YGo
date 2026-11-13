import type { createAdminApiClient } from "@ygo/api-client";
import type { ShopBalancesResponse, StatementSummary } from "@ygo/contracts";
import { formatDayMonth, formatDayMonthYear, formatMoney } from "@ygo/format";
import { useRef, useState } from "react";
import { Link, useLoaderData } from "react-router";
import { strings } from "./strings";

type AdminApi = ReturnType<typeof createAdminApiClient>;
export type StatementsPage = { balances: ShopBalancesResponse["balances"]; statements: StatementSummary[]; nextBefore: number | null };

const text = strings.statements;

/** A "YYYY-MM-DD" day that falls on a Monday, which is where every statement week starts (IST, #629). */
const isMonday = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) && new Date(`${day}T00:00:00Z`).getUTCDay() === 1;

/**
 * A18 Statements (ADM-6, MNY-8, MNY-12, #631): what every shop owes YGo now, and the weekly statements newest first, by week if wanted.
 * Admin only; the server refuses Area Managers too. Payments, paid or overdue and limits come with #79.
 */
export function Statements({ api }: { api: AdminApi }) {
  const initial = useLoaderData() as StatementsPage;
  const [rows, setRows] = useState(initial.statements);
  const [nextBefore, setNextBefore] = useState(initial.nextBefore);
  const [week, setWeek] = useState("");
  const [weekError, setWeekError] = useState(false);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  // The week the list now shows and the latest ask, so an answer to an older ask never replaces a newer one.
  const shown = useRef("");
  const ask = useRef(0);
  // Whether the ask in flight changes the week (not a Load more), so going back to the shown week can drop it.
  const filtering = useRef(false);

  async function load(day: string, before?: number) {
    const mine = ++ask.current;
    filtering.current = before === undefined;
    setBusy(true); setError(false);
    try {
      const answer = await api.listStatements({ ...(day ? { week: day } : {}), ...(before !== undefined ? { before } : {}) });
      if (mine !== ask.current) return;
      if (!answer.ok) { setError(true); if (before === undefined) setWeek(shown.current); return; }
      shown.current = day;
      setRows((current) => before === undefined ? answer.data.statements : [...current, ...answer.data.statements]);
      setNextBefore(answer.data.nextBefore);
    } catch { if (mine === ask.current) { setError(true); if (before === undefined) setWeek(shown.current); } }
    finally { if (mine === ask.current) { filtering.current = false; setBusy(false); } }
  }

  // Drops a week change in flight, so its answer cannot land. A Load more in flight is not a week change and is kept.
  function cancelFilter() {
    if (!filtering.current) return;
    ask.current++; filtering.current = false; setBusy(false); setError(false);
  }

  function pick(day: string) {
    setWeek(day);
    // A week change in flight no longer matches the input, so its answer must not land.
    if (day && !isMonday(day)) { cancelFilter(); setWeekError(true); return; }
    setWeekError(false);
    // Back on the week already shown (or a half-typed date, which the browser reports as empty): no new ask, and a week change still
    // in flight is dropped so its answer cannot replace these rows. A Load more in flight is not a week change and is kept.
    if (day === shown.current) { cancelFilter(); return; }
    // A new week, or none, starts the list again from the newest statement.
    void load(day);
  }

  return <section>
    <h1 className="text-title-large font-semibold">{text.title}</h1>
    <p className="mt-2 text-muted">{text.intro}</p>
    <h2 className="mt-8 text-title font-semibold">{text.balances}</h2>
    {initial.balances.length === 0 ? <p className="mt-3 text-muted">{text.noBalances}</p> :
      <div className="mt-3 overflow-x-auto rounded-xl border border-border bg-surface"><table className="w-full text-left">
        <thead><tr className="border-b border-border text-muted">
          <th className="p-3 font-medium">{text.shop}</th><th className="p-3 font-medium">{text.onStatements}</th><th className="p-3 font-medium">{text.thisWeek}</th><th className="p-3 font-medium">{text.total}</th>
        </tr></thead>
        <tbody>{initial.balances.map((row) => <tr key={row.shopId} className="border-b border-border last:border-0">
          <td className="p-3">{row.shopName}</td><td className="p-3">{formatMoney(row.onStatements)}</td><td className="p-3">{formatMoney(row.thisWeek)}</td><td className="p-3 font-medium">{formatMoney(row.total)}</td>
        </tr>)}</tbody>
      </table></div>}
    <h2 className="mt-8 text-title font-semibold">{text.list}</h2>
    <div className="mt-3 flex flex-wrap items-end gap-3">
      <label className="block">{text.week}
        <input type="date" value={week} onChange={(event) => pick(event.target.value)} aria-invalid={weekError} className="mt-1 block h-11 rounded-lg border border-border bg-surface px-3" />
      </label>
      {week && <button type="button" onClick={() => pick("")} className="h-11 rounded-lg border border-border-strong px-4 text-primary">{text.clearWeek}</button>}
    </div>
    {weekError && <p role="alert" className="mt-2 text-danger">{text.pickMonday}</p>}
    {error && <p role="alert" className="mt-3 rounded-lg bg-danger-subtle p-3 text-on-danger-subtle">{text.loadFailed}</p>}
    {rows.length === 0 ? <p className="mt-4 text-muted">{shown.current ? text.noneForWeek : text.none}</p> :
      <div className="mt-4 overflow-x-auto rounded-xl border border-border bg-surface"><table className="w-full text-left">
        <thead><tr className="border-b border-border text-muted">
          <th className="p-3 font-medium">{text.statement}</th><th className="p-3 font-medium">{text.shop}</th><th className="p-3 font-medium">{text.period}</th>
          <th className="p-3 font-medium">{text.due}</th><th className="p-3 font-medium">{text.orders}</th><th className="p-3 font-medium">{text.owed}</th>
        </tr></thead>
        <tbody>{rows.map((row) => <tr key={row.id} className="border-b border-border last:border-0">
          <td className="p-3"><Link to={`/statements/${row.id}`} className="font-medium text-primary">#{row.number}</Link></td>
          <td className="p-3">{row.shopName}</td>
          <td className="p-3">{formatDayMonth(row.periodStart)} – {formatDayMonthYear(row.periodEnd)}</td>
          <td className="p-3">{formatDayMonthYear(row.dueOn)}</td>
          <td className="p-3">{row.orderCount}</td>
          <td className="p-3 font-medium">{formatMoney(row.total)}</td>
        </tr>)}</tbody>
      </table></div>}
    {nextBefore !== null && !weekError && <button type="button" disabled={busy} onClick={() => void load(shown.current, nextBefore)} className="mt-4 h-11 rounded-lg border border-border-strong px-4 text-primary">{text.loadMore}</button>}
  </section>;
}
