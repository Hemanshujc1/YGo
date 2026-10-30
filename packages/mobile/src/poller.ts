/** Passed in, so the tests run the clock themselves. */
export type Timers = { set(run: () => void, ms: number): unknown; clear(handle: unknown): void };

export const phoneTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Reads a screen's data again every `every` ms while its screen is in front (#52, #431).
 * The caller reads, then calls `schedule` for the next one; `ticket` keeps an older answer from replacing a newer one.
 */
export function createPoller(tick: () => void, every: number, timers: Timers = phoneTimers) {
  let running = false;
  let timer: unknown;
  let ticket = 0;

  const unschedule = () => {
    if (timer !== undefined) timers.clear(timer);
    timer = undefined;
  };

  return {
    /** The screen is in front; the caller reads now. */
    start() {
      running = true;
    },
    /** The screen closed or the app went to the background. */
    stop() {
      running = false;
      unschedule();
    },
    /** Sets the next read, replacing any set already, while started and `again` holds. */
    schedule(again = true) {
      unschedule();
      if (running && again) timer = timers.set(() => {
        timer = undefined;
        tick();
      }, every);
    },
    unschedule,
    /** Taken by each read or change; the answer it gets is still the newest while the check answers true. */
    ticket() {
      const mine = ++ticket;
      return () => mine === ticket;
    },
  };
}

export type Poller = ReturnType<typeof createPoller>;
