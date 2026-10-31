import type { ApiResult } from "@ygo/api-client";
import { Account, ShopStockResponse, type SyncAccessResponse } from "@ygo/contracts";
import { OFFLINE_WINDOW_MS } from "./offline-limits";

export type SavedAccess = { account: Account; shopId: string; verifiedAt: number; stockAllowed: boolean };
export type AccessView = { mode: "online" | "offline" | "expired" | "erasing" | "ended" | "signing-out"; accountId?: string; shopId?: string; expiresAt?: number };
export interface AccessStorage {
  active(): string | undefined;
  hasData(accountId: string): boolean;
  select(accountId: string): void;
  forget(): void;
  blocked(accountId: string): string | undefined;
  read(accountId: string): Promise<SavedAccess | null>;
  save(saved: SavedAccess): Promise<void>;
  erase(accountId: string, shopId: string): Promise<void>;
}

/** A verified-access lease is independent of the oldest queued action's age. */
export function offlineAccess(storage: AccessStorage, fetchAccess: () => Promise<ApiResult<SyncAccessResponse>>, now = Date.now) {
  let view: AccessView = { mode: "online" };
  let turn = 0;
  let saved: SavedAccess | null = null;
  let last: { accountId: string; data: SyncAccessResponse } | null = null;
  function answered(accountId: string, data: SyncAccessResponse) { last = { accountId, data }; return data; }
  const erasing = new Map<string, Promise<void>>();
  const listeners = new Set<() => void>();
  function show(next: AccessView) { view = next; for (const notify of listeners) notify(); }
  function usable(record: SavedAccess) { const age = now() - record.verifiedAt; return record.stockAllowed && age >= 0 && age < OFFLINE_WINDOW_MS; }
  function cached(record: SavedAccess) {
    saved = record;
    show({ mode: storage.blocked(record.account.id) ? "erasing" : usable(record) ? "offline" : "expired", accountId: record.account.id, shopId: record.shopId, expiresAt: record.verifiedAt + OFFLINE_WINDOW_MS });
  }
  async function erase(accountId: string, shopId: string, mine: number) {
    show({ mode: "erasing", accountId, shopId });
    let work = erasing.get(accountId);
    if (!work) { work = storage.erase(accountId, shopId).finally(() => erasing.delete(accountId)); erasing.set(accountId, work); }
    await work;
    if (mine === turn) { saved = null; last = null; show({ mode: "ended", accountId }); }
  }
  return {
    get: () => view,
    /** The last answer the server gave this account, so a sync pass need not ask again. */
    answer: (accountId: string) => last?.accountId === accountId ? last.data : null,
    subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
    pause() { turn++; saved = null; last = null; storage.forget(); show({ mode: "signing-out" }); },
    reset() { turn++; saved = null; last = null; storage.forget(); show({ mode: "online" }); },
    async restore() {
      const mine = turn, id = storage.active();
      if (!id) return null;
      const record = await storage.read(id);
      if (mine !== turn || !record || record.account.id !== id) return null;
      cached(record);
      return record.account;
    },
    async verify(account: Account): Promise<SyncAccessResponse | null> {
      if (view.mode === "signing-out") return null;
      const mine = ++turn;
      const blockedShop = storage.blocked(account.id);
      if (blockedShop) { show({ mode: "erasing", accountId: account.id, shopId: blockedShop }); return null; }
      const record = await storage.read(account.id);
      if (mine !== turn) return null;
      if (record && record.account.id !== account.id) throw new Error("Saved account does not match");
      saved = record;
      let answer: ApiResult<SyncAccessResponse>;
      try { answer = await fetchAccess(); } catch {
        if (mine === turn) { if (record) cached(record); else show({ mode: "online", accountId: account.id }); }
        return null;
      }
      if (mine !== turn) return null;
      if (!answer.ok) { if (record) cached(record); return null; }
      const { shopId, state } = answer.data;
      if (state === "closed" || (record && shopId !== record.shopId) || (!record && storage.hasData(account.id) && !shopId)) {
        await erase(account.id, record?.shopId ?? shopId ?? "unlinked", mine).catch(() => undefined);
        return null;
      }
      if (shopId) {
        const stockAllowed = state === "live" || state === "suspended";
        // Approved does not confirm unlink or closure. Keep a still-valid
        // Live/Suspended lease until its original deadline.
        if (!stockAllowed && state === "approved" && record?.stockAllowed && usable(record)) {
          storage.select(account.id);
          saved = record;
          show({ mode: "offline", accountId: account.id, shopId: record.shopId, expiresAt: record.verifiedAt + OFFLINE_WINDOW_MS });
          return answered(account.id, answer.data);
        }
        const next = { account, shopId, verifiedAt: now(), stockAllowed };
        await storage.save(next);
        if (mine !== turn) return null;
        storage.select(account.id);
        saved = next;
        show({ mode: "online", accountId: account.id, ...(stockAllowed ? { shopId, expiresAt: next.verifiedAt + OFFLINE_WINDOW_MS } : {}) });
        return answered(account.id, answer.data);
      } else {
        if (mine === turn) show({ mode: "online", accountId: account.id });
        return answered(account.id, answer.data);
      }
    },
    async cleanup() {
      if (view.mode !== "erasing" || !view.accountId || !view.shopId) return;
      const mine = ++turn;
      if (view.accountId && view.shopId) await erase(view.accountId, view.shopId, mine).catch(() => undefined);
    },
    expire() { if ((view.mode === "offline" || view.mode === "online") && saved && !usable(saved)) show({ ...view, mode: "expired" }); },
    allowed(accountId: string, shopId: string) {
      return view.accountId === accountId && view.shopId === shopId && (view.mode === "online" || view.mode === "offline") && saved !== null && usable(saved);
    },
  };
}

export function readSavedAccess(raw: string | null): SavedAccess | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as SavedAccess;
    const account = Account.safeParse(value.account);
    return account.success && ShopStockResponse.shape.shopId.safeParse(value.shopId).success && typeof value.stockAllowed === "boolean" && Number.isFinite(value.verifiedAt)
      ? { ...value, account: account.data } : null;
  } catch { return null; }
}
