import type { ApiResult } from "@ygo/api-client";
import type { CartLine, CartReason, CartResponse, FeedQuery, SaveCartBody } from "@ygo/contracts";
import { formatDayTime, formatMoney } from "@ygo/format";
import { strings } from "../strings";

type Line = SaveCartBody["lines"][number];

/** The pause after the last tap before the cart is saved, so rapid taps send one save (#406). */
export const cartDelay = 300;

/** The lines with one pack's count changed: 0 removes it, a new pack goes last. */
export function withCount(lines: readonly Line[], listingId: string, count: number): Line[] {
  if (count <= 0) return lines.filter((line) => line.listingId !== listingId);
  return lines.some((line) => line.listingId === listingId)
    ? lines.map((line) => line.listingId === listingId ? { listingId, count } : line)
    : [...lines, { listingId, count }];
}

/** The save for the lines on screen, based on the revision the phone last saw (owner's clarification 1 on #50). */
export function saveBody(server: CartResponse | null, lines: readonly Line[]): SaveCartBody {
  return { revision: server?.revision ?? 0, lines: lines.map(({ listingId, count }) => ({ listingId, count })) };
}

/** The Customer's changes laid over a cart that changed elsewhere, so a reload keeps their latest taps. */
export function rebase(lines: readonly CartLine[], edits: ReadonlyMap<string, number>): Line[] {
  let next: Line[] = lines.map(({ listingId, count }) => ({ listingId, count }));
  for (const [listingId, count] of edits) next = withCount(next, listingId, count);
  return next;
}

/** "View cart · 3 items", counting packs. */
export function cartBarLabel(lines: readonly Line[]): string {
  return strings.cart.view(lines.reduce((sum, line) => sum + line.count, 0));
}

/**
 * The packs left where the server says the count reached stock, so + stops there (owner's answer 9 on #50);
 * null before its first reply for a new pack, when the server's reply corrects the count.
 */
export function stockLeft(server: CartResponse | null, listingId: string): number | null {
  return server?.lines.find((line) => line.listingId === listingId)?.left ?? null;
}

/** "Free" for a zero fee, else the amount with no trailing zeros. */
export function feeText(amount: string): string {
  return Number(amount) === 0 ? strings.cart.free : formatMoney(Number(amount));
}

/** Why the cart can't be ordered, in the Customer's words, each naming its fix (CRT-4). */
export function reasonText(reason: CartReason, now: number): string {
  const words = strings.cart.reasons;
  switch (reason.code) {
    case "BELOW_MINIMUM_CART": return words.minimum(formatMoney(Number(reason.shortfall)));
    // No figure: the floor's shortfall is the platform's earnings (owner's answer 7 on #50).
    case "BELOW_CONTRIBUTION_FLOOR": return words.floor;
    case "LINE_UNAVAILABLE": return words.lines;
    case "SHOP_CLOSED": return reason.opensAt ? words.closed(formatDayTime(reason.opensAt, now, strings.feed.tomorrow)) : words.closedNoTime;
    case "NOT_DELIVERING": return words.notDelivering;
  }
}

export type CartView = {
  /** `none`: no cart, and the shop can't deliver here. */
  status: "loading" | "ready" | "failed" | "none";
  /** The server's last answer: its lines' stock, prices and quote. */
  server: CartResponse | null;
  /** The counts on screen, ahead of the server while a save waits. */
  lines: Line[];
  /** A newer cart than `server` is waiting or being saved, so no total is shown (design system rule 7). */
  saving: boolean;
  /** Why the cart couldn't be opened or saved. */
  message: string | null;
  /** A pack the server refused to add (#410). */
  notice: string | null;
};

type Client = {
  cart(shopId: string, query: FeedQuery): Promise<ApiResult<CartResponse>>;
  saveCart(shopId: string, query: FeedQuery, body: SaveCartBody): Promise<ApiResult<CartResponse>>;
};

type Answer = ApiResult<CartResponse> | "offline";
const failure = (answer: Exclude<Answer, { ok: true }>) => answer === "offline" ? strings.area.offline : strings.errors[answer.code];

/**
 * One shop's cart, shared by C05 and C07 (#406). Taps change the counts at once; one save at a
 * time carries the latest lines, so a reply to an older save never replaces newer counts on screen.
 */
export function createCart(client: Client, shopId: string, delay = cartDelay) {
  let view: CartView = { status: "loading", server: null, lines: [], saving: false, message: null, notice: null };
  let query: FeedQuery | undefined;
  /** Each count the Customer set since the server's last answer covered them. */
  const edits = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending = false;
  let dirty = false;
  let loads = 0;
  const listeners = new Set<() => void>();

  const set = (next: Partial<CartView>) => {
    view = { ...view, ...next };
    for (const listener of listeners) listener();
  };
  const busy = () => dirty || sending || timer !== undefined;
  const fetchCart = (place: FeedQuery): Promise<Answer> => client.cart(shopId, place).catch(() => "offline" as const);

  /** A fresh cart from the server with the Customer's edits laid over it; saves again when they differ. */
  function rebased(fresh: CartResponse) {
    const lines = rebase(fresh.lines, edits);
    const same = lines.length === fresh.lines.length && lines.every((line, index) => line.count === fresh.lines[index]?.count && line.listingId === fresh.lines[index]?.listingId);
    if (same) edits.clear();
    else dirty = true;
    set({ status: "ready", server: fresh, lines, saving: !same, message: null });
    if (!same) void send();
  }

  async function send(): Promise<void> {
    timer = undefined;
    if (sending || !query) return;
    sending = true;
    dirty = false;
    const place = query;
    const answer: Answer = await client.saveCart(shopId, place, saveBody(view.server, view.lines)).catch(() => "offline" as const);
    sending = false;
    if (answer !== "offline" && answer.ok) {
      if (busy()) {
        // Newer taps are waiting: keep their counts, take only the new revision.
        set({ server: answer.data });
        if (!timer) void send();
        return;
      }
      edits.clear();
      set({ status: "ready", server: answer.data, lines: rebase(answer.data.lines, edits), saving: false, message: null });
      return;
    }
    if (answer !== "offline" && (answer.code === "CART_CHANGED" || answer.code === "NOT_FOUND")) {
      // Changed elsewhere, or refused a new pack: reload and keep the Customer's latest taps (#406).
      const fresh = await fetchCart(place);
      if (fresh !== "offline" && fresh.ok) {
        if (answer.code === "NOT_FOUND") {
          // A pack the shop page showed in stock but the cart counts whole packs (#410), or one no longer sold.
          const had = new Set(fresh.data.lines.map((line) => line.listingId));
          const refused = [...edits].filter(([listingId, count]) => count > 0 && !had.has(listingId));
          for (const [listingId] of refused) edits.delete(listingId);
          if (refused.length) set({ notice: strings.cart.soldOut });
        }
        rebased(fresh.data);
        return;
      }
      if (fresh !== "offline" && fresh.code === "NOT_FOUND") {
        edits.clear();
        set({ status: "none", server: null, lines: [], saving: false });
        return;
      }
      dirty = true;
      set({ saving: false, message: failure(fresh) });
      return;
    }
    dirty = true;
    set({ saving: false, message: failure(answer) });
  }

  return {
    get: () => view,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    /** Reads the cart when a screen shows; unsaved taps win, since their save brings the cart back. */
    async load(place: FeedQuery) {
      query = place;
      if (busy()) return;
      const ticket = ++loads;
      if (!view.server) set({ status: "loading", message: null });
      const answer = await fetchCart(place);
      if (ticket !== loads) return;
      if (answer !== "offline" && answer.ok) {
        rebased(answer.data);
        return;
      }
      if (busy()) return;
      if (answer !== "offline" && answer.code === "NOT_FOUND") set({ status: "none", server: null, lines: [] });
      // A cart already shown keeps the server's last answer; only a first load fails.
      else if (!view.server) set({ status: "failed", message: failure(answer) });
    },

    /** One pack's count from a tap; saved after `delay` with every tap since. */
    setCount(listingId: string, count: number) {
      edits.set(listingId, Math.max(count, 0));
      dirty = true;
      loads += 1;
      set({ lines: withCount(view.lines, listingId, count), saving: true, message: null, notice: null });
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void send(), delay);
    },

    /** Try again after a failed save. */
    retry() {
      if (!dirty) return;
      set({ saving: true, message: null });
      void send();
    },
  };
}

export type Cart = ReturnType<typeof createCart>;
