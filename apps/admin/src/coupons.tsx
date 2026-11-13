import { createAdminApiClient } from "@ygo/api-client";
import { AdminCouponBody, type Coupon } from "@ygo/contracts";
import { formatMoney, trimDecimal } from "@ygo/format";
import { useState, type FormEvent } from "react";
import { useLoaderData } from "react-router";
import { fieldMessages } from "./lib/field-messages";
import { strings } from "./strings";

type Api = ReturnType<typeof createAdminApiClient>;
type Loaded = { coupons: Coupon[]; shops: Array<{ id: string; shopName: string }>; categories: Array<{ id: string; name: string }>; areas: Array<{ id: string; name: string }> };
type Draft = {
  funding: "platform" | "shop"; shopId: string; form: "percentage" | "flat"; code: string; percentage: string; cap: string; amount: string; minimumOrder: string;
  startsOn: string; expiresOn: string; usageLimit: string; perCustomerLimit: string; firstOrderOnly: boolean; areaIds: string[]; categoryIds: string[]; active: boolean;
};
const text = strings.coupon;

/** A date as the Admin reads it, in India: a coupon starts at the start of its day and ends at the end of its last. */
const day = (iso: string | null) => iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) : "";
const startOf = (date: string) => date ? new Date(`${date}T00:00:00+05:30`).toISOString() : null;
const endOf = (date: string) => date ? new Date(`${date}T23:59:59+05:30`).toISOString() : "";
const blank: Draft = {
  funding: "platform", shopId: "", form: "percentage", code: "", percentage: "", cap: "", amount: "", minimumOrder: "", startsOn: "", expiresOn: "", usageLimit: "",
  perCustomerLimit: "1", firstOrderOnly: false, areaIds: [], categoryIds: [], active: true,
};
const draftOf = (coupon: Coupon): Draft => ({
  funding: coupon.funding, shopId: coupon.shopId ?? "", form: coupon.form, code: coupon.code, percentage: coupon.percentage ?? "", cap: coupon.cap ?? "", amount: coupon.amount ?? "",
  minimumOrder: coupon.minimumOrder ?? "", startsOn: day(coupon.startsAt), expiresOn: day(coupon.expiresAt), usageLimit: coupon.usageLimit === null ? "" : String(coupon.usageLimit),
  perCustomerLimit: String(coupon.perCustomerLimit), firstOrderOnly: coupon.firstOrderOnly, areaIds: coupon.areaIds, categoryIds: coupon.categoryIds, active: coupon.status !== "off",
});
// A date left as it was keeps its stored moment, so an edit of something else does not move it.
const body = (draft: Draft, was: Coupon | null) => ({
  code: draft.code, funding: draft.funding, ...(draft.funding === "shop" ? { shopId: draft.shopId } : {}),
  ...(draft.form === "percentage"
    ? { form: "percentage", percentage: draft.percentage, cap: draft.cap || null }
    : { form: "flat", amount: draft.amount }),
  minimumOrder: draft.minimumOrder || null, startsAt: was && day(was.startsAt) === draft.startsOn ? was.startsAt : startOf(draft.startsOn),
  expiresAt: was && day(was.expiresAt) === draft.expiresOn ? was.expiresAt : endOf(draft.expiresOn),
  usageLimit: draft.usageLimit ? Number(draft.usageLimit) : null, perCustomerLimit: Number(draft.perCustomerLimit),
  firstOrderOnly: draft.firstOrderOnly, areaIds: draft.areaIds, categoryIds: draft.categoryIds, active: draft.active,
});
const offer = (coupon: Coupon) => {
  const main = coupon.form === "percentage" ? text.percentOff(trimDecimal(coupon.percentage ?? "")) : text.flatOff(formatMoney(coupon.amount ?? "0"));
  return `${main}${coupon.cap ? `, ${text.upTo(formatMoney(coupon.cap))}` : ""}${coupon.minimumOrder ? `, ${text.over(formatMoney(coupon.minimumOrder))}` : ""}`;
};

/** A04: Admin's coupons (ADM-5, CRT-3, #70). Every figure shown is what the server holds; the form checks with the schema the server uses. */
export function Coupons({ api }: { api: Api }) {
  const loaded = useLoaderData() as Loaded;
  const [coupons, setCoupons] = useState(loaded.coupons);
  const [editing, setEditing] = useState<Coupon | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = <Key extends keyof Draft>(key: Key, value: Draft[Key]) => setDraft((current) => current && { ...current, [key]: value });
  // A number the user typed is trimmed when they leave the field, never while typing.
  const trim = (key: "percentage" | "cap" | "amount" | "minimumOrder") => () => draft && set(key, trimDecimal(draft[key]));
  const toggle = (key: "areaIds" | "categoryIds", id: string) => draft && set(key, draft[key].includes(id) ? draft[key].filter((item) => item !== id) : [...draft[key], id]);

  function open(coupon: Coupon | null) {
    setEditing(coupon); setDraft(coupon ? draftOf(coupon) : blank); setErrors({}); setError(""); setSaved(false);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    const parsed = AdminCouponBody.safeParse(body(draft, editing));
    if (!parsed.success) { setErrors(fieldMessages(parsed.error.issues.map((issue) => String(issue.path[0])), text.fields)); return; }
    setBusy(true); setErrors({}); setError("");
    try {
      const answer = editing ? await api.updateCoupon(editing.id, parsed.data) : await api.createCoupon(parsed.data);
      if (answer.ok) {
        setCoupons((current) => [answer.data.coupon, ...current.filter((coupon) => coupon.id !== answer.data.coupon.id)]);
        setSaved(true); setDraft(null);
      } else if (answer.code === "VALIDATION_FAILED" && answer.fields?.length) setErrors(fieldMessages(answer.fields, text.fields));
      else if (answer.code === "COUPON_ABOVE_MAXIMUM" && answer.maximumPercentage) setError(text.above(answer.maximumPercentage));
      else setError(strings.errors[answer.code] ?? strings.failed);
    } catch { setError(strings.failed); } finally { setBusy(false); }
  }

  const input = "mt-1 block h-10 w-full rounded-lg border border-border-strong bg-surface px-3";
  const field = (key: string) => errors[key] && <span role="alert" className="block text-sm text-danger">{errors[key]}</span>;

  if (draft) return <section>
    <h1 className="text-title-large font-semibold">{editing ? text.edit(editing.code) : text.add}</h1>
    {editing?.status === "paused" && <p role="status" className="mt-2 rounded-lg bg-sunken p-3">{text.pausedHint}</p>}
    <form onSubmit={(event) => void save(event)} className="mt-6 max-w-2xl space-y-4" noValidate>
      <label className="block">{text.code}<input aria-label={text.code} value={draft.code} onChange={(event) => set("code", event.target.value)} className={input} /><span className="block text-sm text-muted">{text.codeHint}</span>{field("code")}</label>
      <label className="block">{text.fundingLabel}<select aria-label={text.fundingLabel} value={draft.funding} onChange={(event) => set("funding", event.target.value as Draft["funding"])} disabled={editing !== null} className={input}>
        <option value="platform">{text.funding.platform}</option><option value="shop">{text.funding.shop}</option></select></label>
      {draft.funding === "shop" && <label className="block">{text.shop}<select aria-label={text.shop} value={draft.shopId} onChange={(event) => set("shopId", event.target.value)} disabled={editing !== null} className={input}>
        <option value="">{text.chooseShop}</option>{loaded.shops.map((shop) => <option key={shop.id} value={shop.id}>{shop.shopName}</option>)}</select>{field("shopId")}</label>}
      <label className="block">{text.form}<select aria-label={text.form} value={draft.form} onChange={(event) => set("form", event.target.value as Draft["form"])} className={input}>
        <option value="percentage">{text.forms.percentage}</option><option value="flat">{text.forms.flat}</option></select></label>
      {draft.form === "percentage" ? <>
        <label className="block">{text.percentage}<input aria-label={text.percentage} inputMode="decimal" value={draft.percentage} onChange={(event) => set("percentage", event.target.value)} onBlur={trim("percentage")} className={input} />{field("percentage")}</label>
        <label className="block">{text.cap}<input aria-label={text.cap} inputMode="decimal" value={draft.cap} onChange={(event) => set("cap", event.target.value)} onBlur={trim("cap")} className={input} />{field("cap")}</label>
      </> : <label className="block">{text.amount}<input aria-label={text.amount} inputMode="decimal" value={draft.amount} onChange={(event) => set("amount", event.target.value)} onBlur={trim("amount")} className={input} />{field("amount")}</label>}
      <label className="block">{text.minimumOrder}<input aria-label={text.minimumOrder} inputMode="decimal" value={draft.minimumOrder} onChange={(event) => set("minimumOrder", event.target.value)} onBlur={trim("minimumOrder")} className={input} />
        {draft.funding === "shop" && draft.form === "flat" && <span className="block text-sm text-muted">{text.minimumOrderHint}</span>}{field("minimumOrder")}</label>
      <div className="grid gap-4 md:grid-cols-2">
        <label className="block">{text.startsOn}<input aria-label={text.startsOn} type="date" value={draft.startsOn} onChange={(event) => set("startsOn", event.target.value)} className={input} />{field("startsAt")}</label>
        <label className="block">{text.expiresOn}<input aria-label={text.expiresOn} type="date" value={draft.expiresOn} onChange={(event) => set("expiresOn", event.target.value)} className={input} />{field("expiresAt")}</label>
        <label className="block">{text.usageLimit}<input aria-label={text.usageLimit} inputMode="numeric" value={draft.usageLimit} onChange={(event) => set("usageLimit", event.target.value)} className={input} />{field("usageLimit")}</label>
        <label className="block">{text.perCustomerLimit}<input aria-label={text.perCustomerLimit} inputMode="numeric" value={draft.perCustomerLimit} onChange={(event) => set("perCustomerLimit", event.target.value)} className={input} />{field("perCustomerLimit")}</label>
      </div>
      <label className="flex min-h-10 items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={draft.firstOrderOnly} onChange={(event) => set("firstOrderOnly", event.target.checked)} />{text.firstOrderOnly}</label>
      <fieldset><legend className="font-medium">{text.areas}</legend><div className="mt-1 flex flex-wrap gap-x-4">{loaded.areas.map((area) => <label key={area.id} className="flex min-h-10 items-center gap-2">
        <input type="checkbox" className="h-5 w-5" checked={draft.areaIds.includes(area.id)} onChange={() => toggle("areaIds", area.id)} />{area.name}</label>)}</div>{field("areaIds")}</fieldset>
      <fieldset><legend className="font-medium">{text.categories}</legend><div className="mt-1 flex flex-wrap gap-x-4">{loaded.categories.map((category) => <label key={category.id} className="flex min-h-10 items-center gap-2">
        <input type="checkbox" className="h-5 w-5" checked={draft.categoryIds.includes(category.id)} onChange={() => toggle("categoryIds", category.id)} />{category.name}</label>)}</div>{field("categoryIds")}</fieldset>
      <label className="flex min-h-10 items-center gap-2 font-medium"><input type="checkbox" className="h-5 w-5" checked={draft.active} onChange={(event) => set("active", event.target.checked)} />{text.active}</label>
      {error && <p role="alert" className="rounded-lg bg-danger-subtle p-3 text-on-danger-subtle">{error}</p>}
      <div className="flex gap-3">
        <button disabled={busy} className="h-10 rounded-lg bg-primary px-4 font-medium text-on-primary disabled:opacity-60">{busy ? text.saving : text.save}</button>
        <button type="button" onClick={() => setDraft(null)} className="h-10 rounded-lg border border-border-strong px-4">{text.cancel}</button>
      </div>
    </form>
  </section>;

  const status = (coupon: Coupon) => coupon.status === "active" ? text.active : coupon.status === "paused" ? text.paused : text.off;
  return <section>
    <div className="flex items-center justify-between gap-3"><h1 className="text-title-large font-semibold">{strings.coupons}</h1>
      <button onClick={() => open(null)} className="h-10 rounded-lg bg-primary px-4 font-medium text-on-primary">{text.add}</button></div>
    <p className="mt-2 text-muted">{text.intro}</p>
    {saved && <p role="status" className="mt-4 rounded-lg bg-sunken p-3">{text.saved}</p>}
    {coupons.length === 0 ? <p className="mt-6 text-muted">{text.empty}</p> : <div className="mt-6 overflow-x-auto rounded-xl border border-border bg-surface"><table className="w-full min-w-xl text-left">
      <thead className="bg-sunken"><tr>{Object.values(text.columns).map((label) => <th key={label} scope="col" className="p-3 font-medium">{label}</th>)}<th className="p-3"><span className="sr-only">{text.edit("")}</span></th></tr></thead>
      <tbody>{coupons.map((coupon) => <tr key={coupon.id} className="border-t border-border">
        <td className="p-3 font-medium">{coupon.code}</td><td className="p-3">{text.funding[coupon.funding]}{coupon.shopId && <span className="block text-sm text-muted">{loaded.shops.find((shop) => shop.id === coupon.shopId)?.shopName}</span>}</td>
        <td className="p-3">{offer(coupon)}</td><td className="p-3 tabular-nums">{day(coupon.expiresAt)}</td>
        <td className="p-3 tabular-nums">{coupon.used}{coupon.usageLimit !== null && ` / ${coupon.usageLimit}`}</td><td className="p-3">{status(coupon)}</td>
        <td className="p-3"><button onClick={() => open(coupon)} className="text-primary underline" aria-label={text.edit(coupon.code)}>{text.edit("").trim()}</button></td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}
