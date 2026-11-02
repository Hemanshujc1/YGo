import type { ApiResult } from "@ygo/api-client";
import type { ShopCounterBill, ShopCounterBillsResponse, VoidCounterBillBody } from "@ygo/contracts";
import { strings } from "../strings";

const words = strings.voids;

/**
 * Only the server decides: Void shows while it last said the bill can be voided, and never for a bill with no
 * number (owner's answers 2–4 on #54, safeguards 1 and 3 on #492). The phone's clock is never read.
 */
export const canVoid = (bill: ShopCounterBill) => bill.voidable && bill.number !== null && bill.voided === null;

/** Refusals that change what the bill can do: the sheet closes and the list is read again (#492). */
const closesSheet = new Set(["COUNTER_BILL_VOIDED", "COUNTER_BILL_NOT_VOIDABLE", "SHOP_NOT_BILLING", "NOT_FOUND", "FORBIDDEN"]);

const failure = (answer: ApiResult<unknown> | "offline") => (answer === "offline" ? words.offline : answer.ok ? null : strings.errors[answer.code]);

export type VoidsView = {
  status: "loading" | "ready" | "failed";
  bills: ShopCounterBill[] | null;
  /** Why the list couldn't be read. */
  message: string | null;
  refreshing: boolean;
  /** The bill being voided: one at a time. */
  voiding: string | null;
  /** The last void's outcome, shown above the list and read out. */
  notice: { text: string; tone: "success" | "danger" } | null;
};

type Client = {
  shopCounterBills(): Promise<ApiResult<ShopCounterBillsResponse>>;
  voidCounterBill(id: string, body: VoidCounterBillBody): Promise<ApiResult<ShopCounterBill>>;
};

/**
 * S37 Void a bill (#492): the shop's bills from the server, read on opening, on pull and after every void
 * refusal; no timer, as the server's answer is the only clock.
 */
export function createCounterBillVoids(client: Client) {
  let view: VoidsView = { status: "loading", bills: null, message: null, refreshing: false, voiding: null, notice: null };
  const listeners = new Set<() => void>();
  const set = (next: Partial<VoidsView>) => {
    view = { ...view, ...next };
    listeners.forEach((listener) => listener());
  };
  // Only the newest read lands; a void's answer also drops reads sent before it, as they may predate the void.
  let ticket = 0;

  async function read(pull = false) {
    const mine = ++ticket;
    if (pull) set({ refreshing: true });
    else if (!view.bills) set({ status: "loading", message: null });
    const answer = await client.shopCounterBills().catch(() => "offline" as const);
    if (mine !== ticket) return;
    if (answer !== "offline" && answer.ok) set({ status: "ready", bills: answer.data.bills, message: null, refreshing: false });
    else set({ status: view.bills ? "ready" : "failed", message: failure(answer), refreshing: false });
  }

  /**
   * Voids one bill. `close` says whether the sheet closes; when it stays open, it keeps the reason and note and
   * shows `message`. A tap while a void is on its way changes nothing.
   */
  async function voidBill(id: string, body: VoidCounterBillBody): Promise<{ close: boolean; message: string | null }> {
    if (view.voiding) return { close: false, message: null };
    set({ voiding: id, notice: null });
    const answer = await client.voidCounterBill(id, body).catch(() => "offline" as const);
    if (answer !== "offline" && answer.ok) {
      ++ticket;
      const saved = answer.data;
      set({
        voiding: null, refreshing: false, message: null,
        bills: view.bills?.map((bill) => (bill.id === id ? saved : bill)) ?? [saved],
        notice: { text: words.done(saved.number === null ? words.reference(saved.reference) : words.number(saved.number)), tone: "success" },
      });
      return { close: true, message: null };
    }
    // "Already voided" and the like: the bill changed, so the list is read again to show what it is now.
    // The sheet stays busy until that read lands, so it can't send the same void again meanwhile.
    if (answer !== "offline" && closesSheet.has(answer.code)) {
      await read();
      set({ voiding: null, notice: { text: strings.errors[answer.code], tone: "danger" } });
      return { close: true, message: null };
    }
    // No connection, or a server fault: the sheet keeps the reason and note for another try. Offline, a read
    // can't reach the server either; otherwise the list is read again in case the bill changed.
    set({ voiding: null });
    if (answer !== "offline") void read();
    return { close: false, message: failure(answer) ?? words.offline };
  }

  return {
    get: () => view,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    start: () => void read(),
    stop() {},
    refresh: () => read(true),
    retry: () => read(),
    voidBill,
  };
}

export type CounterBillVoids = ReturnType<typeof createCounterBillVoids>;
