import type { ApiResult } from "@ygo/api-client";
import type { Account } from "@ygo/contracts";
import { useSyncExternalStore } from "react";

/**
 * Where the person stands, which picks the screen (#155, Q4):
 * - `checking`: at launch, while the server is asked who is signed in.
 * - `signed-out`: C01 Sign in.
 * - `profile-needed`: C02, until the name and phone are set.
 * - `signed-in`: the app itself.
 * - `unreachable`: the launch check got no answer. The saved token is kept, and Try again calls `check`.
 */
export type SessionState =
  | { status: "checking" | "signed-out" | "unreachable" }
  | { status: "profile-needed" | "signed-in"; account: Account };

/** The calls the session makes: the app's own client. */
interface SessionApi {
  me(): Promise<ApiResult<Account>>;
  signOut(): Promise<void>;
}

// The server ended the session (refused, expired or reused). An event, not a
// latch: a later sign-in starts a new session.
const endedListeners = new Set<() => void>();

/** Pass to `createApiClient` as `onSignedOut`: the app goes back to C01 (#155, Q5). */
export function showSignedOut() {
  endedListeners.forEach((listener) => listener());
}

const byAccount = (account: Account): SessionState =>
  account.name && account.phone ? { status: "signed-in", account } : { status: "profile-needed", account };

/** One per app, beside its client: `createSession(api)`. */
export function createSession(api: SessionApi) {
  let state: SessionState = { status: "checking" };
  const listeners = new Set<() => void>();
  // Each change bumps it, so a launch check that answers after a sign-in or a sign-out is dropped.
  let turn = 0;

  function move(next: SessionState) {
    turn++;
    state = next;
    listeners.forEach((listener) => listener());
  }

  endedListeners.add(() => move({ status: "signed-out" }));

  return {
    get: () => state,

    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    /** At launch, and from Try again: asks the server who is signed in. */
    async check() {
      move({ status: "checking" });
      const mine = turn;
      let next: SessionState;
      try {
        const answer = await api.me();
        if (answer.ok) next = byAccount(answer.data);
        // No saved token, or the server refused it.
        else if (answer.code === "UNAUTHENTICATED") next = { status: "signed-out" };
        // UPDATE_REQUIRED shows the update screen over this; anything else is a server fault.
        else next = { status: "unreachable" };
      } catch {
        next = { status: "unreachable" };
      }
      if (mine === turn) move(next);
    },

    /** After C14's code is accepted, or C02 saves: the account the server answered. */
    signedIn(account: Account) {
      move(byAccount(account));
    },

    /**
     * Sign out, then C01. The client forgets the session the moment this is
     * called (#161). Resolves false when the phone's storage could not be
     * cleared: the screen may say so, and the token is never used again
     * (#155, S3).
     */
    async signOut(): Promise<boolean> {
      let cleared = true;
      try {
        await api.signOut();
      } catch {
        cleared = false;
      }
      move({ status: "signed-out" });
      return cleared;
    },
  };
}

export type Session = ReturnType<typeof createSession>;

/** The current state; the screen re-renders when it changes. */
export function useSession(session: Session): SessionState {
  return useSyncExternalStore(session.subscribe, session.get);
}
