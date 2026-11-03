import type { SessionState } from "./session";

/** What registering needs from the phone: `expo-notifications` and a flag kept on the phone, swapped in tests. */
export interface PushDevice {
  permission(): Promise<{ granted: boolean; canAskAgain: boolean }>;
  /** Shows the system prompt; answers whether it was allowed. */
  request(): Promise<boolean>;
  token(projectId: string): Promise<string>;
  /** Whether this phone has shown the prompt once; it is never shown again (owner's note on #506). */
  asked: { get(): boolean; set(): void };
}

export type Registered = "off" | "no-permission" | "no-token" | "saved" | "not-saved";

/**
 * Sends the phone's Expo push token to the server (#506). Nothing happens without a project ID or permission. `ask`
 * shows the system prompt, but only once per phone and only while the phone still allows asking: a person who said
 * no is never asked again. A token that can't be had or sent is tried again at the next start.
 */
export async function registerPush(device: PushDevice, projectId: string | undefined, save: (token: string) => Promise<boolean>, ask: boolean): Promise<Registered> {
  if (!projectId) return "off";
  const now = await device.permission().catch(() => ({ granted: false, canAskAgain: false }));
  let granted = now.granted;
  if (!granted && ask && now.canAskAgain && !device.asked.get()) {
    // Set first, so a prompt that never answers is still not shown twice.
    device.asked.set();
    granted = await device.request().catch(() => false);
  }
  if (!granted) return "no-permission";
  const token = await device.token(projectId).catch(() => null);
  if (!token) return "no-token";
  return (await save(token).catch(() => false)) ? "saved" : "not-saved";
}

/** A tapped push: `key` is the tap's own identifier, the rest is the push's data (#505). */
export type Tap = { key: string; notificationId: string; orderId: string | null };

/** Whether the notification belongs to whoever is signed in, as the server answers when asked to mark it read. */
export type Owner = "mine" | "not-mine" | "unknown";

type Session = { get(): SessionState; subscribe(listener: () => void): () => void };

/**
 * Opens what a tapped push points at, from the foreground, the background or a cold start alike (#506). Each tap is
 * handled once, however many times the phone reports it, and a notification is not handled twice at once. A tap waits
 * while the launch check runs, and is dropped when nobody is signed in. Marking it read is the ownership check: only
 * a notification the server confirms is this account's opens anything, and only while that account is still signed in.
 */
export function createPushTaps({ session, read, open }: { session: Session; read(notificationId: string): Promise<Owner>; open(tap: Tap): void }) {
  const seen = new Set<string>();
  const opening = new Set<string>();
  let waiting: Tap[] = [];

  async function handle(tap: Tap, accountId: string) {
    opening.add(tap.notificationId);
    const owner = await read(tap.notificationId).catch((): Owner => "unknown");
    opening.delete(tap.notificationId);
    const now = session.get();
    if (owner === "mine" && now.status === "signed-in" && now.account.id === accountId) open(tap);
  }

  function drain() {
    const state = session.get();
    if (state.status === "checking" || state.status === "unreachable") return;
    const taps = waiting;
    waiting = [];
    if (state.status !== "signed-in") return;
    for (const tap of taps) if (!opening.has(tap.notificationId)) void handle(tap, state.account.id);
  }

  const stop = session.subscribe(drain);

  return {
    /** Stops waiting on the session. */
    stop,
    tap(tap: Tap) {
      if (seen.has(tap.key)) return;
      seen.add(tap.key);
      waiting.push(tap);
      drain();
    },
  };
}
