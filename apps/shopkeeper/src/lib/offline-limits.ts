/**
 * BIL-3: how much offline work the phone keeps, and how long it may work
 * without the server. The queue, the offline sign-in window and the S08 meter
 * all read these. Sending them from the server is #75.
 */
export const OFFLINE_LIMITS = { maxActions: 500, maxAgeHours: 72 } as const;
export const OFFLINE_WINDOW_MS = OFFLINE_LIMITS.maxAgeHours * 3600_000;
