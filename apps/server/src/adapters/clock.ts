/**
 * Every deadline in the product reads time through this, in the service and in
 * the jobs, so a test can move time instead of waiting (ADR-0004 amendment).
 */
export interface Clock {
  now(): Date;
}

/** A clock that stands still until the test sets or advances it. */
export function createLocalClock(start: Date): Clock & {
  set(to: Date): void;
  advance(ms: number): void;
} {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    set(to: Date) {
      current = to.getTime();
    },
    advance(ms: number) {
      current += ms;
    },
  };
}
