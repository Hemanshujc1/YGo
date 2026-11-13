import type { createAdminApiClient } from "@ygo/api-client";
import type { CustomerTrust } from "@ygo/contracts";
import { useEffect, useState, type FormEvent } from "react";
import { strings } from "./strings";
import { useLoaderData } from "react-router";

type AdminApi = ReturnType<typeof createAdminApiClient>;

export function Customers({ api }: { api: AdminApi }) {
  const initial = useLoaderData() as { customers: CustomerTrust[] };
  const [search, setSearch] = useState("");
  const [flagged, setFlagged] = useState(true);
  const [rows, setRows] = useState(initial.customers);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [signupsEnabled, setSignupsEnabled] = useState(true);
  useEffect(() => { void api.customerSignupSettings().then((result) => { if (result.ok) setSignupsEnabled(result.data.enabled); else setMessage(strings.customerActionFailed); }).catch(() => setMessage(strings.customerActionFailed)); }, [api]);

  async function find(event: FormEvent) {
    event.preventDefault();
    if (search.trim().length < 2) { setMessage(strings.customerSearchShort); return; }
    setFlagged(false); setMessage(null);
    const result = await api.listCustomers(search.trim());
    if (result.ok) setRows(result.data.customers);
  }

  async function toggle(id: string, blocked: boolean) {
    if (!reason.trim()) { setMessage(strings.customerReasonRequired); return; }
    setBusy(id); setMessage(null);
    const result = blocked ? await api.unblockCustomer(id, { reason }) : await api.blockCustomer(id, { reason });
    if (result.ok) {
      setRows((current) => current.flatMap((row) => row.id === id ? (blocked ? [{ ...row, blocked: false, blockReason: null }] : result.data ? [result.data] : []) : [row]));
      setReason("");
    } else setMessage(strings.customerActionFailed);
    setBusy(null);
  }

  return <section>
    <h1 className="text-title-large font-semibold">{strings.customers}</h1>
    <p className="mt-2 text-muted">{strings.customerIntro}</p>
    <label className="mt-4 flex items-center gap-3"><input type="checkbox" checked={flagged} onChange={async (event) => {
      const checked = event.target.checked; setFlagged(checked); setMessage(null);
      try { const result = await api.listCustomers(undefined, checked); if (result.ok) setRows(result.data.customers); else setMessage(strings.customerActionFailed); }
      catch { setMessage(strings.customerActionFailed); }
    }} />{strings.customerFlagged}</label>
    <form onSubmit={(event) => void find(event)} className="mt-6 flex gap-3">
      <label className="sr-only" htmlFor="customer-search">{strings.customerSearch}</label>
      <input id="customer-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={strings.customerSearch} className="h-11 flex-1 rounded-lg border border-border bg-surface px-3" />
      <button className="h-11 rounded-lg bg-primary px-4 font-medium text-on-primary">{strings.search}</button>
    </form>
    <label className="mt-4 block text-sm text-muted" htmlFor="customer-reason">{strings.reason}</label>
    <textarea id="customer-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder={strings.customerReasonHint} className="mt-1 min-h-20 w-full rounded-lg border border-border bg-surface p-3" />
    <label className="mt-4 flex items-center gap-3"><input type="checkbox" checked={signupsEnabled} onChange={async (event) => { if (!reason.trim()) { setMessage(strings.customerReasonRequired); return; } try { const result = await api.setCustomerSignupSettings({ enabled: event.target.checked, reason }); if (result.ok) { setSignupsEnabled(result.data.enabled); setReason(""); setMessage(null); } else setMessage(strings.customerActionFailed); } catch { setMessage(strings.customerActionFailed); } }} /> {strings.customerSignups}</label>
    {message && <p role="alert" className="mt-3 rounded-lg bg-danger-subtle p-3 text-on-danger-subtle">{message}</p>}
    <div className="mt-6 overflow-x-auto rounded-xl border border-border bg-surface"><table className="w-full text-left"><thead><tr className="border-b border-border text-muted"><th className="p-3">{strings.name}</th><th className="p-3">{strings.email}</th><th className="p-3">{strings.phone}</th><th className="p-3">{strings.customerFlags}</th><th className="p-3">{strings.customerAction}</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id} className="border-b border-border last:border-0"><td className="p-3">{row.name ?? strings.noPhone}</td><td className="p-3">{row.email}</td><td className="p-3">{row.phone ?? strings.noPhone}<span className="block text-sm text-muted">{row.phoneState}</span></td><td className="p-3">{row.failedDeliveries} / {row.refusals}{row.flagged && <span className="ml-2 font-medium">{strings.customerFlagged}</span>}{row.blocked && <span className="ml-2 font-medium">{strings.customerBlocked}</span>}</td><td className="p-3"><button disabled={busy === row.id} onClick={() => void toggle(row.id, row.blocked)} className="rounded-lg border border-border-strong px-3 py-2 text-primary">{row.blocked ? strings.customerUnblock : strings.customerBlock}</button></td></tr>)}</tbody></table></div>
  </section>;
}
