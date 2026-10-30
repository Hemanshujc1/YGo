import type { ApiResult } from "@ygo/api-client";
import type { CartLine, CartReason, CartResponse, FeedQuery, SaveCartBody } from "@ygo/contracts";
import { formatDayTime } from "@ygo/format";
import { strings } from "../strings";
import { money } from "./money";

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
  return Number(amount) === 0 ? strings.cart.free : money(amount);
}

/** Why the cart can't be ordered, in the Customer's words, each naming its fix (CRT-4). */
export function reasonText(reason: CartReason, now: number): string {
  const words = strings.cart.reasons;
  switch (reason.code) {
    case "BELOW_MINIMUM_CART": return words.minimum(money(reason.shortfall));
    // No figure: the floor's shortfall is the platform's earnings (owner's answer 7 on #50).
    case "BELOW_CONTRIBUTION_FLOOR": return words.floor;
    case "LINE_UNAVAILABLE": return words.lines;
    case "SHOP_CLOSED": return reason.opensAt ? words.closed(formatDayTime(reason.opensAt, now, strings.feed.tomorrow)) : words.closedNoTime;
    case "NOT_DELIVERING": return words.notDelivering;
    case "OWN_SHOP": return words.ownShop;
  }
}

export type CartView = {
  /** `none`: no cart, and the shop can't deliver here. */
  status: "loading" | "ready" | "failed" | "none";
  /** The server's last answer: its lines' stock, prices and quote. */
  server: CartResponse | null;
  /** The counts on screen, ahead of the server while a tap is unsaved. */
  lines: Line[];
  /** A tap the server hasn't answered yet, so no figure is shown (design system rule 7). */
  saving: boolean;
  /** Why the cart couldn't be opened or saved. */
  message: string | null;
  /** A pack the server refused to add (#410). */
  notice: string | null;
};

/**
 * The next save: the Customer's counts over the server's cart, adding at most one new pack, so a
 * refused save names the pack it refused (#410). `sent` is the counts it carries.
 */
export function nextSave(server: CartResponse | null, edits: ReadonlyMap<string, number>): { body: SaveCartBody; sent: Map<string, number> } {
  const known = new Set(server?.lines.map((line) => line.listingId));
  const sent = new Map<string, number>();
  let added = false;
  for (const [listingId, count] of edits) {
    if (count > 0 && !known.has(listingId)) {
      if (added) continue;
      added = true;
    }
    sent.set(listingId, count);
  }
  return { body: saveBody(server, rebase(server?.lines ?? [], sent)), sent };
}

type Client = {
  cart(shopId: string, query: FeedQuery): Promise<ApiResult<CartResponse>>;
  saveCart(shopId: string, query: FeedQuery, body: SaveCartBody): Promise<ApiResult<CartResponse>>;
};

type Answer = ApiResult<CartResponse> | "offline";
const failure = (answer: Exclude<Answer, { ok: true }>) => answer === "offline" ? strings.area.offline : strings.errors[answer.code];

/** Reloads in one save run before giving up, so a cart changing on every try can't loop. */
const maxReloads = 3;

/**
 * One shop's cart, shared by C05 and C07 (#406). Taps change the counts at once and are kept as
 * the Customer's counts until the server answers them; one save runs at a time, so a reply to an
 * older save never replaces newer counts on screen.
 */
export function createCart(client: Client, shopId: string, delay = cartDelay) {
  let view: CartView = { status: "loading", server: null, lines: [], saving: false, message: null, notice: null };
  let query: FeedQuery | undefined;
  /** Each count the Customer set that the server hasn't answered yet. */
  const edits = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending = false;
  let loads = 0;
  /** Set when the account signs out or changes: nothing more is sent, and no reply is shown. */
  let stopped = false;
  const listeners = new Set<() => void>();

  const set = (next: Partial<CartView>) => {
    if (stopped) return;
    view = { ...view, ...next };
    for (const listener of listeners) listener();
  };
  /** The server's cart with the Customer's unanswered counts over it. */
  const show = (fresh: CartResponse) => set({ status: "ready", server: fresh, lines: rebase(fresh.lines, edits), saving: edits.size > 0, message: null });
  /** Counts the server answered, unless the Customer changed them again meanwhile. */
  const settle = (sent: ReadonlyMap<string, number>) => {
    for (const [listingId, count] of sent) if (edits.get(listingId) === count) edits.delete(listingId);
  };
  const fail = (message: string) => set({ status: view.server ? "ready" : "failed", message });

  async function send(): Promise<void> {
    timer = undefined;
    if (sending || !query || stopped) return;
    sending = true;
    // A load already on its way is older than this save.
    loads += 1;
    let reloads = 0;
    try {
      // Stops while a tap waits for its pause; that tap's timer sends next.
      while (edits.size && !timer && !stopped) {
        const place = query;
        const { body, sent } = nextSave(view.server, edits);
        const answer: Answer = await client.saveCart(shopId, place, body).catch(() => "offline" as const);
        // Stopped while the save was on its way: its reply is another account's, and nothing more is asked.
        if (stopped) return;
        if (answer !== "offline" && answer.ok) {
          // The server may hold a count at stock; its count stands (owner's answer 9 on #50).
          settle(sent);
          show(answer.data);
          continue;
        }
        if (answer === "offline" || (answer.code !== "CART_CHANGED" && answer.code !== "NOT_FOUND")) return fail(failure(answer));
        // Changed elsewhere, or a new pack refused: reload and keep the Customer's other counts (#406).
        if (answer.code === "NOT_FOUND") {
          // The shop page showed it in stock but the cart counts whole packs (#410), or it's no longer sold.
          const known = new Set(view.server?.lines.map((line) => line.listingId));
          const refused = [...sent].find(([listingId, count]) => count > 0 && !known.has(listingId));
          if (refused) {
            settle(new Map([refused]));
            set({ notice: strings.cart.soldOut });
          }
        }
        if (++reloads > maxReloads) return fail(strings.errors.CART_CHANGED);
        const fresh = await client.cart(shopId, place).catch(() => "offline" as const);
        if (stopped) return;
        if (fresh !== "offline" && fresh.ok) show(fresh.data);
        else if (fresh !== "offline" && fresh.code === "NOT_FOUND") {
          edits.clear();
          return set({ status: "none", server: null, lines: [], saving: false });
        } else return fail(failure(fresh));
      }
    } finally {
      sending = false;
    }
  }

  const load = async (place: FeedQuery) => {
    query = place;
    // A save running brings the cart back with its reply.
    if (sending || stopped) return;
    const ticket = ++loads;
    if (!view.server) set({ status: "loading", message: null });
    const answer: Answer = await client.cart(shopId, place).catch(() => "offline" as const);
    if (ticket !== loads || sending || stopped) return;
    if (answer !== "offline" && answer.ok) {
      show(answer.data);
      // Counts a failed save left behind go again.
      if (edits.size && !timer) void send();
    } else if (answer !== "offline" && answer.code === "NOT_FOUND") {
      edits.clear();
      set({ status: "none", server: null, lines: [], saving: false });
    } else fail(failure(answer));
  };

  return {
    get: () => view,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** Reads the cart when a screen shows, keeping any unanswered taps. */
    load,

    /** One pack's count from a tap; saved after `delay` with every tap since. */
    setCount(listingId: string, count: number) {
      if (stopped) return;
      edits.set(listingId, Math.max(count, 0));
      set({ lines: rebase(view.server?.lines ?? [], edits), saving: true, message: null, notice: null });
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void send(), delay);
    },

    /** The cart a refused placement answered with (CART_CHANGED, #427): shown as a fresh read is. */
    adopt(fresh: CartResponse) {
      if (sending || stopped) return;
      loads += 1;
      show(fresh);
    },

    /** Try again after a failed load or save: reads the cart, then sends any unanswered taps. */
    retry() {
      if (query) void load(query);
    },

    /** Drops unsent taps and ignores replies still on their way, for a sign-out or another account (#406). */
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      edits.clear();
    },
  };
}

export type Cart = ReturnType<typeof createCart>;
