import { createAdminApiClient } from "@ygo/api-client";
import {
  PriceSimulatorBody, type DeliveredQuote, type PriceSimulatorResponse, type RateCardKey, type RateCardScope,
  type RateCardValues as Values, type SimulatorListing,
} from "@ygo/contracts";
import { formatMoney, trimDecimal } from "@ygo/format";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useLoaderData } from "react-router";
import { RateCardFields, rateCardIssues, type FieldIssue } from "./components/rate-card-fields";
import { ScopeChip, ScopePicker } from "./components/scope";
import { strings } from "./strings";

type Api = ReturnType<typeof createAdminApiClient>;
type Loaded = { categories: Array<{ id: string; name: string }>; shops: Array<{ id: string; shopName: string }> };
type Priced = Extract<DeliveredQuote, { status: "priced" }>;
type RuleSource = Priced["lines"][number]["commissionSource"];
type Row = { key: string; line: { listingId: string } | { quantityOptionId: string }; label: string; price: string };

/** The values a delivered quote reads; the draft shows only these, and keeps the scope's other values as published. */
const DELIVERED_KEYS: RateCardKey[] = ["commission", "deliveryFee", "smallCartFee", "deliveredContributionFloor", "minimumCart"];
const text = strings.simulator;

/** Display only: every amount arrives worked out by the server's one calculation (MNY-15). */
const money = (amount: string) => formatMoney(Number(amount));

function rows(listings: SimulatorListing[]): Row[] {
  return listings.flatMap((listing) => {
    const label = `${listing.name}${listing.brand ? ` · ${listing.brand}` : ""} · ${trimDecimal(listing.packQuantity)} ${text.units[listing.baseUnit]}`;
    return [
      { key: `listing:${listing.listingId}`, line: { listingId: listing.listingId }, label, price: listing.onlinePrice },
      ...listing.quantityOptions.map((option) => ({
        key: `option:${option.id}`, line: { quantityOptionId: option.id },
        label: `${label} · ${option.name} (${trimDecimal(option.quantity)} ${text.units[listing.baseUnit]})`, price: option.price,
      })),
    ];
  });
}

function Source({ source }: { source: RuleSource | undefined }) {
  return source ? <span className="ml-2"><ScopeChip>{strings.rateCardSources[source.type]}</ScopeChip></span> : null;
}

function Fee({ fee, source }: { fee: Priced["deliveryFee"] | null; source: RuleSource | undefined }) {
  if (!fee) return <>{text.none}</>;
  return <>{money(fee.amount)}<Source source={source} /><span className="block text-sm text-muted">{text.shares(money(fee.platformShare), money(fee.shopShare))}</span></>;
}

function Placeable({ quote }: { quote: Priced }) {
  if (quote.placeable) return <>{text.yes}</>;
  return <><span className="font-medium text-danger">{text.no}</span><ul className="mt-1 text-sm">{quote.reasons.map((reason) => <li key={reason.code}>
    {text.reasons[reason.code](money(reason.shortfall))}<Source source={quote.sources[reason.code === "BELOW_MINIMUM_CART" ? "minimumCart" : "deliveredContributionFloor"]} />
  </li>)}</ul></>;
}

function Result({ result, labels }: { result: PriceSimulatorResponse; labels: string[] }) {
  const columns = [{ name: text.now, quote: result.now }, ...(result.draft ? [{ name: text.draft, quote: result.draft }] : [])];
  const figure = (render: (quote: Priced) => ReactNode) => columns.map(({ name, quote }) => <td key={name} className="p-3 tabular-nums">{quote.status === "priced" ? render(quote) : text.notPriced}</td>);
  const figures: Array<{ label: string; hint?: string; strong?: boolean; render: (quote: Priced) => ReactNode }> = [
    { label: text.productValue, render: (quote) => money(quote.productValue) },
    { label: text.commission, render: (quote) => money(quote.commission) },
    { label: text.deliveryFee, render: (quote) => <Fee fee={quote.deliveryFee} source={quote.sources.deliveryFee} /> },
    { label: text.smallCartFee, render: (quote) => <Fee fee={quote.smallCartFee} source={quote.sources.smallCartFee} /> },
    { label: text.customerTotal, strong: true, render: (quote) => money(quote.customerTotal) },
    { label: text.shopKeeps, hint: text.shopKeepsHint, strong: true, render: (quote) => money(quote.shopKeeps) },
    { label: text.platformEarns, hint: text.platformEarnsHint, strong: true, render: (quote) => money(quote.platformContribution) },
    { label: text.placeable, render: (quote) => <Placeable quote={quote} /> },
  ];
  const priced = columns.filter((column): column is { name: string; quote: Priced } => column.quote.status === "priced");
  return <section className="mt-8 space-y-6">
    {columns.map(({ name, quote }) => quote.status === "incomplete" && <div key={name} role="alert" className="rounded-lg bg-danger-subtle p-3 text-on-danger-subtle">
      {text.incomplete(name, quote.missing.map((key) => strings.rateCardFields[key]).join(", "))} <Link to="/rate-cards" className="underline">{text.openRateCards}</Link>
    </div>)}
    <div className="overflow-x-auto rounded-xl border border-border bg-surface"><table className="w-full text-left">
      <thead className="bg-sunken"><tr><th className="p-3 font-medium"><span className="sr-only">{text.item}</span></th>{columns.map(({ name }) => <th key={name} className="p-3 font-medium">{name}</th>)}</tr></thead>
      <tbody>{figures.map(({ label, hint, strong, render }) => <tr key={label} className={`border-t border-border ${strong ? "font-semibold" : ""}`}>
        <th className="p-3 align-top font-medium">{label}{hint && <span className="block text-sm font-normal text-muted">{hint}</span>}</th>{figure(render)}
      </tr>)}</tbody>
    </table></div>
    {priced[0] && <div className="overflow-x-auto rounded-xl border border-border bg-surface"><table className="w-full min-w-xl text-left">
      <caption className="p-3 text-left font-semibold">{text.lines}</caption>
      <thead className="bg-sunken"><tr><th className="p-3 font-medium">{text.item}</th><th className="p-3 font-medium">{text.count}</th><th className="p-3 font-medium">{text.price}</th><th className="p-3 font-medium">{text.lineTotal}</th>
        {priced.map(({ name }) => <th key={name} className="p-3 font-medium">{text.commissionAt(name)}</th>)}</tr></thead>
      <tbody>{priced[0].quote.lines.map((line, index) => <tr key={index} className="border-t border-border tabular-nums">
        <td className="p-3">{labels[index]}</td><td className="p-3">{line.count}</td><td className="p-3">{money(line.unitPrice)}</td><td className="p-3">{money(line.lineTotal)}</td>
        {priced.map(({ name, quote }) => { const own = quote.lines[index]; return <td key={name} className="p-3">{own && <>{money(own.commission)}<Source source={own.commissionSource} /></>}</td>; })}
      </tr>)}</tbody>
    </table></div>}
  </section>;
}

/** A05: price a basket now and under an unsaved draft rule (MNY-10). Nothing on this page saves or publishes a rate card. */
export function PriceSimulator({ api }: { api: Api }) {
  const { categories, shops } = useLoaderData() as Loaded;
  const [shopId, setShopId] = useState("");
  const [listings, setListings] = useState<SimulatorListing[]>();
  const [listingsError, setListingsError] = useState("");
  const [listingsRetry, setListingsRetry] = useState(0);
  const [filter, setFilter] = useState("");
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [badCounts, setBadCounts] = useState<string[]>([]);
  const [basketError, setBasketError] = useState("");
  const [draftOn, setDraftOn] = useState(false);
  const [draftType, setDraftType] = useState<RateCardScope["type"]>("global");
  const [draftCategoryId, setDraftCategoryId] = useState("");
  const [draftValues, setDraftValues] = useState<Values>({});
  const [loadingDraft, setLoadingDraft] = useState(false);
  const [draftError, setDraftError] = useState("");
  const [draftRetry, setDraftRetry] = useState(0);
  const [fieldIssues, setFieldIssues] = useState<FieldIssue[]>([]);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState("");
  const [draftInvalid, setDraftInvalid] = useState("");
  // Each calculation takes a number; an answer that comes back after the shop changed is dropped.
  const run = useRef(0);
  const [result, setResult] = useState<{ response: PriceSimulatorResponse; labels: string[] }>();
  const draftScope: RateCardScope | null = draftType === "global" ? { type: "global" }
    : draftType === "category" ? (draftCategoryId ? { type: "category", id: draftCategoryId } : null)
    : shopId ? { type: "shop", id: shopId } : null;
  const draftScopeKey = draftScope ? `${draftScope.type}:${"id" in draftScope ? draftScope.id : ""}` : "";

  useEffect(() => {
    run.current += 1;
    setListings(undefined); setListingsError(""); setCounts({}); setBadCounts([]); setBasketError(""); setResult(undefined); setRunError(""); setRunning(false);
    if (!shopId) return;
    let active = true;
    void api.listSimulatorListings(shopId).then((answer) => {
      if (!active) return;
      if (answer.ok) setListings(answer.data.listings); else setListingsError(strings.errors[answer.code]);
    }).catch(() => { if (active) setListingsError(strings.failed); });
    return () => { active = false; };
  }, [api, shopId, listingsRetry]);

  // A draft starts from what is published at its scope, so values it does not show stay as they are now.
  useEffect(() => {
    setDraftValues({}); setFieldIssues([]); setDraftError("");
    if (!draftOn || !draftScope) { setLoadingDraft(false); return; }
    let active = true;
    setLoadingDraft(true);
    void api.getRateCardScope(draftScope).then((answer) => {
      if (!active) return;
      if (answer.ok) setDraftValues(answer.data.values); else setDraftError(strings.errors[answer.code]);
    }).catch(() => { if (active) setDraftError(strings.failed); }).finally(() => { if (active) setLoadingDraft(false); });
    return () => { active = false; };
  }, [api, draftOn, draftScopeKey, draftRetry]);

  async function calculate(event: FormEvent) {
    event.preventDefault();
    setBasketError(""); setBadCounts([]); setFieldIssues([]); setRunError(""); setDraftInvalid("");
    const basket = allRows.filter((row) => (counts[row.key] ?? "").trim() !== "");
    if (!basket.length) { setBasketError(text.emptyBasket); return; }
    if (draftOn && !draftScope) { setDraftError(text.chooseDraftScope); return; }
    if (draftBlocked) return;
    const parsed = PriceSimulatorBody.safeParse({
      shopId, lines: basket.map((row) => ({ ...row.line, count: Number(counts[row.key]) })),
      ...(draftOn && draftScope ? { draft: { scope: draftScope, values: draftValues } } : {}),
    });
    if (!parsed.success) {
      const issues = parsed.error.issues;
      setBadCounts(issues.flatMap((item) => item.path[0] === "lines" && typeof item.path[1] === "number" ? [basket[item.path[1]]?.key ?? ""] : []));
      if (issues.some((item) => item.path[0] === "lines" && item.path.length === 1)) setBasketError(text.tooManyLines);
      const draftIssues = issues.filter((item) => item.path[0] === "draft");
      setFieldIssues(rateCardIssues(draftIssues, "draft.values."));
      // Not every draft problem has its own box (a fee without a split, say), so the draft also gets one message naming the rules.
      if (draftIssues.length) {
        const names = [...new Set(draftIssues.map((item) => item.path[1] === "values" && typeof item.path[2] === "string" ? item.path[2] : ""))]
          .map((key) => (strings.rateCardFields as Record<string, string>)[key]).filter(Boolean);
        setDraftInvalid(names.length ? text.draftInvalid(names.join(", ")) : text.draftInvalidGeneral);
      }
      return;
    }
    const mine = ++run.current;
    setRunning(true);
    try {
      const answer = await api.simulatePrice(parsed.data);
      if (mine !== run.current) return;
      if (answer.ok) setResult({ response: answer.data, labels: basket.map((row) => row.label) });
      else { setResult(undefined); setRunError(strings.errors[answer.code]); }
    } catch { if (mine === run.current) { setResult(undefined); setRunError(strings.failed); } }
    finally { if (mine === run.current) setRunning(false); }
  }

  const allRows = useMemo(() => rows(listings ?? []), [listings]);
  const shown = useMemo(() => allRows.filter((row) => row.label.toLowerCase().includes(filter.trim().toLowerCase())), [allRows, filter]);
  const inBasket = allRows.filter((row) => (counts[row.key] ?? "").trim() !== "");
  const hiddenInBasket = inBasket.filter((row) => !shown.includes(row)).length;
  const hiddenBadCount = badCounts.some((key) => !shown.some((row) => row.key === key));
  const draftBlocked = draftOn && (loadingDraft || !!draftError);
  return <section>
    <h1 className="text-title-large font-semibold">{strings.priceSimulator}</h1>
    <p className="mt-2 text-muted">{text.intro} {text.deliveredOnly}</p>
    <form onSubmit={(event) => void calculate(event)} className="mt-6 space-y-6" noValidate>
      <div className="rounded-xl border border-border bg-surface p-6">
        <div className="max-w-md"><ScopePicker label={text.shop} value={shopId} options={shops.map(({ id, shopName }) => ({ id, label: shopName }))} onChange={setShopId} /></div>
        {!shopId && <p className="mt-4 text-muted">{text.chooseShop}</p>}
        {shopId && !listings && !listingsError && <p role="status" className="mt-4 text-muted">{text.listingsLoading}</p>}
        {listingsError && <div className="mt-4"><p role="alert" className="text-danger">{listingsError}</p><button type="button" onClick={() => setListingsRetry((current) => current + 1)} className="mt-2 text-primary underline">{strings.retry}</button></div>}
        {listings?.length === 0 && <p className="mt-4 text-muted">{text.noListings}</p>}
        {listings && listings.length > 0 && <>
          <label className="mt-4 block max-w-md">{text.filter}<input aria-label={text.filter} value={filter} onChange={(event) => setFilter(event.target.value)} className="mt-1 block h-10 w-full rounded-lg border border-border-strong bg-surface px-3" /></label>
          <div className="mt-4 max-h-96 overflow-auto"><table className="w-full min-w-xl text-left">
            <thead className="sticky top-0 bg-sunken"><tr><th className="p-3 font-medium">{text.item}</th><th className="p-3 font-medium">{text.price}</th><th className="w-32 p-3 font-medium">{text.count}</th></tr></thead>
            <tbody>{shown.map((row) => <tr key={row.key} className="border-t border-border">
              <td className="p-3">{row.label}</td><td className="p-3 tabular-nums">{money(row.price)}</td>
              <td className="p-3"><input aria-label={text.countFor(row.label)} inputMode="numeric" value={counts[row.key] ?? ""} onChange={(event) => setCounts((current) => ({ ...current, [row.key]: event.target.value }))} className="h-10 w-24 rounded-lg border border-border-strong bg-surface px-3 tabular-nums" />
                {badCounts.includes(row.key) && <span role="alert" className="block text-sm text-danger">{text.invalidCount}</span>}</td>
            </tr>)}</tbody>
          </table></div>
          <p role="status" className="mt-4 text-muted">{text.inBasket(inBasket.length, hiddenInBasket)}</p>
          {hiddenBadCount && <p role="alert" className="mt-2 text-danger">{text.hiddenBadCount}</p>}
        </>}
        {basketError && <p role="alert" className="mt-4 text-danger">{basketError}</p>}
      </div>
      <div className="rounded-xl border border-border bg-surface p-6">
        <label className="flex min-h-10 items-center gap-2 font-semibold"><input className="h-10 w-10" type="checkbox" checked={draftOn} onChange={(event) => setDraftOn(event.target.checked)} />{text.tryDraft}</label>
        {draftOn && <div className="mt-4 space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block">{text.draftScope}<select aria-label={text.draftScope} value={draftType} onChange={(event) => { setDraftType(event.target.value as RateCardScope["type"]); setDraftCategoryId(""); }} className="mt-1 block h-10 w-full rounded-lg border border-border-strong bg-surface px-3">
              <option value="global">{strings.rateCardGlobal}</option><option value="category">{strings.rateCardCategory}</option><option value="shop">{text.draftThisShop}</option>
            </select></label>
            {draftType === "category" && <ScopePicker label={strings.rateCardCategory} value={draftCategoryId} options={categories.map(({ id, name }) => ({ id, label: name }))} onChange={setDraftCategoryId} />}
          </div>
          {draftType === "shop" && !shopId && <p className="text-muted">{text.chooseShop}</p>}
          {draftError && <div><p role="alert" className="text-danger">{draftError}</p>{draftScope && <button type="button" onClick={() => setDraftRetry((current) => current + 1)} className="mt-2 text-primary underline">{strings.retry}</button>}</div>}
          {loadingDraft ? <p role="status" className="text-muted">{text.draftLoading}</p> : draftScope && !draftError && <>
            <p className="text-muted">{text.draftHint}</p>
            <RateCardFields values={draftValues} onChange={setDraftValues} issues={fieldIssues} keys={DELIVERED_KEYS} />
          </>}
        </div>}
      </div>
      {draftInvalid && <p role="alert" className="text-danger">{draftInvalid}</p>}
      {runError && <p role="alert" className="rounded-lg bg-danger-subtle p-3 text-on-danger-subtle">{runError}</p>}
      <button disabled={running || draftBlocked} className="h-10 rounded-lg bg-primary px-4 font-medium text-on-primary disabled:opacity-60">{running ? text.calculating : text.calculate}</button>
    </form>
    {result && <Result result={result.response} labels={result.labels} />}
  </section>;
}
