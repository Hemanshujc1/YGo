import { createAdminApiClient } from "@ygo/api-client";
import { CreateAreaBody, EditAreaBody, type Area, type ErrorCode, type ErrorEnvelope } from "@ygo/contracts";
import { useState, type FormEvent } from "react";
import { useLoaderData } from "react-router";
import { ReasonDialog } from "./components/reason-dialog";
import { strings } from "./strings";

type AdminApi = ReturnType<typeof createAdminApiClient>;
type AreaField = "name" | "pincodes" | "reason";
type FieldErrors = Partial<Record<AreaField, string>>;
type Conflicts = NonNullable<ErrorEnvelope["error"]["conflicts"]>;

const byName = (a: Area, b: Area) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

export function Areas({ api }: { api: AdminApi }) {
  const loaded = useLoaderData() as Area[];
  const [areas, setAreas] = useState(loaded);
  const [editing, setEditing] = useState<Area | null>(null);
  const [screen, setScreen] = useState<"list" | "form" | "pause">("list");
  const [name, setName] = useState("");
  const [pincodes, setPincodes] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [conflicts, setConflicts] = useState<Conflicts>([]);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  function open(next: "form" | "pause", area: Area | null) {
    setEditing(area);
    setName("");
    setPincodes(area?.pincodes.join(", ") ?? "");
    setReason("");
    setErrors({});
    setConflicts([]);
    setError("");
    setSaved(false);
    setScreen(next);
  }

  function finish(area: Area) {
    setAreas((current) => [...current.filter((item) => item.id !== area.id), area].sort(byName));
    setSaved(true);
    setScreen("list");
  }

  function failed(code: ErrorCode, fields?: string[], clashes?: Conflicts) {
    if (code === "AREA_NAME_IN_USE") setErrors({ name: strings.errors.AREA_NAME_IN_USE });
    else if (code === "PINCODE_IN_OTHER_AREA") {
      setErrors({ pincodes: strings.errors.PINCODE_IN_OTHER_AREA });
      setConflicts(clashes ?? []);
    } else if (code === "VALIDATION_FAILED" && fields?.length) {
      setErrors(Object.fromEntries(fields.map((field) => [field, strings.areaInvalidFields[field as AreaField]])));
    } else setError(strings.errors[code]);
  }

  async function send(request: () => ReturnType<AdminApi["editArea"]>) {
    setBusy(true);
    setErrors({});
    setConflicts([]);
    setError("");
    try {
      const result = await request();
      if (result.ok) finish(result.data);
      else failed(result.code, result.fields, result.conflicts);
    } catch {
      setError(strings.failed);
    } finally {
      setBusy(false);
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Commas or new lines separate pincodes; spaces inside one are dropped by the Pincode rule.
    const list = pincodes.split(/[,\n]/).filter((entry) => entry.trim() !== "");
    const parsed = editing
      ? EditAreaBody.safeParse({ pincodes: list, reason })
      : CreateAreaBody.safeParse({ name, pincodes: list, reason });
    if (!parsed.success) {
      setConflicts([]);
      setErrors(Object.fromEntries(parsed.error.issues.map((issue) => {
        const field = issue.path[0] as AreaField;
        return [field, strings.areaInvalidFields[field]];
      })));
      return;
    }
    void send(() => editing
      ? api.editArea(editing.id, parsed.data)
      : api.createArea(parsed.data as CreateAreaBody));
  }

  function changePaused(text: string) {
    if (!editing) return;
    const parsed = EditAreaBody.safeParse({ paused: !editing.paused, reason: text });
    if (!parsed.success) return setErrors({ reason: strings.areaInvalidFields.reason });
    void send(() => api.editArea(editing.id, parsed.data));
  }

  return <>
    <div className="mb-8 flex items-center justify-between gap-4">
      <div><h1 className="text-title-large font-semibold">{strings.areas}</h1><p className="mt-2 text-muted">{strings.areaIntro}</p></div>
      {screen !== "form" && <button onClick={() => open("form", null)} className="h-10 shrink-0 rounded-lg bg-primary px-4 font-medium text-on-primary">{strings.newArea}</button>}
    </div>
    {saved && <p role="status" className="mb-4 rounded-lg bg-success-subtle p-3 text-on-success-subtle">{strings.areaSaved}</p>}
    {screen !== "form" && <section className="rounded-xl border border-border bg-surface">
      {areas.length === 0 ? <p className="p-6 text-muted">{strings.noAreas}</p> : <ul>{areas.map((area) =>
        <li key={area.id} className="border-t border-border p-4 first:border-t-0">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><span className="font-medium">{area.name}</span>
              {area.paused && <span className="ml-3 rounded bg-warning-subtle px-2 py-0.5 text-secondary text-on-warning-subtle">{strings.areaPaused}</span>}</div>
            <div className="flex gap-2">
              <button type="button" disabled={busy} onClick={() => open("form", area)} className="h-10 rounded-lg border border-border-strong px-3 disabled:opacity-60">
                {strings.editPincodes(area.name)}
              </button>
              <button type="button" disabled={busy} onClick={() => open("pause", area)} className="h-10 rounded-lg border border-border-strong px-3 disabled:opacity-60">
                {area.paused ? strings.resumeArea(area.name) : strings.pauseArea(area.name)}
              </button>
            </div>
          </div>
          <ul aria-label={strings.areaPincodes} className="mt-3 flex flex-wrap gap-2">
            {area.pincodes.map((pincode) => <li key={pincode} className="rounded bg-sunken px-2 py-0.5 tabular-nums">{pincode}</li>)}
          </ul>
        </li>)}</ul>}
    </section>}
    {screen === "form" && <section className="max-w-xl rounded-xl border border-border bg-surface p-6">
      <h2 className="text-body font-semibold">{editing ? strings.editPincodes(editing.name) : strings.newArea}</h2>
      <form onSubmit={save} className="mt-6 space-y-4" noValidate>
        {!editing && <div><label htmlFor="area-name" className="mb-2 block font-medium">{strings.areaName}</label>
          <input id="area-name" value={name} onChange={(event) => setName(event.target.value)} className="h-10 w-full rounded-lg border border-border-strong bg-surface px-3" />
          {errors.name && <p role="alert" className="mt-1 text-secondary text-danger">{errors.name}</p>}</div>}
        <div><label htmlFor="area-pincodes" className="mb-2 block font-medium">{strings.areaPincodes}</label>
          <textarea id="area-pincodes" aria-describedby="area-pincodes-hint" value={pincodes} onChange={(event) => setPincodes(event.target.value)} className="min-h-24 w-full rounded-lg border border-border-strong bg-surface p-3 tabular-nums" />
          <p id="area-pincodes-hint" className="mt-1 text-secondary text-muted">{strings.areaPincodesHint}</p>
          {errors.pincodes && <div role="alert" className="mt-1 text-secondary text-danger">
            <p>{errors.pincodes}</p>
            {conflicts.length > 0 && <ul>{conflicts.map((clash) => <li key={clash.pincode}>{strings.pincodeInArea(clash.pincode, clash.areaName)}</li>)}</ul>}
          </div>}</div>
        <div><label htmlFor="area-reason" className="mb-2 block font-medium">{strings.reason}</label>
          <textarea id="area-reason" value={reason} onChange={(event) => setReason(event.target.value)} className="min-h-24 w-full rounded-lg border border-border-strong bg-surface p-3" />
          {errors.reason && <p role="alert" className="mt-1 text-secondary text-danger">{errors.reason}</p>}</div>
        {error && <p role="alert" className="text-danger">{error}</p>}
        <div className="flex gap-3"><button disabled={busy} className="h-10 rounded-lg bg-primary px-4 font-medium text-on-primary disabled:opacity-60">{busy ? strings.saving : strings.saveArea}</button>
          <button type="button" disabled={busy} onClick={() => setScreen("list")} className="h-10 rounded-lg border border-border-strong px-4">{strings.cancel}</button></div>
      </form>
    </section>}
    {screen === "pause" && editing && <ReasonDialog title={editing.paused ? strings.resumeAreaTitle(editing.name) : strings.pauseAreaTitle(editing.name)}
      confirmLabel={editing.paused ? strings.confirmResume : strings.confirmPause} danger={!editing.paused}
      busy={busy} reasonError={errors.reason} error={error} onConfirm={changePaused} onCancel={() => setScreen("list")}>
      {!editing.paused && strings.pauseAreaNote}
    </ReasonDialog>}
  </>;
}
