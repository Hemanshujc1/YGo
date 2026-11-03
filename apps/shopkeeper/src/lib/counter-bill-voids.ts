import type { ApiResult } from "@ygo/api-client";
import type { ErrorCode, ShopCounterBill, ShopCounterBillsResponse, VoidCounterBillBody } from "@ygo/contracts";
import { strings } from "../strings";

const words = strings.voids;

/**
 * Only the server decides: Void shows while it last said the bill can be voided, and never for a bill with no
 * number (owner's answers 2–4 on #54, safeguards 1 and 3 on #492). The phone's clock is never read.
 */
export const canVoid = (bill: ShopCounterBill) => bill.voidable && bill.number !== null && bill.voided === null;

/** Refusals that change what the bill can do: the sheet closes and the list is read again (#492). */
const closesSheet = new Set<ErrorCode>(["COUNTER_BILL_VOIDED", "COUNTER_BILL_NOT_VOIDABLE", "SHOP_NOT_BILLING", "NOT_FOUND", "FORBIDDEN"]);
/** Refusals that leave the bill as it was: the sheet stays open, and the list isn't read again. */
const leavesBill = new Set<ErrorCode>(["VALIDATION_FAILED", "UNAUTHENTICATED", "UPDATE_REQUIRED", "TOO_MANY_REQUESTS"]);
/** Why a bill the list shows can no longer be voided, once a void's answer was lost. */
const stillCode = (bill: ShopCounterBill): ErrorCode => (bill.voided ? "COUNTER_BILL_VOIDED" : "COUNTER_BILL_NOT_VOIDABLE");

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
 * S37 Void a bill (#492): the shop's bills from the server, read on opening, on pull and after a void whose
 * outcome may have changed the bill; no timer, as the server's answer is the only clock.
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

  // The newest read, so a void can wait for whichever read lands last.
  let latest: Promise<void> = Promise.resolve();
  function read(pull = false) {
    latest = load(pull);
    return latest;
  }
  async function load(pull: boolean) {
    const mine = ++ticket;
    if (pull) set({ refreshing: true });
    else if (!view.bills) set({ status: "loading", message: null });
    const answer = await client.shopCounterBills().catch(() => "offline" as const);
    if (mine !== ticket) return;
    if (answer !== "offline" && answer.ok) set({ status: "ready", bills: answer.data.bills, message: null, refreshing: false });
    else set({ status: view.bills ? "ready" : "failed", message: failure(answer), refreshing: false });
  }
  /** Reads the list and waits for it, or for a newer read (a pull, a return to the app) sent meanwhile. */
  async function readThrough() {
    let mine = read();
    await mine;
    while (latest !== mine) {
      mine = latest;
      await mine;
    }
  }

  /**
   * Voids one bill. `close` says whether the sheet closes; when it stays open, it keeps the reason and note and
   * shows `message`. A tap while a void is on its way, or while the list is read again after a refusal, sends nothing.
   */
  async function voidBill(id: string, body: VoidCounterBillBody): Promise<{ close: boolean; message: string | null }> {
    if (view.voiding) return { close: false, message: null };
    set({ voiding: id, notice: null });
    try {
      return await send(id, body);
    } finally {
      // Whatever happens, the sheet never stays busy.
      if (view.voiding === id) set({ voiding: null });
    }
  }

  async function send(id: string, body: VoidCounterBillBody): Promise<{ close: boolean; message: string | null }> {
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
    // A refusal that leaves the bill as it was keeps the sheet, with its reason and note, for another try.
    if (answer !== "offline" && leavesBill.has(answer.code)) return { close: false, message: strings.errors[answer.code] };
    // Anything else may have changed the bill: a dropped connection or a timeout may have reached the server, and
    // a fault may come after the void was saved. The list is read again, the sheet busy until it lands.
    await readThrough();
    const now = view.bills?.find((bill) => bill.id === id);
    const closing = answer !== "offline" && closesSheet.has(answer.code) ? answer.code : now && !canVoid(now) ? stillCode(now) : null;
    if (closing) {
      set({ notice: { text: strings.errors[closing], tone: "danger" } });
      return { close: true, message: null };
    }
    // The list still offers Void (or couldn't be read): the sheet stays open with the reason and note.
    return { close: false, message: answer === "offline" ? words.offline : strings.errors[answer.code] };
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
