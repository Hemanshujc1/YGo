import { useState, type FormEvent, type ReactNode } from "react";
import { strings } from "../strings";

/**
 * The window that asks for the reason an Admin change records (ADM-10).
 * The screen checks the reason and passes back any message to show.
 */
export function ReasonDialog({ title, children, confirmLabel, danger = false, busy, reasonError, error, onConfirm, onCancel }: {
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy: boolean;
  reasonError?: string;
  error?: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onConfirm(reason);
  }

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim px-4">
    <section role="dialog" aria-modal="true" aria-labelledby="reason-dialog-title" className="w-full max-w-[520px] rounded-2xl border border-border bg-raised p-6 shadow-xl">
      <h2 id="reason-dialog-title" className="text-body font-semibold">{title}</h2>
      {children && <p className="mt-3 text-muted">{children}</p>}
      <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
        <div><label htmlFor="reason-dialog-reason" className="mb-2 block font-medium">{strings.reason}</label>
          <textarea id="reason-dialog-reason" autoFocus value={reason} onChange={(event) => setReason(event.target.value)} className="min-h-24 w-full rounded-lg border border-border-strong bg-surface p-3" />
          {reasonError && <p role="alert" className="mt-1 text-secondary text-danger">{reasonError}</p>}</div>
        {error && <p role="alert" className="text-danger">{error}</p>}
        <div className="flex gap-3"><button disabled={busy} className={`h-10 rounded-lg px-4 font-medium disabled:opacity-60 ${danger ? "bg-danger text-on-danger" : "bg-primary text-on-primary"}`}>{busy ? strings.saving : confirmLabel}</button>
          <button type="button" disabled={busy} onClick={onCancel} className="h-10 rounded-lg border border-border-strong px-4">{strings.cancel}</button></div>
      </form>
    </section>
  </div>;
}
