import type { Account } from "@ygo/contracts";
import { describe, expect, it, vi } from "vitest";
import { listeners } from "../src/listeners";
import { createPushTaps, type Owner, type PushDevice, registerPush, ringsInFront, type Tap } from "../src/push-flow";
import type { SessionState } from "../src/session";

const token = "ExponentPushToken[abc]";

function fakeDevice({ granted = false, canAskAgain = true, allows = true, asked = false } = {}) {
  const flag = { asked };
  const device = {
    permission: vi.fn(async () => ({ granted, canAskAgain })),
    request: vi.fn(async () => allows),
    token: vi.fn(async () => token),
    asked: { get: () => flag.asked, set: () => void (flag.asked = true) },
  } satisfies PushDevice;
  return { device, flag };
}

describe("registerPush (#506)", () => {
  it("does nothing without a project ID", async () => {
    const { device } = fakeDevice({ granted: true });
    const save = vi.fn(async () => true);
    expect(await registerPush(device, undefined, save, "once")).toBe("off");
    expect(device.permission).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("sends the token once permission exists", async () => {
    const { device } = fakeDevice({ granted: true });
    const save = vi.fn(async () => true);
    expect(await registerPush(device, "project", save, "no")).toBe("saved");
    expect(device.token).toHaveBeenCalledWith("project");
    expect(save).toHaveBeenCalledWith(token);
    expect(device.request).not.toHaveBeenCalled();
  });

  it("never prompts at launch or after sign-in", async () => {
    const { device } = fakeDevice();
    const save = vi.fn(async () => true);
    expect(await registerPush(device, "project", save, "no")).toBe("no-permission");
    expect(device.request).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("prompts once per phone, and a no is never asked again", async () => {
    const { device, flag } = fakeDevice({ allows: false });
    const save = vi.fn(async () => true);
    expect(await registerPush(device, "project", save, "once")).toBe("no-permission");
    expect(flag.asked).toBe(true);
    expect(await registerPush(device, "project", save, "once")).toBe("no-permission");
    expect(device.request).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it("prompts again when the person taps S03's fix, while the phone still allows asking (#507)", async () => {
    const { device } = fakeDevice({ allows: true, asked: true });
    const save = vi.fn(async () => true);
    expect(await registerPush(device, "project", save, "once")).toBe("no-permission");
    expect(await registerPush(device, "project", save, "again")).toBe("saved");
    expect(device.request).toHaveBeenCalledTimes(1);
    // Without a project the prompt still shows, and nothing is sent.
    const unset = fakeDevice({ allows: true, asked: true }).device;
    expect(await registerPush(unset, undefined, save, "again")).toBe("off");
    expect(unset.request).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    const stopped = fakeDevice({ canAskAgain: false, asked: true }).device;
    expect(await registerPush(stopped, "project", save, "again")).toBe("no-permission");
    expect(stopped.request).not.toHaveBeenCalled();
  });

  it("does not prompt when the phone no longer allows asking", async () => {
    const { device } = fakeDevice({ canAskAgain: false });
    expect(await registerPush(device, "project", async () => true, "once")).toBe("no-permission");
    expect(device.request).not.toHaveBeenCalled();
  });

  it("sends the token once the person allows it", async () => {
    const { device } = fakeDevice({ allows: true });
    const save = vi.fn(async () => true);
    expect(await registerPush(device, "project", save, "once")).toBe("saved");
    expect(save).toHaveBeenCalledWith(token);
  });

  it("gives up quietly when the token or the save fails, to try again at the next start", async () => {
    const { device } = fakeDevice({ granted: true });
    device.token.mockRejectedValueOnce(new Error("no Firebase"));
    expect(await registerPush(device, "project", async () => true, "no")).toBe("no-token");
    expect(await registerPush(device, "project", async () => false, "no")).toBe("not-saved");
    expect(await registerPush(device, "project", () => Promise.reject(new Error("offline")), "no")).toBe("not-saved");
  });

  it("counts a permission check that fails as no permission", async () => {
    const { device } = fakeDevice();
    device.permission.mockRejectedValueOnce(new Error("broken"));
    expect(await registerPush(device, "project", async () => true, "once")).toBe("no-permission");
    expect(device.request).not.toHaveBeenCalled();
  });
});

describe("ringsInFront (#507)", () => {
  it("rings only for the push the server marks loud", () => {
    expect(ringsInFront({ notificationId: "n", orderId: "o", loud: true })).toBe(true);
    expect(ringsInFront({ notificationId: "n", orderId: "o" })).toBe(false);
    expect(ringsInFront({ loud: "true" })).toBe(false);
    expect(ringsInFront(null)).toBe(false);
  });
});

const account = (id: string): Account => ({ id, email: "asha@example.com", name: "Asha", phone: "+919876543210", theme: "system" });
const asha = "6f1c1d1e-0000-4000-8000-000000000001";
const ravi = "6f1c1d1e-0000-4000-8000-000000000002";

function fakeSession(state: SessionState) {
  const changed = listeners();
  return {
    get: () => state,
    subscribe: changed.add,
    move(next: SessionState) {
      state = next;
      changed.notify();
    },
  };
}

const tap = (key: string, notificationId = "n1", orderId: string | null = "o1"): Tap => ({ key, notificationId, orderId });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function taps(state: SessionState, read: (id: string) => Promise<Owner> = async () => "mine") {
  const session = fakeSession(state);
  const open = vi.fn();
  const reads = vi.fn(read);
  return { session, open, reads, pushTaps: createPushTaps({ session, read: reads, open }) };
}

describe("createPushTaps (#506)", () => {
  it("opens a tap the server confirms is this account's, marking it read", async () => {
    const { pushTaps, open, reads } = taps({ status: "signed-in", account: account(asha) });
    pushTaps.tap(tap("t1"));
    await settle();
    expect(reads).toHaveBeenCalledWith("n1");
    expect(open).toHaveBeenCalledWith(tap("t1"));
  });

  it("handles a tap reported twice, by the listener and the cold-start check, once", async () => {
    const { pushTaps, open, reads } = taps({ status: "signed-in", account: account(asha) });
    pushTaps.tap(tap("t1"));
    pushTaps.tap(tap("t1"));
    await settle();
    pushTaps.tap(tap("t1"));
    await settle();
    expect(reads).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("handles one notification once at a time, when two of its pushes are tapped together", async () => {
    let answer: (owner: Owner) => void = () => {};
    const { pushTaps, open, reads } = taps({ status: "signed-in", account: account(asha) }, () => new Promise((resolve) => (answer = resolve)));
    pushTaps.tap(tap("t1"));
    pushTaps.tap(tap("t2"));
    answer("mine");
    await settle();
    expect(reads).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it.each<Owner>(["not-mine", "unknown"])("opens nothing when the server answers %s", async (owner) => {
    const { pushTaps, open } = taps({ status: "signed-in", account: account(asha) }, async () => owner);
    pushTaps.tap(tap("t1"));
    await settle();
    expect(open).not.toHaveBeenCalled();
  });

  it("opens nothing when the read fails outright", async () => {
    const { pushTaps, open } = taps({ status: "signed-in", account: account(asha) }, () => Promise.reject(new Error("offline")));
    pushTaps.tap(tap("t1"));
    await settle();
    expect(open).not.toHaveBeenCalled();
  });

  it("on a cold start, waits for the launch check, then opens", async () => {
    const { pushTaps, open, reads, session } = taps({ status: "checking" });
    pushTaps.tap(tap("t1"));
    await settle();
    expect(reads).not.toHaveBeenCalled();
    session.move({ status: "signed-in", account: account(asha) });
    await settle();
    expect(open).toHaveBeenCalledWith(tap("t1"));
  });

  it.each<SessionState>([{ status: "signed-out" }, { status: "profile-needed", account: { ...account(asha), name: null } }])(
    "drops a tap when the launch check ends %o, even after a later sign-in",
    async (ended) => {
      const { pushTaps, open, reads, session } = taps({ status: "checking" });
      pushTaps.tap(tap("t1"));
      session.move(ended);
      session.move({ status: "signed-in", account: account(asha) });
      await settle();
      expect(reads).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    },
  );

  it("opens nothing when the account changed while the server was asked", async () => {
    let answer: (owner: Owner) => void = () => {};
    const { pushTaps, open, session } = taps({ status: "signed-in", account: account(asha) }, () => new Promise((resolve) => (answer = resolve)));
    pushTaps.tap(tap("t1"));
    session.move({ status: "signed-out" });
    session.move({ status: "signed-in", account: account(ravi) });
    answer("mine");
    await settle();
    expect(open).not.toHaveBeenCalled();
  });

  it("once stopped, a waiting tap is never opened, so a replaced copy can't handle it twice", async () => {
    const { pushTaps, open, reads, session } = taps({ status: "checking" });
    pushTaps.tap(tap("t1"));
    pushTaps.stop();
    session.move({ status: "signed-in", account: account(asha) });
    await settle();
    expect(reads).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("once stopped, a tap the server was already asked about is not opened when the answer comes", async () => {
    let answer: (owner: Owner) => void = () => {};
    const { pushTaps, open } = taps({ status: "signed-in", account: account(asha) }, () => new Promise((resolve) => (answer = resolve)));
    pushTaps.tap(tap("t1"));
    pushTaps.stop();
    answer("mine");
    await settle();
    expect(open).not.toHaveBeenCalled();
  });
});
