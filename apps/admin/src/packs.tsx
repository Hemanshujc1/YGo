import { createAdminApiClient } from "@ygo/api-client";
import { AdminActionReason, CreatePackBody, EditPackBody, type MasterProduct, type Pack } from "@ygo/contracts";
import { trimDecimal } from "@ygo/format";
import { useEffect, useState, type FormEvent } from "react";
import { ReasonDialog } from "./components/reason-dialog";
import { fieldMessages } from "./lib/field-messages";
import { strings } from "./strings";

type AdminApi = ReturnType<typeof createAdminApiClient>;
type Errors = Partial<Record<"quantity" | "barcode" | "reason" | "baseUnit", string>>;

export function Packs({ api, product, onBack }: { api: AdminApi; product: MasterProduct; onBack: () => void }) {
  const [packs, setPacks] = useState<Pack[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Pack | null>(null);
  const [deactivating, setDeactivating] = useState<Pack | null>(null);
  const [form, setForm] = useState(false);
  const [quantity, setQuantity] = useState("");
  const [barcode, setBarcode] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const result = await api.listPacks(product.id);
      if (result.ok) setPacks(result.data.packs);
      else setError(strings.errors[result.code]);
    } catch {
      setError(strings.failed);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [product.id]);

  function openForm(pack: Pack | null) {
    setEditing(pack);
    setQuantity(trimDecimal(pack?.quantity ?? ""));
    setBarcode(pack?.barcode ?? "");
    setErrors({});
    setError("");
    setSaved("");
    setForm(true);
  }

  function finish(pack: Pack, message: string) {
    setPacks((current) => [...current.filter((item) => item.id !== pack.id), pack]
      .sort((a, b) => Number(a.quantity) - Number(b.quantity)));
    setSaved(message);
    setError("");
    setErrors({});
    setForm(false);
    setDeactivating(null);
  }

  function fail(code: string, fields?: string[]) {
    if (code === "BARCODE_IN_USE") setErrors({ barcode: strings.errors.BARCODE_IN_USE });
    else if (code === "PACK_QUANTITY_IN_USE") setErrors({ quantity: strings.errors.PACK_QUANTITY_IN_USE });
    else if (code === "VALIDATION_FAILED" && fields?.length) setErrors(fieldMessages(fields, strings.packInvalidFields));
    else setError(strings.errors[code as keyof typeof strings.errors] ?? strings.failed);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const draft = { baseUnit: product.baseUnit, quantity, barcode: barcode.trim() || null };
    const parsed = editing ? EditPackBody.safeParse(draft) : CreatePackBody.safeParse(draft);
    if (!parsed.success) {
      setErrors(fieldMessages(parsed.error.issues.map((issue) => String(issue.path[0])), strings.packInvalidFields));
      return;
    }
    setBusy(true);
    setErrors({});
    setError("");
    try {
      const result = editing
        ? await api.editPack(product.id, editing.id, parsed.data as EditPackBody)
        : await api.createPack(product.id, parsed.data as CreatePackBody);
      if (result.ok) finish(result.data, strings.packSaved);
      else fail(result.code, result.fields);
    } catch {
      setError(strings.failed);
    } finally {
      setBusy(false);
    }
  }

  async function changeActive(pack: Pack, active: boolean, reason?: string) {
    const parsed = EditPackBody.safeParse({ active, ...(reason && { reason }) });
    if (!parsed.success) return setErrors({ reason: strings.packInvalidFields.reason });
    setBusy(true);
    setError("");
    setErrors({});
    try {
      const result = await api.editPack(product.id, pack.id, parsed.data);
      if (result.ok) finish(result.data, active ? strings.packReactivated : strings.packDeactivated);
      else fail(result.code, result.fields);
    } catch {
      setError(strings.failed);
    } finally {
      setBusy(false);
    }
  }

  function deactivate(reason: string) {
    const parsed = AdminActionReason.safeParse(reason);
    if (!parsed.success) return setErrors({ reason: strings.packInvalidFields.reason });
    if (deactivating) void changeActive(deactivating, false, parsed.data);
  }

  return <>
    <button type="button" onClick={onBack} className="mb-5 text-primary underline">{strings.backToProducts}</button>
    <div className="mb-8 flex items-end justify-between gap-4">
      <div><h1 className="text-title-large font-semibold">{strings.packsFor(product.name)}</h1>
        <p className="mt-2 text-muted">{strings.packIntro(product.baseUnit)}</p></div>
      {!form && !loading && !error && <button onClick={() => openForm(null)} className="h-10 rounded-lg bg-primary px-4 font-medium text-on-primary">{strings.newPack}</button>}
    </div>
    {saved && <p role="status" className="mb-4 rounded-lg bg-success-subtle p-3 text-on-success-subtle">{saved}</p>}
    {loading ? <p>{strings.packsLoading}</p> : error && !form && !deactivating ? <div><p role="alert" className="text-danger">{error}</p>
      <button onClick={() => void load()} className="mt-3 text-primary underline">{strings.retry}</button></div> : form ?
      <section className="max-w-xl rounded-xl border border-border bg-surface p-6">
        <h2 className="text-body font-semibold">{editing ? strings.editPackTitle : strings.newPack}</h2>
        <form onSubmit={(event) => void save(event)} className="mt-6 space-y-4" noValidate>
          <div><label htmlFor="pack-quantity" className="mb-2 block font-medium">{strings.packQuantity(product.baseUnit)}</label>
            <input id="pack-quantity" inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)} onBlur={() => setQuantity(trimDecimal(quantity))} className="h-10 w-full rounded-lg border border-border-strong bg-surface px-3" />
            {errors.quantity && <p role="alert" className="mt-1 text-secondary text-danger">{errors.quantity}</p>}</div>
          <div><label htmlFor="pack-barcode" className="mb-2 block font-medium">{strings.packBarcode}</label>
            <input id="pack-barcode" inputMode="numeric" value={barcode} onChange={(event) => setBarcode(event.target.value)} className="h-10 w-full rounded-lg border border-border-strong bg-surface px-3" />
            {errors.barcode && <p role="alert" className="mt-1 text-secondary text-danger">{errors.barcode}</p>}</div>
          {errors.baseUnit && <p role="alert" className="text-danger">{errors.baseUnit}</p>}
          {error && <p role="alert" className="text-danger">{error}</p>}
          <div className="flex gap-3"><button disabled={busy} className="h-10 rounded-lg bg-primary px-4 font-medium text-on-primary disabled:opacity-60">{busy ? strings.saving : strings.savePack}</button>
            <button type="button" disabled={busy} onClick={() => { setForm(false); setError(""); }} className="h-10 rounded-lg border border-border-strong px-4">{strings.cancel}</button></div>
        </form>
      </section> : <section className="rounded-xl border border-border bg-surface p-6">
        {packs.length === 0 ? <p className="text-muted">{strings.noPacks}</p> : <ul>{packs.map((pack) => <li key={pack.id} className="flex flex-wrap items-center justify-between gap-4 border-t border-border py-4">
          <div><p className="font-medium">{trimDecimal(pack.quantity)} {product.baseUnit}</p>
            <p className="text-secondary text-muted">{pack.barcode ?? strings.noBarcode} · {pack.active ? strings.packActive : strings.packInactive}</p></div>
          <div className="flex gap-2"><button disabled={busy} onClick={() => openForm(pack)} className="h-10 rounded-lg border border-border-strong px-3 disabled:opacity-60">{strings.editPack(trimDecimal(pack.quantity))}</button>
            <button disabled={busy} onClick={() => pack.active ? (setDeactivating(pack), setErrors({}), setError("")) : void changeActive(pack, true)} className="h-10 rounded-lg border border-border-strong px-3 disabled:opacity-60">
              {pack.active ? strings.deactivatePack(trimDecimal(pack.quantity)) : strings.reactivatePack(trimDecimal(pack.quantity))}</button></div>
        </li>)}</ul>}
      </section>}
    {deactivating && <ReasonDialog title={strings.deactivatePackTitle(trimDecimal(deactivating.quantity))} confirmLabel={strings.confirmDeactivatePack} danger busy={busy}
      reasonError={errors.reason} error={error} onConfirm={deactivate} onCancel={() => { setDeactivating(null); setErrors({}); setError(""); }} />}
  </>;
}
