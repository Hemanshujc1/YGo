import { DEFAULT_SYNC_LIMITS, type SyncLimits } from "@ygo/contracts";

/**
 * BIL-3: how much offline work the phone keeps, and how long it may work
 * without the server. The queue, the offline sign-in window and the S08 meter
 * all read these. The server sends them (#642); until it has, or when it
 * cannot be reached on a fresh start, the phone uses 500 actions and 72 hours.
 */
export const OFFLINE_LIMITS = { maxActions: DEFAULT_SYNC_LIMITS.maxActions, maxAgeHours: DEFAULT_SYNC_LIMITS.maxOfflineHours };
export type OfflineLimits = typeof OFFLINE_LIMITS;
let current: OfflineLimits = OFFLINE_LIMITS;
export const offlineLimits = {
  get: (): OfflineLimits => current,
  /** Use the limits the server last sent; null goes back to the fallback. */
  set: (limits: SyncLimits | null) => { current = limits ? { maxActions: limits.maxActions, maxAgeHours: limits.maxOfflineHours } : OFFLINE_LIMITS; },
};
export const offlineWindowMs = () => current.maxAgeHours * 3600_000;
