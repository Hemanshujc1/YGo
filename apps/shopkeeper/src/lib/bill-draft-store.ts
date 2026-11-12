import type { BillCustomer, TypedLine } from "./bill-draft";

export type DraftFields<Line> = { lines: Line[]; typed: TypedLine[]; discount: string; customer: BillCustomer; payment: "cash" | "upi" | null };
type Update<T> = T | ((current: T) => T);

/**
 * The Counter bill's unsaved draft (#599), kept outside the screen so opening a product request from a typed line and
 * coming back finds it as it was. It lives in memory only, and belongs to one account, sign-in and shop: a different
 * owner finds it empty, so a Customer's name and phone never reach the next sign-in.
 */
export function createBillDraftStore<Line>(epoch: () => number) {
  const empty = (): DraftFields<Line> => ({ lines: [], typed: [], discount: "", customer: { name: "", phone: "", offers: false }, payment: null });
  let owner = "";
  let seen = epoch();
  let fields = empty();
  let typedKey = 0;
  const listeners = new Set<() => void>();
  // A sign-out or account switch ends the draft at once, whether or not the screen is open.
  const fresh = () => { if (seen !== epoch()) { seen = epoch(); owner = ""; fields = empty(); } };
  const change = (next: DraftFields<Line>) => { fields = next; listeners.forEach((listener) => listener()); };
  const apply = <T,>(value: Update<T>, current: T) => typeof value === "function" ? (value as (current: T) => T)(current) : value;
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    get: () => { fresh(); return fields; },
    /** Names who is billing; a draft left by someone else is dropped. */
    claim(next: string) { fresh(); if (next !== owner) { owner = next; change(empty()); } },
    nextKey: () => String(++typedKey),
    set<K extends keyof DraftFields<Line>>(key: K, value: Update<DraftFields<Line>[K]>) { fresh(); change({ ...fields, [key]: apply(value, fields[key]) }); },
    clear() { change(empty()); },
  };
}
