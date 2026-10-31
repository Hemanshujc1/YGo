import {
  CreateVisitPhotoUploadBody, RecordOnboardingFeeBody, RecordShopVisitBody, ShopVisitChecks,
  ShopVisitDate, ShopVisitNotes, indiaToday, type ShopApplication, type ShopOnboarding,
  type ShopVisitChecks as ShopVisitChecksContract,
} from "@ygo/contracts";
import { formatDate, formatDateTime, formatMoney, trimDecimal } from "@ygo/format";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { createAdminApiClient } from "@ygo/api-client";
import { strings } from "./strings";

type AdminApi = ReturnType<typeof createAdminApiClient>;
type VisitField = "photo" | "visitDate" | "checks" | "notes";
type FeeField = "status" | "amount" | "paymentDate" | "reference" | "reason";
type VisitChecks = Record<keyof ShopVisitChecksContract, boolean>;

const emptyChecks = (): VisitChecks => ({ pan: false, fssai: false, ownerPhone: false, ownerEmail: false, alarmPermission: false, testerOptIn: false });
async function hasJpegSignature(file: File): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (!(reader.result instanceof ArrayBuffer)) return resolve(false);
      const signature = new Uint8Array(reader.result);
      resolve(signature.length === 3 && signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file.slice(0, 3));
  });
}

export function ShopVisitAndFeePanel({ api, application }: { api: AdminApi; application: ShopApplication }) {
  const [onboarding, setOnboarding] = useState<ShopOnboarding | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [visitDate, setVisitDate] = useState(indiaToday);
  const [photo, setPhoto] = useState<File | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const [checks, setChecks] = useState<VisitChecks>(emptyChecks);
  const [notes, setNotes] = useState("");
  const [visitErrors, setVisitErrors] = useState<Partial<Record<VisitField, string>>>({});
  const [visitError, setVisitError] = useState("");
  const [visitBusy, setVisitBusy] = useState(false);
  const [visitNotice, setVisitNotice] = useState("");
  const [feeStatus, setFeeStatus] = useState<"waived" | "paid">("waived");
  const [feeAmount, setFeeAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(indiaToday);
  const [reference, setReference] = useState("");
  const [feeReason, setFeeReason] = useState("");
  const [feeErrors, setFeeErrors] = useState<Partial<Record<FeeField, string>>>({});
  const [feeError, setFeeError] = useState("");
  const [feeBusy, setFeeBusy] = useState(false);
  const [feeNotice, setFeeNotice] = useState("");
  const [photoUrl, setPhotoUrl] = useState("");
  const [photoBusy, setPhotoBusy] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true); setOnboarding(null); setLoadError("");
    void Promise.resolve().then(() => api.getShopOnboarding(application.id)).then((result) => {
      if (!active) return;
      if (result.ok) setOnboarding(result.data);
      else setLoadError(strings.errors[result.code]);
    }).catch(() => {
      if (active) setLoadError(strings.failed);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, application.id, application.ownerEmail, application.ownerPhone]);

  async function recordVisit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!onboarding) return;
    setVisitErrors({}); setVisitError(""); setVisitNotice("");
    const errors: Partial<Record<VisitField, string>> = {};
    const uploadBody = photo && CreateVisitPhotoUploadBody.safeParse({ contentType: photo.type, byteLength: photo.size });
    if (!photo || !uploadBody?.success) errors.photo = strings.visitInvalidFields.photo;
    if (!ShopVisitDate.safeParse(visitDate).success) errors.visitDate = strings.visitInvalidFields.visitDate;
    if (!ShopVisitChecks.safeParse(checks).success) errors.checks = strings.visitInvalidFields.checks;
    if (!ShopVisitNotes.safeParse(notes).success) errors.notes = strings.visitInvalidFields.notes;
    if (Object.keys(errors).length) { setVisitErrors(errors); return; }
    if (!photo || !uploadBody?.success) return;
    const selectedPhoto = photo;
    const validUploadBody = uploadBody.data;

    setVisitBusy(true);
    try {
      if (!await hasJpegSignature(selectedPhoto)) {
        setVisitErrors({ photo: strings.visitInvalidFields.photo });
        return;
      }
      const upload = await api.createVisitPhotoUpload(application.id, validUploadBody);
      if (!upload.ok) { setVisitError(strings.errors[upload.code]); return; }
      const uploaded = await fetch(upload.data.uploadUrl, {
        method: "PUT", headers: { "content-type": selectedPhoto.type }, body: selectedPhoto,
      });
      if (!uploaded.ok) { setVisitError(strings.visitPhotoUploadFailed); return; }
      const body = RecordShopVisitBody.safeParse({
        photoUploadId: upload.data.id, visitDate, checks, ...(notes ? { notes } : {}),
      });
      if (!body.success) { setVisitError(strings.errors.VALIDATION_FAILED); return; }
      const result = await api.recordShopVisit(application.id, body.data);
      if (!result.ok) { setVisitError(strings.errors[result.code]); return; }
      setOnboarding((current) => current && {
        ...current,
        visits: [result.data, ...current.visits],
        ownerPhoneState: current.ownerPhoneState === "unverified" && checks.ownerPhone ? "visit_confirmed" : current.ownerPhoneState,
      });
      setPhoto(null); if (photoInput.current) photoInput.current.value = "";
      setVisitDate(indiaToday()); setChecks(emptyChecks()); setNotes(""); setVisitNotice(strings.visitSaved);
    } catch {
      setVisitError(strings.failed);
    } finally {
      setVisitBusy(false);
    }
  }

  async function recordFee(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!onboarding) return;
    setFeeErrors({}); setFeeError(""); setFeeNotice("");
    const raw = feeStatus === "waived"
      ? { status: "waived" as const, reason: feeReason }
      : { status: "paid" as const, amount: feeAmount, paymentDate, reference, ...(feeReason.trim() ? { reason: feeReason } : {}) };
    const parsed = RecordOnboardingFeeBody.safeParse(raw);
    if (!parsed.success) {
      const errors: Partial<Record<FeeField, string>> = {};
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0]) as FeeField;
        if (field in strings.feeInvalidFields) errors[field] = strings.feeInvalidFields[field as keyof typeof strings.feeInvalidFields];
      }
      if (feeStatus === "paid" && onboarding.fees.length > 0 && !feeReason.trim()) errors.reason = strings.feeReasonRequiredForChange;
      setFeeErrors(errors);
      return;
    }
    if (feeStatus === "paid" && onboarding.fees.length > 0 && !feeReason.trim()) {
      setFeeErrors({ reason: strings.feeReasonRequiredForChange });
      return;
    }
    setFeeBusy(true);
    try {
      const result = await api.recordOnboardingFee(application.id, parsed.data);
      if (!result.ok) { setFeeError(strings.errors[result.code]); return; }
      setOnboarding((current) => current && { ...current, fees: [result.data, ...current.fees] });
      setFeeReason(""); setFeeNotice(strings.feeSaved);
    } catch {
      setFeeError(strings.failed);
    } finally {
      setFeeBusy(false);
    }
  }

  async function viewPhoto(visitId: string) {
    setPhotoBusy(true); setVisitError(""); setPhotoUrl("");
    try {
      const result = await api.getVisitPhotoAccess(application.id, visitId);
      if (result.ok) setPhotoUrl(result.data.downloadUrl);
      else setVisitError(strings.errors[result.code]);
    } catch {
      setVisitError(strings.failed);
    } finally {
      setPhotoBusy(false);
    }
  }

  return <section className="mt-8 space-y-6" aria-labelledby="onboarding-title">
    <h2 id="onboarding-title" className="text-title font-semibold">{strings.onboarding}</h2>
    {loading && <p className="text-muted">{strings.loading}</p>}
    {loadError && <p role="alert" className="rounded-lg bg-danger-subtle p-3 text-on-danger-subtle">{loadError}</p>}
    {onboarding && <>
      <section className="rounded-xl border border-border bg-surface p-6">
        <h3 className="text-body font-semibold">{strings.owner}</h3>
        <dl className="mt-3">
          <div><dt className="font-medium">{strings.ownerPhoneState}</dt><dd>{strings.phoneConfirmationStates[onboarding.ownerPhoneState]}</dd></div>
        </dl>
      </section>

      <section className="rounded-xl border border-border bg-surface p-6">
        <h3 className="text-body font-semibold">{strings.recordVisit}</h3>
        <form className="mt-4 space-y-4" onSubmit={(event) => void recordVisit(event)} noValidate>
          <div><label htmlFor="visit-photo" className="mb-2 block font-medium">{strings.visitPhoto}</label>
            <input ref={photoInput} id="visit-photo" type="file" accept="image/jpeg,.jpg,.jpeg" onChange={(event) => setPhoto(event.currentTarget.files?.[0] ?? null)} />
            {visitErrors.photo && <p role="alert" className="mt-1 text-danger">{visitErrors.photo}</p>}</div>
          <div><label htmlFor="visit-date" className="mb-2 block font-medium">{strings.visitDate}</label>
            <input id="visit-date" type="date" max={indiaToday()} value={visitDate} onChange={(event) => setVisitDate(event.target.value)} className="h-10 rounded-lg border border-border-strong bg-surface px-3" />
            {visitErrors.visitDate && <p role="alert" className="mt-1 text-danger">{visitErrors.visitDate}</p>}</div>
          <fieldset><legend className="mb-2 font-medium">{strings.visitChecksTitle}</legend>
            <div className="grid gap-2 sm:grid-cols-2">{(Object.keys(strings.visitChecks) as (keyof typeof strings.visitChecks)[]).map((field) => <label key={field} className="flex items-center gap-2">
              <input type="checkbox" checked={checks[field]} onChange={(event) => setChecks({ ...checks, [field]: event.target.checked })} />{strings.visitChecks[field]}
            </label>)}</div>
            {visitErrors.checks && <p role="alert" className="mt-1 text-danger">{visitErrors.checks}</p>}</fieldset>
          <div><label htmlFor="visit-notes" className="mb-2 block font-medium">{strings.visitNotes}</label>
            <textarea id="visit-notes" maxLength={500} value={notes} onChange={(event) => setNotes(event.target.value)} className="min-h-20 w-full rounded-lg border border-border-strong bg-surface p-3" />
            {visitErrors.notes && <p role="alert" className="mt-1 text-danger">{visitErrors.notes}</p>}</div>
          {visitError && <p role="alert" className="text-danger">{visitError}</p>}
          {visitNotice && <p role="status" className="rounded-lg bg-success-subtle p-3 text-on-success-subtle">{visitNotice}</p>}
          <button disabled={visitBusy} className="h-10 rounded-lg bg-primary px-4 font-medium text-on-primary disabled:opacity-60">{visitBusy ? strings.saving : strings.recordVisit}</button>
        </form>
      </section>

      <section className="rounded-xl border border-border bg-surface p-6">
        <h3 className="text-body font-semibold">{strings.visitHistory}</h3>
        {onboarding.visits.length === 0 ? <p className="mt-3 text-muted">{strings.noVisits}</p> : <ol className="mt-3 divide-y divide-border">{onboarding.visits.map((visit) => <li key={visit.id} className="py-4 first:pt-0">
          <div className="flex flex-wrap items-start justify-between gap-3"><div>
            <h4 className="font-medium">{formatDate(`${visit.visitDate}T00:00:00Z`)}</h4>
            <p className="text-muted">{strings.visitRecordedAt(formatDateTime(visit.recordedAt))} · {strings.visitRecordedBy(visit.actorId)}</p>
            {visit.photo?.capturedAt && <p className="text-muted">{strings.visitCapturedAt(visit.photo.capturedAt)}</p>}
            {visit.notes && <p className="mt-2">{visit.notes}</p>}
            <ul className="mt-2 grid gap-1 text-secondary sm:grid-cols-2">{Object.entries(strings.visitChecks).map(([key, label]) => <li key={key}>✓ {label}</li>)}</ul>
          </div>{visit.photo ? <button type="button" disabled={photoBusy} onClick={() => void viewPhoto(visit.id)} className="h-10 rounded-lg border border-border-strong px-3 disabled:opacity-60">{photoBusy ? strings.loading : strings.viewVisitPhoto}</button> : <span className="text-muted">{strings.visitPhotoUnavailable}</span>}</div>
        </li>)}</ol>}
      </section>

      <section className="rounded-xl border border-border bg-surface p-6">
        <h3 className="text-body font-semibold">{strings.onboardingFee}</h3>
        <form className="mt-4 space-y-4" onSubmit={(event) => void recordFee(event)} noValidate>
          <div><label htmlFor="fee-status" className="mb-2 block font-medium">{strings.feeStatus}</label>
            <select id="fee-status" value={feeStatus} onChange={(event) => setFeeStatus(event.target.value as "waived" | "paid")} className="h-10 rounded-lg border border-border-strong bg-surface px-3">
              <option value="waived">{strings.feeWaived}</option><option value="paid" disabled={onboarding.fees.length === 0}>{strings.feePaid}</option>
            </select>{onboarding.fees.length === 0 && <p className="mt-1 text-muted">{strings.feePilotWaiverHint}</p>}{feeErrors.status && <p role="alert" className="mt-1 text-danger">{feeErrors.status}</p>}</div>
          {feeStatus === "paid" && <>
            <div><label htmlFor="fee-amount" className="mb-2 block font-medium">{strings.feeAmount}</label><input id="fee-amount" inputMode="decimal" value={feeAmount} onChange={(event) => setFeeAmount(event.target.value)} onBlur={() => setFeeAmount(trimDecimal(feeAmount))} className="h-10 rounded-lg border border-border-strong bg-surface px-3" />{feeErrors.amount && <p role="alert" className="mt-1 text-danger">{feeErrors.amount}</p>}</div>
            <div><label htmlFor="fee-date" className="mb-2 block font-medium">{strings.paymentDate}</label><input id="fee-date" type="date" max={indiaToday()} value={paymentDate} onChange={(event) => setPaymentDate(event.target.value)} className="h-10 rounded-lg border border-border-strong bg-surface px-3" />{feeErrors.paymentDate && <p role="alert" className="mt-1 text-danger">{feeErrors.paymentDate}</p>}</div>
            <div><label htmlFor="fee-reference" className="mb-2 block font-medium">{strings.paymentReference}</label><input id="fee-reference" value={reference} onChange={(event) => setReference(event.target.value)} className="h-10 w-full rounded-lg border border-border-strong bg-surface px-3" />{feeErrors.reference && <p role="alert" className="mt-1 text-danger">{feeErrors.reference}</p>}</div>
          </>}
          <div><label htmlFor="fee-reason" className="mb-2 block font-medium">{strings.feeReason}</label><textarea id="fee-reason" value={feeReason} onChange={(event) => setFeeReason(event.target.value)} className="min-h-20 w-full rounded-lg border border-border-strong bg-surface p-3" />{feeErrors.reason && <p role="alert" className="mt-1 text-danger">{feeErrors.reason}</p>}</div>
          {feeError && <p role="alert" className="text-danger">{feeError}</p>}
          {feeNotice && <p role="status" className="rounded-lg bg-success-subtle p-3 text-on-success-subtle">{feeNotice}</p>}
          <button disabled={feeBusy} className="h-10 rounded-lg bg-primary px-4 font-medium text-on-primary disabled:opacity-60">{feeBusy ? strings.saving : strings.saveFee}</button>
        </form>
        {onboarding.fees.length === 0 ? <p className="mt-4 text-muted">{strings.noFees}</p> : <ol className="mt-4 divide-y divide-border">{onboarding.fees.map((fee) => <li key={fee.id} className="py-3 first:pt-0">
          <p className="font-medium">{fee.status === "paid" ? strings.feePayment(formatMoney(Number(fee.amount)), formatDate(`${fee.paymentDate}T00:00:00Z`), fee.reference) : strings.feeWaiverReason(fee.reason)}</p>
          <p className="text-muted">{strings.feeRecordedAt(formatDateTime(fee.recordedAt))} · {strings.feeRecordedBy(fee.actorId)}</p>
          {fee.status === "paid" && fee.reason && <p>{fee.reason}</p>}
        </li>)}</ol>}
      </section>
    </>}
    {photoUrl && <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4" role="dialog" aria-modal="true" aria-labelledby="visit-photo-title" onClick={() => setPhotoUrl("")}>
      <section className="max-h-full max-w-4xl rounded-xl bg-raised p-4" onClick={(event) => event.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between gap-4"><h3 id="visit-photo-title" className="font-semibold">{strings.visitPhotoTitle}</h3><button type="button" onClick={() => setPhotoUrl("")} className="rounded-lg border border-border-strong px-3 py-2">{strings.cancel}</button></div>
        <img src={photoUrl} alt={strings.visitPhotoTitle} referrerPolicy="no-referrer" className="max-h-[80dvh] max-w-full object-contain" />
      </section>
    </div>}
  </section>;
}
