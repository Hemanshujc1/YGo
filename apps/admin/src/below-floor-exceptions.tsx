import type { createAdminApiClient } from "@ygo/api-client";
import type { BelowFloorException, BelowFloorExceptionsResponse } from "@ygo/contracts";
import { formatDateTime, formatMoney } from "@ygo/format";
import { useCallback, useRef, useState } from "react";
import { useLoaderData } from "react-router";
import { strings } from "./strings";

type AdminApi = ReturnType<typeof createAdminApiClient>;
type Status = "open" | "reviewed";

/**
 * A30 Below the contribution floor exceptions queue (MNY-4, ADM-7, #529).
 * Open and Reviewed tabs, filtered by shop (and Area Manager for Admin), a page at a time.
 * Marking one reviewed records the look and nothing else.
 * An Area Manager sees only their assigned shops, scoped by the server.
 */
export function BelowFloorExceptions({ api }: { api: AdminApi }) {
  const first = useLoaderData() as BelowFloorExceptionsResponse;
  const [status, setStatus] = useState<Status>("open");
  const [shopId, setShopId] = useState("");
  const [areaManagerId, setAreaManagerId] = useState("");
  const [rows, setRows] = useState<BelowFloorException[]>(first.exceptions);
  const [next, setNext] = useState(first.nextCursor);
  const [counts, setCounts] = useState(first.counts);
  /** The revisions being marked reviewed: each row waits on its own, never on another's. */
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const inFlight = useRef(new Set<string>());
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** Each load from the top takes a number; an answer that is no longer the latest is dropped. */
  const latest = useRef(0);
  /** Set while a page is being fetched, synchronously, so two quick clicks send one request. */
  const paging = useRef(false);
  /** The tab and filters on screen right now, so a mark that finishes later reloads what is shown. */
  const view = useRef({ status: "open" as Status, shopId: "", areaManagerId: "" });
  const role = api.currentRole();

  const query = (state: { status: Status; shopId: string; areaManagerId: string }) => ({
    status: state.status,
    ...(state.shopId ? { shopId: state.shopId } : {}),
    ...(state.areaManagerId ? { areaManagerId: state.areaManagerId } : {}),
  });

  const reload = useCallback(async (state: { status: Status; shopId: string; areaManagerId: string }) => {
    const mine = ++latest.current;
    setLoading(true);
    const answer = await api.listBelowFloorExceptions(query(state));
    if (mine !== latest.current) return;
    setLoading(false);
    if (!answer.ok) {
      setProblem(strings.belowFloorExceptionsLoadFailed);
      return;
    }
    setProblem(null);
    setRows(answer.data.exceptions);
    setNext(answer.data.nextCursor);
    setCounts(answer.data.counts);
  }, [api]);

  const change = (patch: Partial<{ status: Status; shopId: string; areaManagerId: string }>) => {
    const state = { ...view.current, ...patch };
    setStatus(state.status);
    setShopId(state.shopId);
    setAreaManagerId(state.areaManagerId);
    view.current = state;
    void reload(state);
  };

  async function more() {
    if (!next || paging.current || loading) return;
    paging.current = true;
    const mine = latest.current;
    setLoading(true);
    const answer = await api.listBelowFloorExceptions({
      ...query({ status, shopId, areaManagerId }),
      cursor: next,
    });
    paging.current = false;
    if (mine !== latest.current) return;
    setLoading(false);
    if (!answer.ok) {
      setProblem(strings.belowFloorExceptionsLoadFailed);
      return;
    }
    setProblem(null);
    setRows((current) => {
      const seen = new Set(current.map((row) => row.revisionId));
      return [...current, ...answer.data.exceptions.filter((row) => !seen.has(row.revisionId))];
    });
    setNext(answer.data.nextCursor);
  }

  async function review(revisionId: string) {
    if (inFlight.current.has(revisionId)) return;
    inFlight.current.add(revisionId);
    setBusy((current) => new Set(current).add(revisionId));
    try {
      const answer = await api.reviewBelowFloorException(revisionId);
      if (!answer.ok) {
        setProblem(strings.belowFloorExceptionsReviewFailed);
        return;
      }
      await reload(view.current);
    } finally {
      inFlight.current.delete(revisionId);
      setBusy((current) => {
        const nextSet = new Set(current);
        nextSet.delete(revisionId);
        return nextSet;
      });
    }
  }

  return <>
    <h1 className="text-title-large font-semibold">{strings.belowFloorExceptions}</h1>
    <p className="mt-2 text-muted">{strings.belowFloorExceptionsIntro}</p>

    <div className="mt-6 max-w-md">
      <section aria-labelledby="by-shop" className="rounded-xl border border-border bg-surface p-4">
        <h2 id="by-shop" className="mb-2 font-semibold">{strings.belowFloorExceptionsPerShop}</h2>
        <ul className="space-y-1">{counts.shops.map((shop) => <li key={shop.shopId} className="flex justify-between gap-3">
          <span>{shop.name}</span><span className="tabular-nums text-muted">{strings.belowFloorExceptionsCount(shop.total, shop.open)}</span>
        </li>)}</ul>
      </section>
    </div>

    <div className="mt-8 flex flex-wrap items-end gap-4">
      <div role="tablist" className="flex gap-2">
        {(["open", "reviewed"] as const).map((tab) => <button key={tab} role="tab" aria-selected={status === tab} onClick={() => change({ status: tab })}
          className={`h-10 rounded-lg px-4 font-medium ${status === tab ? "bg-primary text-on-primary" : "border border-border-strong"}`}>
          {tab === "open" ? strings.belowFloorExceptionsOpen : strings.belowFloorExceptionsReviewed}</button>)}
      </div>
      <label className="flex flex-col gap-1 text-secondary">{strings.belowFloorExceptionsFilterShop}
        <select value={shopId} onChange={(event) => change({ shopId: event.target.value })} className="h-10 rounded-lg border border-border-strong bg-surface px-3">
          <option value="">{strings.belowFloorExceptionsAll}</option>
          {counts.shops.map((shop) => <option key={shop.shopId} value={shop.shopId}>{shop.name}</option>)}
        </select>
      </label>
      {role === "admin" && counts.areaManagers.length > 0 && (
        <label className="flex flex-col gap-1 text-secondary">{strings.belowFloorExceptionsFilterAreaManager}
          <select value={areaManagerId} onChange={(event) => change({ areaManagerId: event.target.value })} className="h-10 rounded-lg border border-border-strong bg-surface px-3">
            <option value="">{strings.belowFloorExceptionsAll}</option>
            {counts.areaManagers.map((am) => <option key={am.accountId} value={am.accountId}>{am.name ?? "—"}</option>)}
          </select>
        </label>
      )}
    </div>

    {problem && <p role="alert" className="mt-4 text-danger">{problem}</p>}

    <section className="mt-4 rounded-xl border border-border bg-surface">
      {rows.length === 0 ? <p className="p-6 text-muted">{status === "open" ? strings.belowFloorExceptionsNoneOpen : strings.belowFloorExceptionsNoneReviewed}</p> : <div className="overflow-x-auto">
        <table className="w-full min-w-4xl text-left">
          <thead className="bg-sunken"><tr>
            {[
              strings.belowFloorExceptionsOrder,
              strings.belowFloorExceptionsFilterShop,
              strings.belowFloorExceptionsPlaced,
              strings.belowFloorExceptionsStatus,
              strings.belowFloorExceptionsOriginalTotal,
              strings.belowFloorExceptionsRevisedTotal,
              strings.belowFloorExceptionsShortfall,
              strings.belowFloorExceptionsContribution,
              strings.belowFloorExceptionsReason,
              "",
            ].map((label, index) => <th key={index} scope="col" className="p-3 font-medium">{label}</th>)}
          </tr></thead>
          <tbody>{rows.map((row) => <tr key={row.revisionId} className="border-t border-border">
            <td className="p-3 tabular-nums font-medium">#{row.orderNumber}</td>
            <td className="p-3">{row.shopName}</td>
            <td className="p-3 tabular-nums"><time dateTime={row.placedAt}>{formatDateTime(row.placedAt)}</time></td>
            <td className="p-3">{strings.orderStatuses[row.status] ?? row.status}</td>
            <td className="p-3 tabular-nums">{formatMoney(row.originalTotal)}</td>
            <td className="p-3 tabular-nums">{formatMoney(row.revisedTotal)}</td>
            <td className="p-3 tabular-nums text-danger">{formatMoney(row.shortfall)}</td>
            <td className="p-3 tabular-nums">{formatMoney(row.platformContribution)}</td>
            <td className="p-3">{strings.belowFloorReason}</td>
            <td className="p-3">{row.reviewed
              ? <span className="text-muted">{strings.belowFloorExceptionsReviewedBy(row.reviewed.by, formatDateTime(row.reviewed.at))}</span>
              : <button disabled={busy.has(row.revisionId)} onClick={() => void review(row.revisionId)} className="h-10 rounded-lg border border-border-strong px-4 font-medium disabled:opacity-60">
                {busy.has(row.revisionId) ? strings.belowFloorExceptionsReviewing : strings.belowFloorExceptionsReview}</button>}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    </section>
    {next && <button disabled={loading} onClick={() => void more()} className="mt-4 h-10 rounded-lg border border-border-strong px-4 font-medium disabled:opacity-60">{strings.belowFloorExceptionsMore}</button>}
  </>;
}
