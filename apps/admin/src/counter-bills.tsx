import type { createAdminApiClient } from "@ygo/api-client";
import { AdminActionReason, type AdminCounterBill, type AdminCounterBillVoid, type AdminFlaggedQuantityOption, type AdminShopApplication, type CounterBillResolutionAction } from "@ygo/contracts";
import { formatDateTime, formatMoney, trimDecimal } from "@ygo/format";
import { useState } from "react";
import { Link, useLoaderData } from "react-router";
import { strings } from "./strings";

type AdminApi = ReturnType<typeof createAdminApiClient>;
export type CounterBillsData = { application: AdminShopApplication; bills: AdminCounterBill[]; flaggedOptions?: AdminFlaggedQuantityOption[] };

function Lines({ lines, manualLines, discount }: Pick<AdminCounterBill, "lines" | "manualLines" | "discount">) {
  return <ul className="mt-1 space-y-1">{lines.map((line, index) => <li key={`${line.packId}-${index}`}>
    {strings.counterBillLine(line.name ? `${line.name} ${trimDecimal(line.packQuantity ?? "")} ${line.baseUnit ?? ""}`.trim() : strings.counterBillPackGone, line.count, formatMoney(line.unitPrice))}
  </li>)}
  {manualLines.map((line, index) => <li key={`typed-${index}`}>{strings.counterBillLine(strings.counterBillTyped(line.name), line.count, formatMoney(line.unitPrice))}</li>)}
  {Number(discount) > 0 && <li>{strings.counterBillDiscount(formatMoney(discount))}</li>}</ul>;
}

function Voided({ voided }: { voided: AdminCounterBillVoid }) {
  return <div className="mt-2 rounded-lg bg-danger-subtle p-3 text-on-danger-subtle">
    <p className="font-medium">{strings.counterBillVoided}</p>
    <p>{strings.counterBillVoidedLine(strings.counterBillVoidReason[voided.reason], voided.note, voided.stockMoved ? strings.counterBillVoidStock.moved : strings.counterBillVoidStock.notMoved)}</p>
    <p>{strings.counterBillVoidBy(voided.actorName ?? strings.counterBillUnknownPerson, formatDateTime(voided.createdAt))}</p>
  </div>;
}

/** What Admin may do with a bill that is still open, from the same rules the server holds it to. A voided bill takes a note only. */
function actionsFor(bill: AdminCounterBill): CounterBillResolutionAction[] {
  if (bill.resolutions.some((resolution) => resolution.action !== "noted")) return [];
  if (bill.voided) return ["note"];
  const actions: CounterBillResolutionAction[] = [];
  if (bill.heldReason && bill.heldReason !== "invalid") actions.push("number");
  if (bill.heldReason === "reference_taken") actions.push("duplicate");
  if (bill.heldReason === "invalid" || (bill.number !== null && (bill.totalMismatch || bill.flaggedDenylist))) actions.push("review");
  actions.push("note");
  return actions;
}

function Bill({ api, shopId, bill, onSaved }: { api: AdminApi; shopId: string; bill: AdminCounterBill; onSaved: (bill: AdminCounterBill) => void }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const person = bill.madeBy.name ?? strings.counterBillUnknownPerson;
  const actions = actionsFor(bill);

  async function act(action: CounterBillResolutionAction) {
    setError("");
    const parsed = AdminActionReason.safeParse(note);
    if (!parsed.success) { setError(strings.counterBillNoteRequired); return; }
    setBusy(true);
    try {
      const result = await api.resolveCounterBill(shopId, bill.id, { action, note: parsed.data });
      if (result.ok) { setNote(""); onSaved(result.data); }
      else setError(strings.errors[result.code]);
    } catch { setError(strings.failed); }
    finally { setBusy(false); }
  }

  return <li className="rounded-xl border border-border bg-surface p-4">
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="font-semibold tabular-nums">{bill.reference}</h3>
      <span className="text-muted">{bill.number === null ? strings.counterBillNoNumber : strings.counterBillNumbered(bill.number)}</span>
      {bill.heldReason && <span className="rounded-full bg-warning-subtle px-2 py-0.5 text-on-warning-subtle">{strings.counterBillHeld[bill.heldReason]}</span>}
      {bill.totalMismatch && <span className="rounded-full bg-danger-subtle px-2 py-0.5 text-on-danger-subtle">{strings.counterBillFlagged}</span>}
      {bill.flaggedDenylist && <span className="rounded-full bg-danger-subtle px-2 py-0.5 text-on-danger-subtle">{strings.counterBillDenylistFlagged}</span>}
      {bill.clockSuspect && <span className="rounded-full bg-info-subtle px-2 py-0.5 text-on-info-subtle">{strings.counterBillClock}</span>}
    </div>
    <p className="mt-2 text-muted">{strings.counterBillMadeBy(person, bill.madeBy.role ? strings.counterBillRole[bill.madeBy.role] : "—")}</p>
    <p className="text-muted">{strings.counterBillMadeAt(formatDateTime(bill.madeAt), formatDateTime(bill.receivedAt))}</p>
    {bill.total !== null && bill.checkedTotal !== null && bill.payment && <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1">
      <div><dt className="text-muted">{strings.counterBillPhoneTotal}</dt><dd className="font-medium tabular-nums">{formatMoney(bill.total)}</dd></div>
      <div><dt className="text-muted">{strings.counterBillServerTotal}</dt><dd className="font-medium tabular-nums">{formatMoney(bill.checkedTotal)}</dd></div>
      <div><dt className="text-muted">{strings.counterBillPayment[bill.payment]}</dt></div>
    </dl>}
    {(bill.lines.length > 0 || bill.manualLines.length > 0) && <Lines lines={bill.lines} manualLines={bill.manualLines} discount={bill.discount} />}
    {bill.invalidPayload !== null && <details className="mt-2"><summary className="cursor-pointer text-primary">{strings.counterBillPayload}</summary>
      <pre className="mt-1 overflow-x-auto rounded-lg bg-sunken p-3 text-sm">{bill.invalidPayload}</pre></details>}
    {bill.voided && <Voided voided={bill.voided} />}
    {bill.original && <div className="mt-3 rounded-lg bg-sunken p-3">
      <p className="font-medium">{strings.counterBillOriginal}</p>
      {bill.original.voided && <Voided voided={bill.original.voided} />}
      <p className="text-muted">{[bill.original.number === null ? strings.counterBillNoNumber : strings.counterBillNumbered(bill.original.number),
        bill.original.total === null ? "" : formatMoney(bill.original.total), bill.original.payment ? strings.counterBillPayment[bill.original.payment] : "", formatDateTime(bill.original.madeAt)].filter(Boolean).join(" · ")}</p>
      <Lines lines={bill.original.lines} manualLines={bill.original.manualLines} discount={bill.original.discount} />
    </div>}
    {bill.resolutions.length > 0 && <ul className="mt-3 space-y-2 border-t border-border pt-3">{bill.resolutions.map((resolution, index) => <li key={index}>
      <p className="font-medium">{strings.counterBillResolution[resolution.action]}{resolution.action === "numbered" && ` · ${resolution.stockMoved ? strings.counterBillStockMoved : strings.counterBillStockNotMoved}`}</p>
      <p>{resolution.note}</p>
      <p className="text-muted">{strings.counterBillResolutionBy(resolution.actorName, formatDateTime(resolution.createdAt))}</p>
    </li>)}</ul>}
    {actions.length > 0 && <div className="mt-3 border-t border-border pt-3">
      {bill.heldReason && bill.heldReason !== "invalid" && <p className="mb-2 text-muted">{bill.heldReason === "too_large" ? strings.counterBillStock.none : strings.counterBillStock.moves}</p>}
      <label className="block font-medium">{strings.counterBillNote}
        <textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} rows={2} aria-describedby={`note-hint-${bill.id}`}
          className="mt-1 w-full rounded-lg border border-border-strong bg-raised p-2 font-normal" />
      </label>
      <p id={`note-hint-${bill.id}`} className="text-muted">{strings.counterBillNoteHint}</p>
      {error && <p role="alert" className="mt-2 text-danger">{error}</p>}
      <div className="mt-3 flex flex-wrap gap-2">{actions.map((action) =>
        <button key={action} disabled={busy} onClick={() => void act(action)}
          className={`h-10 rounded-lg px-4 font-medium disabled:opacity-60 ${action === "number" || action === "review" ? "bg-primary text-on-primary" : "border border-border-strong"}`}>
          {busy ? strings.counterBillActionBusy : strings.counterBillActions[action]}</button>)}</div>
    </div>}
  </li>;
}

function FlaggedOptionCard({ api, shopId, option, onDismissed }: { api: AdminApi; shopId: string; option: AdminFlaggedQuantityOption; onDismissed: (optionId: string) => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function dismiss() {
    setError("");
    const parsed = AdminActionReason.safeParse(reason);
    if (!parsed.success) { setError(strings.flaggedQuantityOptionReasonRequired); return; }
    setBusy(true);
    try {
      const result = await api.dismissFlaggedQuantityOption(shopId, option.id, { reason: parsed.data });
      if (result.ok) { onDismissed(option.id); }
      else setError(strings.errors[result.code] ?? strings.failed);
    } catch {
      setError(strings.failed);
    } finally {
      setBusy(false);
    }
  }

  return <li className="rounded-xl border border-border bg-surface p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h3 className="font-semibold">{option.productName} · {trimDecimal(option.packQuantity)} {option.baseUnit}</h3>
        <p className="mt-1 font-medium">{option.name}</p>
        <p className="text-muted">{trimDecimal(option.quantity)} {option.baseUnit} · {formatMoney(option.price)}</p>
      </div>
      <span className="rounded-full bg-danger-subtle px-2 py-0.5 text-on-danger-subtle">{strings.flaggedQuantityOptionMatch}</span>
    </div>
    <div className="mt-3 border-t border-border pt-3">
      <label className="block font-medium">{strings.flaggedQuantityOptionReason}
        <textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={2} aria-describedby={`reason-hint-${option.id}`}
          className="mt-1 w-full rounded-lg border border-border-strong bg-raised p-2 font-normal" />
      </label>
      <p id={`reason-hint-${option.id}`} className="text-muted">{strings.flaggedQuantityOptionReasonHint}</p>
      {error && <p role="alert" className="mt-2 text-danger">{error}</p>}
      <div className="mt-3">
        <button disabled={busy} onClick={() => void dismiss()}
          className="h-10 rounded-lg bg-primary px-4 font-medium text-on-primary disabled:opacity-60">
          {busy ? strings.counterBillActionBusy : strings.flaggedQuantityOptionDismiss}
        </button>
      </div>
    </div>
  </li>;
}

/** A shop's held and flagged counter bills, and flagged quantity options (#470, #621, BIL-5, BIL-9, CAT-8). */
export function CounterBills({ api }: { api: AdminApi }) {
  const loaded = useLoaderData() as CounterBillsData;
  const [bills, setBills] = useState(loaded.bills);
  const [flaggedOptions, setFlaggedOptions] = useState(loaded.flaggedOptions ?? []);
  const { application } = loaded;
  const replace = (saved: AdminCounterBill) => setBills((current) => current.map((bill) => bill.id === saved.id ? saved : bill)
    .sort((a, b) => Number(a.resolved) - Number(b.resolved)));
  const removeOption = (optionId: string) => setFlaggedOptions((current) => current.filter((opt) => opt.id !== optionId));
  const open = bills.filter((bill) => !bill.resolved);
  const done = bills.filter((bill) => bill.resolved);

  return <>
    <Link to={`/applications/${application.id}`} className="text-primary underline">{strings.backToShop}</Link>
    <h1 className="mt-3 text-title-large font-semibold">{strings.counterBillsOf(application.shopName ?? strings.applicationReview)}</h1>
    <section aria-labelledby="flagged-options" className="mt-6">
      <h2 id="flagged-options" className="mb-3 font-semibold">{strings.flaggedQuantityOptions}</h2>
      {flaggedOptions.length === 0 ? <p className="text-muted">{strings.flaggedQuantityOptionsNone}</p>
        : <ul className="space-y-3">{flaggedOptions.map((opt) => <FlaggedOptionCard key={opt.id} api={api} shopId={application.id} option={opt} onDismissed={removeOption} />)}</ul>}
    </section>
    <section aria-labelledby="bills-open" className="mt-8">
      <h2 id="bills-open" className="mb-3 font-semibold">{strings.counterBillsOpen}</h2>
      {open.length === 0 ? <p className="text-muted">{strings.counterBillsNoneOpen}</p>
        : <ul className="space-y-3">{open.map((bill) => <Bill key={bill.id} api={api} shopId={application.id} bill={bill} onSaved={replace} />)}</ul>}
    </section>
    {done.length > 0 && <section aria-labelledby="bills-done" className="mt-8">
      <h2 id="bills-done" className="mb-3 font-semibold">{strings.counterBillsDone}</h2>
      <ul className="space-y-3">{done.map((bill) => <Bill key={bill.id} api={api} shopId={application.id} bill={bill} onSaved={replace} />)}</ul>
    </section>}
  </>;
}
