import type { createAdminApiClient } from "@ygo/api-client";
import type { AdminOrderGroup, AdminOrderRow, AdminOrdersResponse } from "@ygo/contracts";
import { formatMoney, formatTime } from "@ygo/format";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLoaderData } from "react-router";
import { OrderStatusPill } from "./components/order-status-pill";
import { strings } from "./strings";

type AdminApi = ReturnType<typeof createAdminApiClient>;

/** How often the list asks the server again (A14). There is no push channel: this is a poll. */
export const POLL_MS = 10_000;
/** The server's default and largest page (AdminOrdersQuery). */
const PAGE = 50;
const MAX_PAGE = 100;
const GROUPS: AdminOrderGroup[] = ["active", "unanswered", "final", "all"];

/**
 * A14 Live orders (ADM-4, ADM-7, #66). Newest placed first, filtered by group and shop, a page at a time, refreshed every 10 seconds.
 * "Unanswered" is decided by the server's clock and shown as the server counts it. An Area Manager sees only their shops' orders, scoped by the server.
 */
export function LiveOrders({ api }: { api: AdminApi }) {
  const first = useLoaderData() as AdminOrdersResponse;
  const [group, setGroup] = useState<AdminOrderGroup>("active");
  const [shopId, setShopId] = useState("");
  const [rows, setRows] = useState<AdminOrderRow[]>(first.orders);
  const [next, setNext] = useState(first.nextCursor);
  const [counts, setCounts] = useState(first.counts);
  const [serverTime, setServerTime] = useState(first.serverTime);
  const [afterSeconds, setAfterSeconds] = useState(first.unansweredAfterSeconds);
  /** Shops seen in any answer, for the filter: the server has no shop list for this screen. */
  const [shops, setShops] = useState<ReadonlyMap<string, string>>(() => new Map(first.orders.map((row) => [row.shopId, row.shopName])));
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** Each load from the top takes a number; an answer that is no longer the latest is dropped, so a slow poll can't undo a newer filter. */
  const latest = useRef(0);
  const paging = useRef(false);
  const view = useRef({ group: "active" as AdminOrderGroup, shopId: "" });
  /** How many rows are on screen, so a poll refreshes every page loaded so far (up to the server's page limit), not just the first. */
  const shown = useRef(first.orders.length);

  const remember = (orders: AdminOrderRow[]) => setShops((current) => {
    const merged = new Map(current);
    for (const order of orders) merged.set(order.shopId, order.shopName);
    return merged;
  });

  /** From the top. A poll keeps the pages already loaded and updates the rows it knows, so "Show more" is never undone. */
  const load = useCallback(async (state: { group: AdminOrderGroup; shopId: string }, keepPages: boolean) => {
    const mine = ++latest.current;
    setLoading(true);
    const limit = keepPages ? Math.min(MAX_PAGE, Math.max(shown.current, 1)) : undefined;
    const answer = await api.listAdminOrders({ group: state.group, ...(state.shopId ? { shopId: state.shopId } : {}), ...(limit && limit > PAGE ? { limit } : {}) });
    if (mine !== latest.current) return;
    setLoading(false);
    if (!answer.ok) return setProblem(strings.liveOrdersLoadFailed);
    setProblem(null);
    const { orders, nextCursor, counts: newCounts, serverTime: at, unansweredAfterSeconds } = answer.data;
    setRows((current) => {
      if (!keepPages) return (shown.current = orders.length, orders);
      const fresh = new Set(orders.map((order) => order.id));
      const oldest = orders.at(-1)?.cursor;
      const merged = [...orders, ...current.filter((order) => !fresh.has(order.id) && oldest !== undefined && order.cursor < oldest)];
      shown.current = merged.length;
      return merged;
    });
    setNext((current) => keepPages && current && orders.length >= MAX_PAGE ? current : nextCursor);
    setCounts(newCounts);
    setServerTime(at);
    setAfterSeconds(unansweredAfterSeconds);
    remember(orders);
  }, [api]);

  useEffect(() => {
    // A poll never starts while "Show more" is fetching: it would make that answer out of date and the click would do nothing.
    const timer = setInterval(() => { if (!paging.current) void load(view.current, true); }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const change = (patch: Partial<{ group: AdminOrderGroup; shopId: string }>) => {
    const state = { ...view.current, ...patch };
    view.current = state;
    setGroup(state.group);
    setShopId(state.shopId);
    void load(state, false);
  };

  async function more() {
    if (!next || paging.current || loading) return;
    paging.current = true;
    const mine = latest.current;
    setLoading(true);
    const answer = await api.listAdminOrders({ group, ...(shopId ? { shopId } : {}), cursor: next });
    paging.current = false;
    if (mine !== latest.current) return;
    setLoading(false);
    if (!answer.ok) return setProblem(strings.liveOrdersLoadFailed);
    setProblem(null);
    setRows((current) => {
      const seen = new Set(current.map((row) => row.id));
      const merged = [...current, ...answer.data.orders.filter((row) => !seen.has(row.id))];
      shown.current = merged.length;
      return merged;
    });
    setNext(answer.data.nextCursor);
    remember(answer.data.orders);
  }

  const chipLabel = (chip: AdminOrderGroup) => chip === "active" ? `${strings.liveOrdersGroups.active} ${counts.active}`
    : chip === "unanswered" ? `${strings.liveOrdersUnansweredChip(strings.orderSpokenMinutes(afterSeconds))} ${counts.unanswered}`
    : strings.liveOrdersGroups[chip];

  return <>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-title-large font-semibold">{strings.liveOrders}</h1><p className="mt-2 text-muted">{strings.liveOrdersIntro}</p></div>
      <div className="flex items-center gap-3"><span className="text-muted tabular-nums">{strings.liveOrdersUpdated(formatTime(serverTime))}</span>
        <button disabled={loading} onClick={() => void load(view.current, true)} className="h-10 rounded-lg border border-border-strong px-4 font-medium disabled:opacity-60">
          {loading ? strings.liveOrdersRefreshing : strings.liveOrdersRefresh}</button></div>
    </div>

    <div className="mt-6 flex flex-wrap items-end gap-4">
      <div role="tablist" className="flex flex-wrap gap-2">
        {GROUPS.map((chip) => <button key={chip} role="tab" aria-selected={group === chip} onClick={() => change({ group: chip })}
          className={`h-10 rounded-lg px-4 font-medium ${group === chip ? "bg-primary text-on-primary" : "border border-border-strong"}`}>{chipLabel(chip)}</button>)}
      </div>
      <label className="flex flex-col gap-1 text-secondary">{strings.liveOrdersFilterShop}
        <select value={shopId} onChange={(event) => change({ shopId: event.target.value })} className="h-10 rounded-lg border border-border-strong bg-surface px-3">
          <option value="">{strings.liveOrdersAllShops}</option>
          {[...shops].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </label>
    </div>

    {problem && <p role="alert" className="mt-4 text-danger">{problem}</p>}

    <section className="mt-4 rounded-xl border border-border bg-surface">
      {rows.length === 0 ? <p className="p-6 text-muted">{strings.liveOrdersEmpty}</p> : <div className="overflow-x-auto">
        <table className="w-full min-w-4xl text-left">
          <thead className="bg-sunken"><tr>
            {Object.values(strings.liveOrdersColumns).map((label) => <th key={label} scope="col" className="p-3 font-medium">{label}</th>)}
          </tr></thead>
          <tbody>{rows.map((row) => <tr key={row.id} className="border-t border-border">
            <td className="p-3 tabular-nums font-medium"><Link to={`/orders/${row.id}`} className="text-primary underline">#{row.number}</Link></td>
            <td className="p-3">{row.shopName}</td>
            <td className="p-3">{row.customerName ?? strings.orderDetailUnnamed}</td>
            <td className="p-3">{strings.fulfilment[row.fulfilment]}</td>
            <td className="p-3"><div className="flex flex-wrap items-center gap-2"><OrderStatusPill status={row.status} />
              {row.unanswered && <span className="text-secondary font-medium text-danger">{strings.liveOrdersUnansweredTag}</span>}</div></td>
            <td className="p-3 tabular-nums">{strings.orderAge(row.statusAgeSeconds)}</td>
            <td className="p-3 tabular-nums">{formatMoney(row.total)}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    </section>
    {next && <button disabled={loading} onClick={() => void more()} className="mt-4 h-10 rounded-lg border border-border-strong px-4 font-medium disabled:opacity-60">{strings.liveOrdersMore}</button>}
  </>;
}
