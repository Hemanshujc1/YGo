import type { ApiResult } from "@ygo/api-client";
import type { OwnerStatementsResponse, StatementBalance, StatementSummary } from "@ygo/contracts";
import { fromPaise, toPaise } from "@ygo/pricing";
import { strings } from "../strings";

const PAGE = 20;

/** Where a tap on a push or a notification row goes: its order, else its statement (#629), else the list. An older push has no statement and opens as before. */
export function openTarget({ orderId, statementId }: { orderId: string | null; statementId: string | null }) {
  if (orderId) return { pathname: "/orders/[id]" as const, params: { id: orderId } };
  if (statementId) return { pathname: "/money/[id]" as const, params: { id: statementId } };
  return "/notifications" as const;
}

type Api = { myStatements(query?: { before?: number; limit?: number }): Promise<ApiResult<OwnerStatementsResponse>> };
export type MoneyView = {
  state: "loading" | "failed" | "loaded";
  message: string | null;
  balance: StatementBalance | null;
  statements: StatementSummary[];
  hasMore: boolean;
  loadingMore: boolean;
  refreshing: boolean;
  /** A later read failed while a list is on screen, so what shows may be old. */
  refreshFailed: boolean;
  moreFailed: boolean;
};

/**
 * The balance owed to YGo as two parts that never overlap (a completed order is either on a statement or not yet), and the total as exactly their
 * sum, added here in paise: a total is never shown that counts a part twice (#630, MNY-8).
 */
const balanceOf = ({ onStatements, thisWeek }: StatementBalance): StatementBalance =>
  ({ onStatements, thisWeek, total: fromPaise(toPaise(onStatements) + toPaise(thisWeek)) });

/** S15 Money (#630): the Owner's balance and their statements, read a page at a time, newest first. */
export function createMoney(api: Api) {
  let view: MoneyView = { state: "loading", message: null, balance: null, statements: [], hasMore: false, loadingMore: false, refreshing: false, refreshFailed: false, moreFailed: false };
  let nextBefore: number | null = null;
  // A newer first-page read makes an older "more" answer stale, so it is dropped.
  let epoch = 0;
  const listeners = new Set<() => void>();
  const set = (change: Partial<MoneyView>) => { view = { ...view, ...change }; listeners.forEach((listener) => listener()); };
  const reason = (answer: ApiResult<unknown> | null) => answer && !answer.ok ? strings.errors[answer.code] : strings.money.loadFailed;

  async function load(): Promise<void> {
    const mine = ++epoch;
    // A page 2 this read drops is offered again if the read fails, since the list may not ask for it once more.
    const dropped = view.loadingMore;
    set({ refreshing: view.state === "loaded", loadingMore: false });
    const answer = await api.myStatements({ limit: PAGE }).catch(() => null);
    if (mine !== epoch) return;
    if (!answer?.ok) return set(view.state === "loaded" ? { refreshing: false, refreshFailed: true, moreFailed: view.moreFailed || dropped } : { state: "failed", message: reason(answer), refreshing: false });
    nextBefore = answer.data.nextBefore;
    set({ state: "loaded", message: null, balance: balanceOf(answer.data.balance), statements: answer.data.statements, hasMore: nextBefore !== null, refreshing: false, refreshFailed: false, moreFailed: false });
  }

  async function more(): Promise<void> {
    if (view.state !== "loaded" || !view.hasMore || view.loadingMore || nextBefore === null) return;
    const mine = epoch;
    set({ loadingMore: true, moreFailed: false });
    const answer = await api.myStatements({ before: nextBefore, limit: PAGE }).catch(() => null);
    if (mine !== epoch) return;
    if (!answer?.ok) return set({ loadingMore: false, moreFailed: true });
    nextBefore = answer.data.nextBefore;
    const known = new Set(view.statements.map((statement) => statement.id));
    // The balance stays the first page's, so it never counts a statement the list above it does not show.
    set({ statements: [...view.statements, ...answer.data.statements.filter((statement) => !known.has(statement.id))], hasMore: nextBefore !== null, loadingMore: false });
  }

  return {
    get: () => view,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => void listeners.delete(listener); },
    load, more, refresh: load,
    // The shape `useInFront` takes: read each time the screen comes to the front.
    start: () => void load(), stop: () => undefined,
  };
}
