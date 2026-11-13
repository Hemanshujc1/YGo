import type { ApiResult } from "@ygo/api-client";
import { Account, ShopStockResponse, SyncLimits, type SyncAccessResponse } from "@ygo/contracts";
import { offlineLimits, offlineWindowMs } from "./offline-limits";

/**
 * `shopName` is what a bill PDF prints offline (#53); a record saved before it, or a Draft without a name, has null.
 * `role` and `canDeliver` only decide what the phone shows (#494, #550); a record with no role, or one this phone does not know, reads as Staff who cannot deliver, so Owner-only screens stay hidden until the next check says otherwise.
 */
export type SavedAccess = { account: Account; shopId: string; verifiedAt: number; stockAllowed: boolean; shopName: string | null; shopGstin: string | null; role: "owner" | "staff"; canDeliver: boolean; limits?: SyncLimits };
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
  function usable(record: SavedAccess) { const age = now() - record.verifiedAt; return record.stockAllowed && age >= 0 && age < offlineWindowMs(); }
  function cached(record: SavedAccess) {
    saved = record;
    offlineLimits.set(record.limits ?? null);
    show({ mode: storage.blocked(record.account.id) ? "erasing" : usable(record) ? "offline" : "expired", accountId: record.account.id, shopId: record.shopId, expiresAt: record.verifiedAt + offlineWindowMs() });
  }
  async function erase(accountId: string, shopId: string, mine: number) {
    show({ mode: "erasing", accountId, shopId });
    let work = erasing.get(accountId);
    if (!work) { work = storage.erase(accountId, shopId).finally(() => erasing.delete(accountId)); erasing.set(accountId, work); }
    await work;
    if (mine === turn) { saved = null; last = null; offlineLimits.set(null); show({ mode: "ended", accountId }); }
  }
  return {
    get: () => view,
    /** The shop's name from the last check this phone saved, for a bill PDF made offline (#53). */
    shopName: () => saved?.shopName ?? null,
    /** The shop's GSTIN from the last check this phone saved, for the same bill PDF (#543). An Admin edit shows after the next online check. */
    shopGstin: () => saved?.shopGstin ?? null,
    /** The role from the last check, null with no shop. Only hides screens; the server decides what a role may do (#494). */
    role: () => saved?.role ?? null,
    /** Whether the shop answers orders (Live or Suspended), from the last check; the tab bar shows only then (#550). */
    answersOrders: () => saved?.stockAllowed ?? false,
    /** Whether this account may be given deliveries (the Owner always, Staff by the flag), from the last check (#550). The server decides who may deliver. */
    canDeliver: () => saved?.canDeliver ?? false,
    /** The last answer the server gave this account, so a sync pass need not ask again. */
    answer: (accountId: string) => last?.accountId === accountId ? last.data : null,
    subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
    pause() { turn++; saved = null; last = null; offlineLimits.set(null); storage.forget(); show({ mode: "signing-out" }); },
    reset() { turn++; saved = null; last = null; offlineLimits.set(null); storage.forget(); show({ mode: "online" }); },
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
      const { shopId, state, shopName, shopGstin, role, canDeliver, limits } = answer.data;
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
          // The lease keeps its deadline, but a changed role, deliver flag, name or GSTIN is kept so it survives a restart.
          const gstin = shopGstin ?? null;
          const name = shopName ?? null;
          const kept = (role && role !== record.role) || canDeliver !== record.canDeliver || JSON.stringify(limits) !== JSON.stringify(record.limits) || gstin !== (record.shopGstin ?? null) || name !== (record.shopName ?? null) ? { ...record, role: role ?? record.role, canDeliver, limits, shopName: name, shopGstin: gstin } : record;
          if (kept !== record) { await storage.save(kept); if (mine !== turn) return null; }
          saved = kept;
          offlineLimits.set(limits);
          show({ mode: "offline", accountId: account.id, shopId: record.shopId, expiresAt: record.verifiedAt + offlineWindowMs() });
          return answered(account.id, answer.data);
        }
        const next = { account, shopId, verifiedAt: now(), stockAllowed, shopName, shopGstin, role: role ?? "owner", canDeliver, limits };
        await storage.save(next);
        if (mine !== turn) return null;
        storage.select(account.id);
        saved = next;
        offlineLimits.set(limits);
        show({ mode: "online", accountId: account.id, ...(stockAllowed ? { shopId, expiresAt: next.verifiedAt + offlineWindowMs() } : {}) });
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
      ? { ...value, account: account.data, shopName: typeof value.shopName === "string" ? value.shopName : null, shopGstin: typeof value.shopGstin === "string" ? value.shopGstin : null, role: value.role === "owner" ? "owner" : "staff", canDeliver: typeof value.canDeliver === "boolean" ? value.canDeliver : value.role === "owner", limits: SyncLimits.safeParse(value.limits).data } : null;
  } catch { return null; }
}
