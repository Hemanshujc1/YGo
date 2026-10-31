import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSyncLoop, IDLE_MS, type Outcome, retryDelay } from "../src/lib/sync-loop";

type Kind = Outcome<number>["kind"];
function harness(kinds: Kind[], random = () => 1) {
  let running = 0, most = 0, calls = 0;
  const gates: Array<() => void> = [];
  const pass = vi.fn(async (): Promise<Outcome<number>> => {
    running++; most = Math.max(most, running); calls++;
    const call = calls;
    await new Promise<void>((resolve) => gates.push(resolve));
    running--;
    return { kind: kinds[call - 1] ?? "done", value: call };
  });
  const loop = createSyncLoop(pass, random);
  return { loop, pass, gates, most: () => most };
}
async function flush() { for (let i = 0; i < 10; i++) await Promise.resolve(); }

describe("sync loop (#395)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("never overlaps passes; callers during a pass share exactly one follow-up pass", async () => {
    const { loop, pass, gates, most } = harness([]);
    const first = loop.run();
    const second = loop.run(), third = loop.retryNow();
    expect(second).toBe(third);
    await flush(); expect(pass).toHaveBeenCalledTimes(1);
    gates.shift()?.(); expect(await first).toBe(1);
    await flush(); expect(pass).toHaveBeenCalledTimes(2);
    gates.shift()?.(); expect(await second).toBe(2);
    expect(most()).toBe(1);
  });

  it("backs off 2, 4, 8 … seconds capped at 60 with jitter in the upper half, and resets after success", async () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => retryDelay(n, () => 1))).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
    expect(retryDelay(1, () => 0)).toBe(1_000); expect(retryDelay(9, () => 0)).toBe(30_000);
    const { loop, pass, gates } = harness(["retry", "retry", "done"]);
    void loop.start();
    gates.shift()?.(); await flush();
    expect(loop.get()).toMatchObject({ outcome: "retry", failures: 1 });
    await vi.advanceTimersByTimeAsync(1_999); expect(pass).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(pass).toHaveBeenCalledTimes(2);
    gates.shift()?.(); await flush();
    await vi.advanceTimersByTimeAsync(3_999); expect(pass).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(pass).toHaveBeenCalledTimes(3);
    gates.shift()?.(); await flush();
    expect(loop.get()).toMatchObject({ outcome: "done", failures: 0, running: false });
    // Foregrounded and synced: refresh every 30 seconds.
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1); expect(pass).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1); expect(pass).toHaveBeenCalledTimes(4);
  });

  it("stops retrying on a halt or a thrown pass is retried; manual retry and foreground entry reset the backoff", async () => {
    const { loop, pass, gates } = harness(["halt"]);
    void loop.start(); gates.shift()?.(); await flush();
    await vi.advanceTimersByTimeAsync(10 * IDLE_MS);
    expect(pass).toHaveBeenCalledTimes(1);
    expect(loop.get().outcome).toBe("halt");
    void loop.retryNow(); gates.shift()?.(); await flush();
    expect(pass).toHaveBeenCalledTimes(2);

    const thrown = createSyncLoop(async () => { throw new Error("disk"); }, () => 1);
    await thrown.start(); await thrown.run();
    expect(thrown.get()).toMatchObject({ outcome: "retry", failures: 2 });
    void thrown.start(); await flush();
    expect(thrown.get().failures).toBe(1);
    thrown.stop();
  });

  it("schedules nothing in the background, and a pass in flight at stop() schedules nothing after it", async () => {
    const { loop, pass, gates } = harness(["done", "retry"]);
    void loop.start(); gates.shift()?.(); await flush();
    loop.stop();
    await vi.advanceTimersByTimeAsync(10 * IDLE_MS);
    expect(pass).toHaveBeenCalledTimes(1);
    void loop.start(); loop.stop();
    gates.shift()?.(); await flush();
    await vi.advanceTimersByTimeAsync(10 * IDLE_MS);
    expect(pass).toHaveBeenCalledTimes(2);
    // Explicit work (a save) still syncs while stopped, without arming a timer.
    void loop.run(); gates.shift()?.(); await flush();
    await vi.advanceTimersByTimeAsync(10 * IDLE_MS);
    expect(pass).toHaveBeenCalledTimes(3);
  });
});
