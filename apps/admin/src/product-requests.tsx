import type { createAdminApiClient } from "@ygo/api-client";
import type { AdminProductRequest, AdminProductRequestsResponse, MasterProduct, Pack } from "@ygo/contracts";
import { formatMoney, trimDecimal } from "@ygo/format";
import { useRef, useState } from "react";
import { Link, useLoaderData } from "react-router";
import { strings } from "./strings";

type AdminApi = ReturnType<typeof createAdminApiClient>;
type Tab = "pending" | "resolved";
type Panel = "map" | "reject" | null;

/**
 * A11 Product requests (CAT-3, #62): the queue of products shops asked for. Approve publishes it, once it has its image, which Admin adds on
 * Products. Map points the shop at an existing pack and moves its stock. Reject takes a reason, and an excluded good also leaves the shop's
 * counter list (D-9). A flagged request matched the denylist: it leads the queue, and nothing was ever blocked (CAT-8).
 */
export function ProductRequests({ api }: { api: AdminApi }) {
  const first = useLoaderData() as AdminProductRequestsResponse;
  const [tab, setTab] = useState<Tab>("pending");
  const [rows, setRows] = useState(first.requests);
  const [problem, setProblem] = useState<string | null>(null);
  /** Each load takes a number, so a slow answer for a tab already left can't draw over the newer one. */
  const latest = useRef(0);

  async function load(next: Tab) {
    const mine = ++latest.current;
    const answer = await api.listProductRequests(next);
    if (mine !== latest.current) return;
    if (!answer.ok) { setProblem(strings.productRequestsLoadFailed); return; }
    setRows(answer.data.requests);
  }
  function change(next: Tab) { setTab(next); setProblem(null); void load(next); }
  /** A refusal is shown in words; one that says the request moved on also reads the queue again. */
  function refused(code: string) {
    setProblem(strings.errors[code as keyof typeof strings.errors] ?? strings.productRequestsFailed);
    if (code === "PRODUCT_REQUEST_RESOLVED") void load(tab);
  }

  return <>
    <h1 className="text-title-large font-semibold">{strings.productRequests}</h1>
    <p className="mt-2 text-muted">{strings.productRequestsIntro}</p>
    <div role="tablist" className="mt-6 flex gap-2">
      {(["pending", "resolved"] as const).map((name) => <button key={name} role="tab" aria-selected={tab === name} onClick={() => change(name)}
        className={`h-10 rounded-lg px-4 font-medium ${tab === name ? "bg-primary text-on-primary" : "border border-border-strong"}`}>
        {name === "pending" ? strings.productRequestsPending : strings.productRequestsAnswered}</button>)}
    </div>
    {problem && <p role="alert" className="mt-4 text-danger">{problem}</p>}
    <div className="mt-4 space-y-4">
      {rows.length === 0 && <p className="rounded-xl border border-border bg-surface p-6 text-muted">{tab === "pending" ? strings.productRequestsNonePending : strings.productRequestsNoneAnswered}</p>}
      {rows.map((row) => <RequestCard key={row.id} api={api} row={row} onRefused={refused} onDone={() => { setProblem(null); void load(tab); }} />)}
    </div>
  </>;
}

function RequestCard({ api, row, onRefused, onDone }: { api: AdminApi; row: AdminProductRequest; onRefused: (code: string) => void; onDone: () => void }) {
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const [products, setProducts] = useState<MasterProduct[] | null>(null);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [productId, setProductId] = useState("");
  const [packId, setPackId] = useState("");
  const [reason, setReason] = useState("");
  const [excluded, setExcluded] = useState(false);
  const pending = row.status === "pending";

  /** One answer at a time per request: the buttons wait while one is in flight. */
  async function answer(send: () => ReturnType<typeof api.approveProductRequest>) {
    if (busy) return;
    setBusy(true);
    const result = await send().catch(() => null);
    setBusy(false);
    if (result?.ok) onDone();
    else onRefused(result && !result.ok ? result.code : "INTERNAL");
  }
  async function openMap() {
    setPanel("map");
    if (products) return;
    const answerProducts = await api.listMasterProducts();
    setProducts(answerProducts.ok ? answerProducts.data.products.filter((product) => product.published && product.active && product.baseUnit === row.baseUnit) : []);
  }
  async function chooseProduct(id: string) {
    setProductId(id); setPackId(""); setPacks([]);
    if (!id) return;
    const found = await api.listPacks(id);
    setPacks(found.ok ? found.data.packs.filter((pack) => pack.active) : []);
  }

  return <section className="rounded-xl border border-border bg-surface p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-title font-semibold">{row.name}{row.brand ? ` · ${row.brand}` : ""}</h2>
        <p className="text-muted">{strings.productRequestsRequestedBy(row.shop.name)} · {row.categoryName} · {trimDecimal(row.packQuantity)} {row.baseUnit}{row.barcode ? ` · ${row.barcode}` : ""}</p>
        <p className="text-muted">{formatMoney(row.counterPrice)} · MRP {formatMoney(row.mrp)}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {row.flagged && <span className="rounded-lg bg-danger-subtle px-3 py-1 text-on-danger-subtle">{strings.productRequestsFlagged}</span>}
        <span className="rounded-lg border border-border-strong px-3 py-1">{strings.productRequestsStatus[row.status]}</span>
      </div>
    </div>
    {row.reason && <p className="mt-2">{row.reason}</p>}
    {row.mappedTo && <p className="mt-2">{strings.productRequestsMappedTo(row.mappedTo.name)}</p>}
    {pending && <>
      {!row.hasImage && <p className="mt-3 text-muted">{strings.productRequestsNoImage} <Link to="/products" className="text-primary underline">{strings.productRequestsAddImage}</Link></p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <button disabled={busy || !row.hasImage} onClick={() => void answer(() => api.approveProductRequest(row.id))} className="h-10 rounded-lg bg-primary px-4 font-medium text-on-primary disabled:opacity-60">{strings.productRequestsApprove}</button>
        <button disabled={busy} onClick={() => void openMap()} className="h-10 rounded-lg border border-border-strong px-4 font-medium disabled:opacity-60">{strings.productRequestsMap}</button>
        <button disabled={busy} onClick={() => setPanel("reject")} className="h-10 rounded-lg border border-border-strong px-4 font-medium disabled:opacity-60">{strings.productRequestsReject}</button>
      </div>
      {panel === "map" && <div className="mt-4 grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1">{strings.productRequestsMapProduct}
          <select value={productId} onChange={(event) => void chooseProduct(event.target.value)} className="h-10 rounded-lg border border-border-strong bg-surface px-3">
            <option value="">{strings.productRequestsChoose}</option>
            {(products ?? []).map((product) => <option key={product.id} value={product.id}>{product.name}{product.brand ? ` · ${product.brand}` : ""}</option>)}
          </select></label>
        <label className="flex flex-col gap-1">{strings.productRequestsMapPack}
          <select value={packId} onChange={(event) => setPackId(event.target.value)} className="h-10 rounded-lg border border-border-strong bg-surface px-3">
            <option value="">{strings.productRequestsChoose}</option>
            {packs.map((pack) => <option key={pack.id} value={pack.id}>{trimDecimal(pack.quantity)} {row.baseUnit}</option>)}
          </select></label>
        <div className="flex gap-2">
          <button disabled={busy || !packId} onClick={() => void answer(() => api.mapProductRequest(row.id, packId))} className="h-10 rounded-lg bg-primary px-4 font-medium text-on-primary disabled:opacity-60">{strings.productRequestsMapConfirm}</button>
          <button onClick={() => setPanel(null)} className="h-10 rounded-lg border border-border-strong px-4 font-medium">{strings.productRequestsCancel}</button>
        </div>
      </div>}
      {panel === "reject" && <div className="mt-4 grid gap-3">
        <label className="flex flex-col gap-1">{strings.productRequestsReason}
          <textarea value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} className="min-h-20 rounded-lg border border-border-strong bg-surface p-3" /></label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={excluded} onChange={(event) => setExcluded(event.target.checked)} />{strings.productRequestsExcluded}</label>
        <div className="flex gap-2">
          <button disabled={busy || !reason.trim()} onClick={() => void answer(() => api.rejectProductRequest(row.id, { reason: reason.trim(), excludedGood: excluded }))} className="h-10 rounded-lg bg-primary px-4 font-medium text-on-primary disabled:opacity-60">{strings.productRequestsRejectConfirm}</button>
          <button onClick={() => setPanel(null)} className="h-10 rounded-lg border border-border-strong px-4 font-medium">{strings.productRequestsCancel}</button>
        </div>
      </div>}
    </>}
  </section>;
}
