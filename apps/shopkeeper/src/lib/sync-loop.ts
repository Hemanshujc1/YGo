/** What one pass learned: all sent, try again later, or stop until the person acts. */
export type Outcome<T> = { kind: "done" | "retry" | "halt"; value: T | null };
export type LoopStatus = { running: boolean; outcome: Outcome<unknown>["kind"] | null; failures: number };

export const IDLE_MS = 30_000;
const FIRST_RETRY_MS = 2_000, MAX_RETRY_MS = 60_000;

/** A random wait in the upper half of 2 s, 4 s, 8 s … capped at 60 s. */
export function retryDelay(failures: number, random = Math.random): number {
  const base = Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** (failures - 1));
  return base / 2 + random() * (base / 2);
}

/**
 * The one sync worker: passes never overlap. A request during a pass gets the
 * next pass, shared by every caller, so work saved meanwhile is included.
 * Timers run only between start() and stop(), that is while foregrounded.
 */
export function createSyncLoop<T>(pass: () => Promise<Outcome<T>>, random = Math.random) {
  let active = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: Promise<T | null> | null = null;
  let next: Promise<T | null> | null = null;
  let status: LoopStatus = { running: false, outcome: null, failures: 0 };
  const listeners = new Set<() => void>();
  function show(change: Partial<LoopStatus>) { status = { ...status, ...change }; for (const notify of listeners) notify(); }
  function wait(ms: number) {
    clearTimeout(timer);
    timer = active ? setTimeout(() => void run(), ms) : undefined;
  }

  async function once(): Promise<T | null> {
    show({ running: true });
    let outcome: Outcome<T>;
    try { outcome = await pass(); } catch { outcome = { kind: "retry", value: null }; }
    const failures = outcome.kind === "retry" ? status.failures + 1 : 0;
    if (outcome.kind === "halt") { clearTimeout(timer); timer = undefined; }
    else wait(outcome.kind === "done" ? IDLE_MS : retryDelay(failures, random));
    show({ running: false, outcome: outcome.kind, failures });
    return outcome.value;
  }

  function run(): Promise<T | null> {
    if (current) {
      next ??= current.then(() => { next = null; return run(); });
      return next;
    }
    clearTimeout(timer);
    current = once().finally(() => { current = null; });
    return current;
  }

  return {
    run,
    get: () => status,
    subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
    /** Manual retry: forget the backoff and go now. */
    retryNow() { status = { ...status, failures: 0 }; return run(); },
    /** Foreground entry. */
    start() { active = true; status = { ...status, failures: 0 }; return run(); },
    /** Background or sign-out: no timer survives; a pass in flight finishes but schedules nothing. */
    stop() { active = false; clearTimeout(timer); timer = undefined; },
  };
}
