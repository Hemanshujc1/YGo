import type { createAdminApiClient } from "@ygo/api-client";
import type { ProofException, ProofExceptionsResponse } from "@ygo/contracts";
import { formatDateTime } from "@ygo/format";
import { useCallback, useRef, useState } from "react";
import { useLoaderData } from "react-router";
import { strings } from "./strings";

type AdminApi = ReturnType<typeof createAdminApiClient>;
type Status = "open" | "reviewed";

/**
 * A28 Proof exception (DLV-4, #60): the deliveries completed without the customer's code, with counts per shop and per
 * deliverer. Open and Reviewed tabs, filtered by shop or deliverer, a page at a time. Marking one reviewed records the
 * look and nothing else. An Area Manager sees only their own shops, since the server scopes every answer.
 */
export function ProofExceptions({ api }: { api: AdminApi }) {
  const first = useLoaderData() as ProofExceptionsResponse;
  const [status, setStatus] = useState<Status>("open");
  const [shopId, setShopId] = useState("");
  const [delivererId, setDelivererId] = useState("");
  const [rows, setRows] = useState<ProofException[]>(first.exceptions);
  const [next, setNext] = useState(first.nextCursor);
  const [counts, setCounts] = useState(first.counts);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** Each load from the top takes a number; an answer that is no longer the latest is dropped, so a slow one can't undo a newer tab or filter. */
  const latest = useRef(0);
  /** Set while a page is being fetched, synchronously, so two quick clicks send one request. */
  const paging = useRef(false);
  /** The tab and filters on screen right now, so a mark that finishes later reloads what is shown, not what was shown when it began. */
  const view = useRef({ status: "open" as Status, shopId: "", delivererId: "" });

  const query = (state: { status: Status; shopId: string; delivererId: string }) => ({
    status: state.status, ...(state.shopId ? { shopId: state.shopId } : {}), ...(state.delivererId ? { delivererId: state.delivererId } : {}),
  });
  /** From the top: a new tab, a new filter, or after a mark, when the page and the counts both changed. */
  const reload = useCallback(async (state: { status: Status; shopId: string; delivererId: string }) => {
    const mine = ++latest.current;
    setLoading(true);
    const answer = await api.listProofExceptions(query(state));
    if (mine !== latest.current) return;
    setLoading(false);
    if (!answer.ok) { setProblem(strings.proofExceptionsLoadFailed); return; }
    setProblem(null);
    setRows(answer.data.exceptions); setNext(answer.data.nextCursor); setCounts(answer.data.counts);
  }, [api]);
  const change = (patch: Partial<{ status: Status; shopId: string; delivererId: string }>) => {
    const state = { status, shopId, delivererId, ...patch };
    setStatus(state.status); setShopId(state.shopId); setDelivererId(state.delivererId);
    view.current = state;
    void reload(state);
  };
  async function more() {
    if (!next || paging.current || loading) return;
    paging.current = true;
    const mine = latest.current;
    setLoading(true);
    const answer = await api.listProofExceptions({ ...query({ status, shopId, delivererId }), cursor: next });
    paging.current = false;
    // A new tab or filter started meanwhile: this page belongs to the old list.
    if (mine !== latest.current) return;
    setLoading(false);
    if (!answer.ok) { setProblem(strings.proofExceptionsLoadFailed); return; }
    setProblem(null);
    setRows((current) => { const seen = new Set(current.map((row) => row.orderId)); return [...current, ...answer.data.exceptions.filter((row) => !seen.has(row.orderId))]; });
    setNext(answer.data.nextCursor);
  }
  /**
   * Asks for a private link only now, on the click (#560). The tab is opened first, inside the click, since a browser blocks a
   * pop-up opened after a wait; its opener is dropped at once, and it is sent to the photo when the link arrives or closed when not.
   */
  async function viewPhoto(orderId: string) {
    const tab = window.open("", "_blank");
    if (!tab) { setProblem(strings.proofExceptionsPhotoBlocked); return; }
    tab.opener = null;
    setBusy(orderId);
    const answer = await api.getProofExceptionPhoto(orderId);
    setBusy(null);
    if (!answer.ok) {
      tab.close();
      // Removed since the list loaded: reload, and the row says so itself.
      if (answer.code === "PHOTO_EXPIRED") await reload(view.current);
      else setProblem(strings.proofExceptionsPhotoFailed);
      return;
    }
    setProblem(null);
    tab.location.href = answer.data.downloadUrl;
  }
  async function review(orderId: string) {
    setBusy(orderId);
    const answer = await api.reviewProofException(orderId);
    setBusy(null);
    if (!answer.ok) { setProblem(strings.proofExceptionsReviewFailed); return; }
    await reload(view.current);
  }

  return <>
    <h1 className="text-title-large font-semibold">{strings.proofExceptions}</h1>
    <p className="mt-2 text-muted">{strings.proofExceptionsIntro}</p>

    <div className="mt-6 grid gap-6 md:grid-cols-2">
      <section aria-labelledby="by-shop" className="rounded-xl border border-border bg-surface p-4">
        <h2 id="by-shop" className="mb-2 font-semibold">{strings.proofExceptionsPerShop}</h2>
        <ul className="space-y-1">{counts.shops.map((shop) => <li key={shop.shopId} className="flex justify-between gap-3">
          <span>{shop.name}</span><span className="tabular-nums text-muted">{strings.proofExceptionsCount(shop.total, shop.open)}</span>
        </li>)}</ul>
      </section>
      <section aria-labelledby="by-deliverer" className="rounded-xl border border-border bg-surface p-4">
        <h2 id="by-deliverer" className="mb-2 font-semibold">{strings.proofExceptionsPerDeliverer}</h2>
        <ul className="space-y-1">{counts.deliverers.map((person) => <li key={person.accountId} className="flex justify-between gap-3">
          <span>{person.name ?? "—"}</span><span className="tabular-nums text-muted">{strings.proofExceptionsCount(person.total, person.open)}</span>
        </li>)}</ul>
      </section>
    </div>

    <div className="mt-8 flex flex-wrap items-end gap-4">
      <div role="tablist" className="flex gap-2">
        {(["open", "reviewed"] as const).map((tab) => <button key={tab} role="tab" aria-selected={status === tab} onClick={() => change({ status: tab })}
          className={`h-10 rounded-lg px-4 font-medium ${status === tab ? "bg-primary text-on-primary" : "border border-border-strong"}`}>
          {tab === "open" ? strings.proofExceptionsOpen : strings.proofExceptionsReviewed}</button>)}
      </div>
      <label className="flex flex-col gap-1 text-secondary">{strings.proofExceptionsFilterShop}
        <select value={shopId} onChange={(event) => change({ shopId: event.target.value })} className="h-10 rounded-lg border border-border-strong bg-surface px-3">
          <option value="">{strings.proofExceptionsAll}</option>
          {counts.shops.map((shop) => <option key={shop.shopId} value={shop.shopId}>{shop.name}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-secondary">{strings.proofExceptionsFilterDeliverer}
        <select value={delivererId} onChange={(event) => change({ delivererId: event.target.value })} className="h-10 rounded-lg border border-border-strong bg-surface px-3">
          <option value="">{strings.proofExceptionsAll}</option>
          {[...new Map(counts.deliverers.map((person) => [person.accountId, person.name ?? "—"])).entries()].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </label>
    </div>

    {problem && <p role="alert" className="mt-4 text-danger">{problem}</p>}
    <section className="mt-4 rounded-xl border border-border bg-surface">
      {rows.length === 0 ? <p className="p-6 text-muted">{status === "open" ? strings.proofExceptionsNoneOpen : strings.proofExceptionsNoneReviewed}</p> : <div className="overflow-x-auto">
        <table className="w-full min-w-3xl text-left">
          <thead className="bg-sunken"><tr>
            {[strings.proofExceptionsOrder, strings.proofExceptionsFilterShop, strings.proofExceptionsDeliverer, strings.proofExceptionsReason, strings.proofExceptionsRecorded, strings.proofExceptionsPhoto, ""].map((label, index) =>
              <th key={index} scope="col" className="p-3 font-medium">{label}</th>)}
          </tr></thead>
          <tbody>{rows.map((row) => <tr key={row.orderId} className="border-t border-border">
            <td className="p-3 tabular-nums">#{row.orderNumber}</td>
            <td className="p-3">{row.shop.name}</td>
            <td className="p-3">{row.deliverer.name ?? "—"}</td>
            <td className="p-3">{strings.proofExceptionReasons[row.reason]}</td>
            <td className="p-3 tabular-nums"><time dateTime={row.recordedAt}>{formatDateTime(row.recordedAt)}</time></td>
            <td className="p-3">{row.photo && Date.parse(row.photo.expiresAt) > Date.now()
              ? <button disabled={busy === row.orderId} onClick={() => void viewPhoto(row.orderId)} title={strings.proofExceptionsPhotoKept(formatDateTime(row.photo.expiresAt))} className="h-10 rounded-lg border border-border-strong px-4 font-medium disabled:opacity-60">
                {busy === row.orderId ? strings.proofExceptionsOpeningPhoto : strings.proofExceptionsViewPhoto}</button>
              : <span className="text-muted">{strings.proofExceptionsPhotoGone}</span>}</td>
            <td className="p-3">{row.reviewed
              ? <span className="text-muted">{strings.proofExceptionsReviewedBy(row.reviewed.by, formatDateTime(row.reviewed.at))}</span>
              : <button disabled={busy === row.orderId} onClick={() => void review(row.orderId)} className="h-10 rounded-lg border border-border-strong px-4 font-medium disabled:opacity-60">
                {busy === row.orderId ? strings.proofExceptionsReviewing : strings.proofExceptionsReview}</button>}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    </section>
    {next && <button disabled={loading} onClick={() => void more()} className="mt-4 h-10 rounded-lg border border-border-strong px-4 font-medium disabled:opacity-60">{strings.proofExceptionsMore}</button>}
  </>;
}
