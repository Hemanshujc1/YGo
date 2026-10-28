import { PublishRateCardBody, RateCardValues, RATE_CARD_KEYS, type RateCardKey, type RateCardResponse, type RateCardScope, type RateCardValues as Values } from "@ygo/contracts";
import { useEffect, useState, type FormEvent } from "react";
import { useLoaderData } from "react-router";
import { createAdminApiClient } from "@ygo/api-client";
import { RateCardFields, rateCardIssues, type FieldIssue } from "./components/rate-card-fields";
import { ReasonDialog } from "./components/reason-dialog";
import { ScopeChip, ScopePicker } from "./components/scope";
import { strings } from "./strings";

type Api = ReturnType<typeof createAdminApiClient>;
type Loaded = { categories: Array<{ id: string; name: string }>; shops: Array<{ id: string; shopName: string }> };
type PreviewScopes = { global: Values; category: Values; shop: Values };

export function RateCards({ api }: { api: Api }) {
  const { categories, shops } = useLoaderData() as Loaded;
  const [scopeType, setScopeType] = useState<RateCardScope["type"]>("global");
  const [scopeId, setScopeId] = useState("");
  const [shopId, setShopId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [usesPickup, setUsesPickup] = useState(false);
  const [usesBargain, setUsesBargain] = useState(false);
  const [values, setValues] = useState<Values>({});
  const [version, setVersion] = useState("0");
  const [effective, setEffective] = useState<RateCardResponse>();
  const [previewScopes, setPreviewScopes] = useState<PreviewScopes>();
  const [loadingScope, setLoadingScope] = useState(false);
  const [scopeRetry, setScopeRetry] = useState(0);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewRetry, setPreviewRetry] = useState(0);
  const [scopeError, setScopeError] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [fieldIssues, setFieldIssues] = useState<FieldIssue[]>([]);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reasonError, setReasonError] = useState("");
  const [published, setPublished] = useState<string | null>(null);
  const scope: RateCardScope | null = scopeType === "global" ? { type: "global" } : scopeId ? { type: scopeType, id: scopeId } : null;

  useEffect(() => {
    if (!scope) { setLoadingScope(false); setScopeError(""); setPublished(null); setValues({}); setVersion("0"); return; }
    let active = true;
    setLoadingScope(true); setScopeError(""); setPublished(null); setFieldIssues([]); setValues({});
    void api.getRateCardScope(scope).then((result) => {
      if (!active) return;
      if (result.ok) { setValues(result.data.values); setVersion(result.data.version); }
      else setScopeError(strings.errors[result.code]);
    }).catch(() => { if (active) setScopeError(strings.failed); }).finally(() => { if (active) setLoadingScope(false); });
    return () => { active = false; };
  }, [api, scopeType, scopeId, scopeRetry]);

  useEffect(() => {
    if (!shopId) { setEffective(undefined); setPreviewError(""); setLoadingPreview(false); return; }
    let active = true;
    setLoadingPreview(true); setPreviewError("");
    void api.getEffectiveRateCard({ shopId, ...(categoryId ? { categoryId } : {}), usesPickup, usesBargain }).then(async (result) => {
      if (!active) return;
      if (!result.ok) { setEffective(undefined); setPreviewScopes(undefined); setPreviewError(strings.errors[result.code]); return; }
      const version = result.data.version;
      const categoryRead = categoryId ? api.getRateCardScope({ type: "category", id: categoryId }, version) : Promise.resolve(undefined);
      const [global, category, shop] = await Promise.all([
        api.getRateCardScope({ type: "global" }, version), categoryRead, api.getRateCardScope({ type: "shop", id: shopId }, version),
      ]);
      if (!active) return;
      if (global.ok && shop.ok && (!categoryId || category?.ok)) {
        setEffective(result.data);
        setPreviewScopes({ global: global.data.values, category: category?.ok ? category.data.values : {}, shop: shop.data.values });
      } else {
        setEffective(undefined); setPreviewScopes(undefined);
        const failed = [global, category, shop].find((read) => read !== undefined && !read.ok);
        setPreviewError(failed && !failed.ok ? strings.errors[failed.code] : strings.failed);
      }
    }).catch(() => { if (active) { setEffective(undefined); setPreviewScopes(undefined); setPreviewError(strings.failed); } }).finally(() => { if (active) setLoadingPreview(false); });
    return () => { active = false; };
  }, [api, shopId, categoryId, usesPickup, usesBargain, version, previewRetry]);

  function validateValues(): Values | null {
    const parsed = RateCardValues.safeParse(values);
    if (!parsed.success) { setFieldIssues(rateCardIssues(parsed.error.issues)); return null; }
    setFieldIssues([]); return parsed.data;
  }

  function beginPublish(event: FormEvent) {
    event.preventDefault(); setScopeError(""); setReasonError("");
    if (!scope) { setScopeError(strings.rateCardChooseScope); return; }
    if (loadingScope || scopeError) return;
    if (validateValues()) setReasonOpen(true);
  }

  async function publish(reason: string) {
    const validValues = validateValues();
    if (!validValues) return;
    const body = PublishRateCardBody.safeParse({ scope, values: validValues, reason });
    if (!body.success) { setReasonError(strings.rateCardReasonRequired); return; }
    setBusy(true); setScopeError("");
    try {
      const result = await api.publishRateCard(body.data);
      if (result.ok) { setVersion(result.data.version); setPublished(result.data.version); setReasonOpen(false); }
      else setScopeError(strings.errors[result.code]);
    } catch { setScopeError(strings.failed); }
    finally { setBusy(false); }
  }

  const editingScopeName = scopeType === "global" ? strings.rateCardGlobal : scopeType === "category" ? categories.find((item) => item.id === scopeId)?.name ?? strings.rateCardCategory : shops.find((item) => item.id === scopeId)?.shopName ?? strings.rateCardShop;
  const draftScopeMatchesPreview = scopeType === "global" || (scopeType === "category" && scopeId !== "" && scopeId === categoryId) || (scopeType === "shop" && scopeId !== "" && scopeId === shopId);
  const scopePriority = { global: 0, category: 1, shop: 2 };
  const draftValue = (key: RateCardKey): { value: Values[RateCardKey]; source: RateCardScope["type"] } | undefined => {
    if (!previewScopes) return undefined;
    const global = scopeType === "global" && draftScopeMatchesPreview ? values : previewScopes.global;
    const category = scopeType === "category" && draftScopeMatchesPreview ? values : previewScopes.category;
    const shop = scopeType === "shop" && draftScopeMatchesPreview ? values : previewScopes.shop;
    let result: { value: Values[RateCardKey]; source: RateCardScope["type"] } | undefined;
    if (global[key] !== undefined) result = { value: global[key], source: "global" };
    if (categoryId && category[key] !== undefined) result = { value: category[key], source: "category" };
    if (shop[key] !== undefined) result = { value: shop[key], source: "shop" };
    return result;
  };
  return <section>
    <h1 className="text-title-large font-semibold">{strings.rateCards}</h1><p className="mt-2 text-muted">{strings.rateCardIntro}</p>
    <div className="mt-6 grid gap-4 rounded-xl border border-border bg-surface p-6 md:grid-cols-3">
      <label className="block">{strings.rateCardScope}<select aria-label={strings.rateCardScope} className="mt-1 block h-10 w-full rounded-lg border border-border-strong bg-surface px-3" value={scopeType} onChange={(event) => { setScopeType(event.target.value as RateCardScope["type"]); setScopeId(""); }}><option value="global">{strings.rateCardGlobal}</option><option value="category">{strings.rateCardCategory}</option><option value="shop">{strings.rateCardShop}</option></select></label>
      {scopeType !== "global" && <ScopePicker label={scopeType === "category" ? strings.rateCardCategory : strings.rateCardShop} value={scopeId} options={scopeType === "category" ? categories.map(({ id, name }) => ({ id, label: name })) : shops.map(({ id, shopName }) => ({ id, label: shopName }))} onChange={setScopeId} />}
      <p role="status" className="self-end text-muted">{strings.rateCardVersion(version)}</p>
    </div>
    {loadingScope ? <p className="mt-6 text-muted">{strings.rateCardsLoading}</p> : <form onSubmit={beginPublish} className="mt-6 space-y-4">
      <RateCardFields values={values} onChange={setValues} issues={fieldIssues} />
      {scopeError && <p role="alert" className="rounded-lg bg-danger-subtle p-3 text-on-danger-subtle">{scopeError}</p>}
      {published !== null && <p role="status" className="rounded-lg bg-success-subtle p-3 text-on-success-subtle">{strings.rateCardPublished(published)}</p>}
      <button className="h-10 rounded-lg bg-primary px-4 font-medium text-on-primary">{strings.rateCardPublish}</button>
    </form>}
    {scopeError && loadingScope === false && !reasonOpen && <button type="button" onClick={() => setScopeRetry((current) => current + 1)} className="mt-3 text-primary underline">{strings.retry}</button>}
    <section className="mt-8 rounded-xl border border-border bg-surface p-6"><h2 className="font-semibold">{strings.rateCardPreview}</h2><p className="mt-1 text-muted">{strings.rateCardPreviewHint}</p>
      <div className="mt-4 grid gap-4 md:grid-cols-2"><ScopePicker label={strings.rateCardPreviewShop} value={shopId} options={shops.map(({ id, shopName }) => ({ id, label: shopName }))} onChange={setShopId} /><ScopePicker label={strings.rateCardPreviewCategory} value={categoryId} options={categories.map(({ id, name }) => ({ id, label: name }))} onChange={setCategoryId} /></div>
      <div className="mt-4 flex gap-6"><label className="flex min-h-10 items-center gap-2"><input className="h-10 w-10" type="checkbox" checked={usesPickup} onChange={(event) => setUsesPickup(event.target.checked)} />{strings.rateCardUsesPickup}</label><label className="flex min-h-10 items-center gap-2"><input className="h-10 w-10" type="checkbox" checked={usesBargain} onChange={(event) => setUsesBargain(event.target.checked)} />{strings.rateCardUsesBargain}</label></div>
      {loadingPreview && <p role="status" className="mt-4 text-muted">{strings.rateCardPreviewLoading}</p>}
      {previewError && <div className="mt-4"><p role="alert" className="text-danger">{previewError}</p><button type="button" onClick={() => setPreviewRetry((current) => current + 1)} className="mt-2 text-primary underline">{strings.retry}</button></div>}
      {effective && <div className="mt-4 overflow-x-auto"><table className="w-full text-left"><thead><tr><th className="p-2">{strings.rateCardValues}</th><th className="p-2">{strings.rateCardNow}</th><th className="p-2">{strings.rateCardSource}</th><th className="p-2">{strings.rateCardDraftAt(editingScopeName)}</th></tr></thead><tbody>{RATE_CARD_KEYS.map((key) => {
        const item = effective.values[key];
        const draft = draftValue(key);
        const draftIsMasked = draftScopeMatchesPreview && values[key] !== undefined && draft?.source !== scopeType && draft !== undefined && scopePriority[scopeType] < scopePriority[draft.source];
        return <tr key={key} className="border-t border-border"><th className="p-2 font-medium">{strings.rateCardFields[key]}</th>
          <td className="p-2">{item ? JSON.stringify(item.value) : <span className="text-danger">{strings.rateCardMissing}</span>}</td>
          <td className="p-2">{item && <ScopeChip>{strings.rateCardSources[item.source.type]}</ScopeChip>}</td>
          <td className="p-2">{!draftScopeMatchesPreview ? <span className="text-muted">{strings.rateCardDifferentDraftScope(editingScopeName)}</span> : draftIsMasked && draft ? <span className="text-muted">{strings.rateCardDraftMasked(strings.rateCardSources[draft.source])}</span> : draft ? <>{JSON.stringify(draft.value)}<span className="ml-2"><ScopeChip>{strings.rateCardSources[draft.source]}</ScopeChip></span></> : <span className="text-danger">{strings.rateCardMissing}</span>}</td>
        </tr>;
      })}</tbody></table><p className="mt-3">{effective.complete ? strings.rateCardComplete : strings.rateCardIncomplete}</p></div>}
    </section>
    {reasonOpen && <ReasonDialog title={strings.rateCardPublishConfirm} note={strings.rateCardPublishNote} confirmLabel={strings.rateCardPublish} busy={busy} reasonError={reasonError} error={scopeError} onConfirm={(reason) => void publish(reason)} onCancel={() => setReasonOpen(false)} />}
  </section>;
}
