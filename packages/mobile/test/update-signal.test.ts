import { describe, expect, it, vi } from "vitest";
import { isUpdateRequired, showUpdateRequired, subscribe } from "../src/update-signal";

describe("showUpdateRequired", () => {
  it("latches once and notifies each listener once", () => {
    const listener = vi.fn();
    const removed = vi.fn();
    subscribe(listener);
    const unsubscribe = subscribe(removed);
    unsubscribe();

    expect(isUpdateRequired()).toBe(false);
    showUpdateRequired();
    showUpdateRequired();

    expect(isUpdateRequired()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(removed).not.toHaveBeenCalled();
  });
});
