import { AssignShopAreaManagerBody, CorrectShopApplicationBody, type AdminAccount, type AdminShopApplication, type LiveCheck } from "@ygo/contracts";
import { formatDate, formatDateTime, formatNumber, formatPhone } from "@ygo/format";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useLoaderData } from "react-router";
import { createAdminApiClient } from "@ygo/api-client";
import { ReasonDialog } from "./components/reason-dialog";
import { fieldMessages } from "./lib/field-messages";
import { ShopVisitAndFeePanel } from "./shop-visits";
import { strings } from "./strings";

type AdminApi = ReturnType<typeof createAdminApiClient>;
type EditableField = Exclude<keyof CorrectShopApplicationBody, "reason">;
type FieldErrors = Partial<Record<EditableField | "reason", string>>;
const editableFields: EditableField[] = ["shopName", "address", "pincode", "location", "ownerName", "entityType", "pan", "fssaiNumber", "fssaiExpiry", "serviceRadiusMetres", "upiId"];
const fieldLabels: Record<EditableField, string> = {
  shopName: strings.shopName, address: strings.applicationAddress, pincode: strings.pincode, location: strings.location,
  ownerName: strings.owner, entityType: strings.entityType, pan: strings.pan, fssaiNumber: strings.fssaiNumber,
  fssaiExpiry: strings.fssaiExpiry, serviceRadiusMetres: strings.serviceRadius, upiId: strings.upiId,
};

function applicationValue(application: AdminShopApplication, field: EditableField) {
  if (field === "location") {
    const point = application.location;
    return point ? `${point.latitude}, ${point.longitude}` : "—";
  }
  if (field === "entityType") return application.entityType ? strings.entities[application.entityType] : "—";
  if (field === "serviceRadiusMetres") return strings.radiusKilometres(formatNumber(application.serviceRadiusMetres / 1000));
  const value = application[field];
  return value ?? "—";
}

function areaManagerName(application: AdminShopApplication) {
  return application.areaManager ? application.areaManager.name ?? application.areaManager.email : strings.noAreaManager;
}

export function ShopApplications({ api }: { api: AdminApi }) {
  const applications = useLoaderData() as AdminShopApplication[];
  // Every shop an Area Manager sees is theirs, so only Admin gets the Area Manager column (#299).
  const admin = api.currentRole() === "admin";
  return <>
    <div className="mb-8"><h1 className="text-title-large font-semibold">{strings.applications}</h1><p className="mt-2 text-muted">{strings.applicationsIntro}</p></div>
    <section className="rounded-xl border border-border bg-surface">
      {applications.length === 0 ? <p className="p-6 text-muted">{admin ? strings.noApplications : strings.noAssignedShops}</p> : <div className="overflow-x-auto">
        <table className="w-full min-w-xl text-left"><thead className="bg-sunken"><tr>
          {[strings.shopName, strings.owner, strings.pincode, strings.areas, ...(admin ? [strings.roles.area_manager] : []), strings.applicationReview].map((label) => <th key={label} className="p-3 font-medium">{label}</th>)}
        </tr></thead><tbody>{applications.map((application) => <tr key={application.id} className="border-t border-border">
          <td className="p-3"><Link className="text-primary underline" to={`/applications/${application.id}`}>{application.shopName}</Link></td>
          <td className="p-3">{application.ownerName}<br /><span className="text-muted">{application.ownerEmail}</span></td>
          <td className="p-3 tabular-nums">{application.pincode}</td><td className="p-3">{application.areaName ?? "—"}</td>
          {admin && <td className="p-3">{application.areaManager ? areaManagerName(application) : "—"}</td>}
          <td className="p-3">{strings.applicationState[application.state]}</td>
        </tr>)}</tbody></table>
      </div>}
    </section>
  </>;
}

export function ShopApplicationReview({ api }: { api: AdminApi }) {
  const loaded = useLoaderData() as AdminShopApplication;
  const admin = api.currentRole() === "admin";
  const [application, setApplication] = useState(loaded);
  const [editing, setEditing] = useState<EditableField | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [value, setValue] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  function edit(field: EditableField) {
    setEditing(field);
    if (field === "location") {
      const point = application.location;
      setValue(point ? `${point.latitude}, ${point.longitude}` : "");
    } else {
      const current = application[field];
      setValue(current == null ? "" : String(current));
    }
    setErrors({}); setError(""); setNotice("");
  }

  function correction(field: EditableField, raw: string, reason: string) {
    let parsedValue: unknown = raw;
    if (field === "serviceRadiusMetres") parsedValue = Number(raw);
    if (field === "location") {
      const parts = raw.split(",").map((part) => part.trim() ? Number(part.trim()) : NaN);
      parsedValue = { latitude: parts[0], longitude: parts[1] };
    }
    return CorrectShopApplicationBody.safeParse({ [field]: parsedValue, reason });
  }

  function openReason(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const parsed = correction(editing, value, "Correction");
    if (!parsed.success) {
      setErrors(fieldMessages(parsed.error.issues.map((issue) => String(issue.path[0])), strings.applicationInvalidFields));
      return;
    }
    setErrors({});
    setReasonOpen(true);
  }

  async function save(reason: string) {
    if (!editing) return;
    const parsed = correction(editing, value, reason);
    if (!parsed.success) {
      setErrors(fieldMessages(parsed.error.issues.map((issue) => String(issue.path[0])), strings.applicationInvalidFields));
      return;
    }
    setBusy(true); setErrors({}); setError("");
    try {
      const result = await api.correctShopApplication(application.id, parsed.data);
      if (result.ok) { setApplication(result.data); setEditing(null); setReasonOpen(false); setNotice(strings.correctionSaved); }
      else if (result.code === "VALIDATION_FAILED" && result.fields) setErrors(fieldMessages(result.fields, strings.applicationInvalidFields));
      else setError(strings.errors[result.code]);
    } catch { setError(strings.failed); }
    finally { setBusy(false); }
  }

  async function transition(action: "startShopApplicationReview" | "approveShopApplication") {
    setBusy(true); setError("");
    try {
      const result = await api[action](application.id);
      if (result.ok) { setApplication(result.data); setNotice(action === "approveShopApplication" ? strings.applicationApproved : strings.reviewStarted); }
      else setError(strings.errors[result.code]);
    } catch { setError(strings.failed); }
    finally { setBusy(false); }
  }

  // Admin assigns the shop to an Area Manager, or none, then gives a reason (#299).
  const [picking, setPicking] = useState(false);
  const [areaManagers, setAreaManagers] = useState<AdminAccount[] | null>(null);
  const [picked, setPicked] = useState("");

  async function pick() {
    setPicked(application.areaManager?.id ?? ""); setPicking(true); setReasonOpen(false); setErrors({}); setError(""); setNotice("");
    if (areaManagers) return;
    try {
      const result = await api.listAccounts();
      if (result.ok) setAreaManagers(result.data.accounts.filter((account) => account.role === "area_manager"));
      else setError(strings.errors[result.code]);
    } catch { setError(strings.failed); }
  }

  async function assign(reason: string) {
    const parsed = AssignShopAreaManagerBody.safeParse({ areaManagerId: picked || null, reason });
    if (!parsed.success) { setErrors({ reason: strings.applicationInvalidFields.reason }); return; }
    setBusy(true); setErrors({}); setError("");
    try {
      const result = await api.assignShopAreaManager(application.id, parsed.data);
      if (result.ok) { setApplication(result.data); setPicking(false); setReasonOpen(false); setNotice(strings.areaManagerSaved); }
      else setError(strings.errors[result.code]);
    } catch { setError(strings.failed); }
    finally { setBusy(false); }
  }

  // A07 Move to Live (#363): the server names what still blocks it, and checks again on the move.
  const [check, setCheck] = useState<LiveCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const approved = admin && application.state === "approved";

  async function loadCheck() {
    setChecking(true); setError("");
    try {
      const result = await api.shopLiveCheck(application.id);
      if (result.ok) setCheck(result.data);
      else setError(strings.errors[result.code]);
    } catch { setError(strings.failed); }
    finally { setChecking(false); }
  }

  useEffect(() => {
    if (approved) void loadCheck();
  }, [approved, application.id]);

  async function moveToLive() {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api.moveShopToLive(application.id);
      if (result.ok) { setApplication(result.data); setCheck(null); setNotice(strings.movedToLive); }
      else { if (result.liveCheck) setCheck(result.liveCheck); setError(strings.errors[result.code]); }
    } catch { setError(strings.failed); }
    finally { setBusy(false); setConfirming(false); }
  }

  const location = application.location;
  return <>
    <div className="mb-8 flex items-start justify-between gap-4"><div>
      <Link to="/applications" className="text-primary underline">{strings.backToApplications}</Link>
      <h1 className="mt-3 text-title-large font-semibold">{application.shopName}</h1>
      <p className="mt-2 text-muted">{strings.applicationState[application.state]}</p>
    </div>{!admin ? application.state !== "live" && <p className="max-w-sm rounded-lg bg-info-subtle p-3 text-on-info-subtle">{strings.adminDecides}</p> : <div className="flex gap-2">{application.state === "submitted" && <button disabled={busy} onClick={() => void transition("startShopApplicationReview")} className="h-10 rounded-lg bg-primary px-4 font-medium text-on-primary disabled:opacity-60">{strings.startReview}</button>}
      {application.state === "under_review" && <button disabled={busy} onClick={() => void transition("approveShopApplication")} className="h-10 rounded-lg bg-primary px-4 font-medium text-on-primary disabled:opacity-60">{strings.approveApplication}</button>}
      {approved && <button disabled={busy || check?.blockers.length !== 0} onClick={() => setConfirming(true)} className="h-10 rounded-lg bg-primary px-4 font-medium text-on-primary disabled:opacity-60">{strings.moveToLive}</button>}</div>}</div>
    {notice && <p role="status" className="mb-4 rounded-lg bg-success-subtle p-3 text-on-success-subtle">{notice}</p>}
    {error && <p role="alert" className="mb-4 rounded-lg bg-danger-subtle p-3 text-on-danger-subtle">{error}</p>}
    <section className="rounded-xl border border-border bg-surface"><dl>
      {editableFields.map((field) => <div key={field} className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-4 first:border-t-0">
        <dt className="font-medium">{fieldLabels[field]}</dt><dd className="min-w-48 flex-1">{field === "location" && location ? <>{applicationValue(application, field)} · <a className="text-primary underline" target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${location.latitude},${location.longitude}`}>{strings.openGoogleMaps}</a></> : field === "fssaiExpiry" && application.fssaiExpiry ? formatDate(`${application.fssaiExpiry}T00:00:00Z`) : applicationValue(application, field)}</dd>
        <button disabled={busy} onClick={() => edit(field)} className="h-10 rounded-lg border border-border-strong px-3 disabled:opacity-60">{strings.editField(fieldLabels[field])}</button>
      </div>)}
      {admin && <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-4">
        <dt className="font-medium">{strings.roles.area_manager}</dt><dd className="min-w-48 flex-1">{areaManagerName(application)}</dd>
        <button disabled={busy} onClick={() => void pick()} className="h-10 rounded-lg border border-border-strong px-3 disabled:opacity-60">{application.areaManager ? strings.changeAreaManager : strings.assignAreaManager}</button>
      </div>}
      <div className="border-t border-border p-4"><dt className="font-medium">{strings.phone}</dt><dd className="mt-1 tabular-nums">{application.ownerPhone ? formatPhone(application.ownerPhone) : "—"}</dd></div>
      <div className="border-t border-border p-4"><dt className="font-medium">{strings.ownerEmail}</dt><dd className="mt-1">{application.ownerEmail}</dd></div>
      <div className="border-t border-border p-4"><dt className="font-medium">{strings.submittedAt}</dt><dd className="mt-1">{application.submittedAt ? formatDateTime(application.submittedAt) : "—"}</dd></div>
    </dl></section>
    {approved && <section aria-labelledby="live-check-title" className="mt-6 rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="live-check-title" className="font-semibold">{strings.liveCheckTitle}</h2>
        <button disabled={checking} onClick={() => void loadCheck()} className="h-10 rounded-lg border border-border-strong px-3 disabled:opacity-60">{strings.liveCheckAgain}</button></div>
      {!check ? checking && <p className="mt-3 text-muted">{strings.liveCheckLoading}</p>
        : check.blockers.length === 0 ? <p className="mt-3 text-success">{strings.liveCheckReady}</p>
        : <ul className="mt-3 list-disc space-y-2 pl-5">{check.blockers.map((blocker) => <li key={blocker}>{strings.liveBlockers[blocker]}
          {blocker === "rate_card" && <> {check.rateCardMissing.map((key) => strings.rateCardFields[key]).join(", ")}. <Link className="text-primary underline" to="/rate-cards">{strings.rateCards}</Link></>}</li>)}</ul>}
    </section>}
    {admin && application.state !== "draft" && <ShopVisitAndFeePanel api={api} application={application} />}
    {editing && !reasonOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim px-4" onKeyDown={(event) => { if (event.key === "Escape") setEditing(null); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="application-edit-title" className="max-h-[calc(100dvh-2rem)] w-full max-w-[520px] overflow-y-auto rounded-2xl border border-border bg-raised p-6 shadow-xl">
      <h2 id="application-edit-title" className="text-body font-semibold">{strings.editField(fieldLabels[editing])}</h2>
      <form className="mt-4 space-y-3" noValidate onSubmit={openReason}>
        <label htmlFor="application-value" className="block font-medium">{fieldLabels[editing]}</label>
        {editing === "entityType" ? <select id="application-value" autoFocus value={value} onChange={(event) => setValue(event.target.value)} className="h-10 w-full rounded-lg border border-border-strong bg-surface px-3">
          {Object.entries(strings.entities).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select> : editing === "location" ? <div className="grid grid-cols-2 gap-3">{[strings.latitude, strings.longitude].map((label, index) => <label key={label} className="block text-muted">{label}<input aria-label={label} autoFocus={index === 0} type="number" step="any" value={value.split(",")[index]?.trim() ?? ""} onChange={(event) => { const parts = value.split(","); parts[index] = event.target.value; setValue(parts.join(",")); }} className="mt-1 h-10 w-full rounded-lg border border-border-strong bg-surface px-3" /></label>)}</div>
          : <input id="application-value" autoFocus type={editing === "fssaiExpiry" ? "date" : editing === "serviceRadiusMetres" ? "number" : "text"} step={editing === "serviceRadiusMetres" ? "0.5" : undefined} value={editing === "serviceRadiusMetres" ? String(Number(value) / 1000) : value} onChange={(event) => setValue(editing === "serviceRadiusMetres" ? String(Number(event.target.value) * 1000) : event.target.value)} className="h-10 w-full rounded-lg border border-border-strong bg-surface px-3" />}
        {errors[editing] && <p role="alert" className="text-danger">{errors[editing]}</p>}
        <div className="flex gap-3"><button className="h-10 rounded-lg bg-primary px-4 font-medium text-on-primary">{strings.saveCorrection}</button><button type="button" onClick={() => setEditing(null)} className="h-10 rounded-lg border border-border-strong px-4">{strings.cancel}</button></div>
      </form>
      </section>
    </div>}
    {picking && !reasonOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim px-4" onKeyDown={(event) => { if (event.key === "Escape") setPicking(false); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="area-manager-title" className="w-full max-w-[520px] rounded-2xl border border-border bg-raised p-6 shadow-xl">
        <h2 id="area-manager-title" className="text-body font-semibold">{strings.areaManagerDialog}</h2>
        <form className="mt-6 space-y-4" noValidate onSubmit={(event) => { event.preventDefault(); if (picked === (application.areaManager?.id ?? "")) setPicking(false); else setReasonOpen(true); }}>
          {areaManagers ? <label className="block font-medium">{strings.roles.area_manager}
            <select autoFocus value={picked} onChange={(event) => setPicked(event.target.value)} className="mt-2 h-10 w-full rounded-lg border border-border-strong bg-surface px-3 font-normal">
              <option value="">{strings.noAreaManager}</option>
              {areaManagers.map((account) => <option key={account.id} value={account.id}>{account.name ? `${account.name} · ${account.email}` : account.email}</option>)}
            </select></label> : !error && <p className="text-muted">{strings.areaManagersLoading}</p>}
          {error && <p role="alert" className="text-danger">{error}</p>}
          <div className="flex gap-3"><button disabled={!areaManagers} className="h-10 rounded-lg bg-primary px-4 font-medium text-on-primary disabled:opacity-60">{strings.next}</button><button type="button" onClick={() => setPicking(false)} className="h-10 rounded-lg border border-border-strong px-4">{strings.cancel}</button></div>
        </form>
      </section>
    </div>}
    {confirming && <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim px-4" onKeyDown={(event) => { if (event.key === "Escape") setConfirming(false); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="move-to-live-title" className="w-full max-w-[520px] rounded-2xl border border-border bg-raised p-6 shadow-xl">
        <h2 id="move-to-live-title" className="text-body font-semibold">{strings.moveToLive}</h2>
        <p className="mt-2 text-muted">{strings.moveToLiveConfirm}</p>
        <div className="mt-6 flex gap-3"><button autoFocus disabled={busy} onClick={() => void moveToLive()} className="h-10 rounded-lg bg-primary px-4 font-medium text-on-primary disabled:opacity-60">{busy ? strings.saving : strings.moveToLive}</button>
          <button type="button" onClick={() => setConfirming(false)} className="h-10 rounded-lg border border-border-strong px-4">{strings.cancel}</button></div>
      </section>
    </div>}
    {picking && reasonOpen && <ReasonDialog title={strings.areaManagerDialog} note={areaManagers?.find((account) => account.id === picked)?.email ?? strings.noAreaManager} confirmLabel={strings.saveAreaManager} busy={busy} reasonError={errors.reason} error={error} onConfirm={(reason) => void assign(reason)} onCancel={() => { setReasonOpen(false); setErrors({}); setError(""); }} />}
    {editing && reasonOpen && <ReasonDialog title={strings.editField(fieldLabels[editing])} confirmLabel={strings.saveCorrection} busy={busy} reasonError={errors.reason} error={error} onConfirm={(reason) => void save(reason)} onCancel={() => { setReasonOpen(false); setErrors({}); setError(""); }} />}
  </>;
}
