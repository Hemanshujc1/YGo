import type { ApiResult } from "@ygo/api-client";
import type { Account } from "@ygo/contracts";
import { useSyncExternalStore } from "react";
import { listeners } from "./listeners";
import { onSignedOut } from "./signed-out";

/**
 * Where the person stands, which picks the screen (#155, Q4):
 * - `checking`: at launch, while the server is asked who is signed in.
 * - `signed-out`: C01 Sign in. `notCleared` when a sign-out could not clear
 *   the phone's storage: C01 says so once, and the token is never used again (#155, S3 and Q5).
 * - `profile-needed`: C02, until the name and phone are set.
 * - `signed-in`: the app itself.
 * - `unreachable`: the launch check got no answer. The saved token is kept, and Try again calls `check`.
 *   A refused token goes to `signed-out` even when the phone's storage fails (#155, S3).
 */
export type SessionState =
  | { status: "checking" | "unreachable" }
  | { status: "signed-out"; notCleared?: true }
  | { status: "profile-needed" | "signed-in"; account: Account };

/** The calls the session makes: the app's own client. */
interface SessionApi {
  me(): Promise<ApiResult<Account>>;
  signOut(): Promise<void>;
}

const byAccount = (account: Account): SessionState =>
  account.name && account.phone ? { status: "signed-in", account } : { status: "profile-needed", account };

// The newest session's hold on `showSignedOut`.
let stopLast = () => {};

/**
 * One per app, beside its client: `createSession(api)`. A new one takes
 * `showSignedOut` from the last, so Fast Refresh and tests never pile up
 * listeners.
 */
export function createSession(api: SessionApi) {
  let state: SessionState = { status: "checking" };
  const changed = listeners();
  // Each change bumps it, so a launch check that answers after a sign-in or a sign-out is dropped.
  let turn = 0;

  function move(next: SessionState) {
    turn++;
    state = next;
    changed.notify();
  }

  stopLast();
  stopLast = onSignedOut(() => move({ status: "signed-out" }));

  return {
    get: () => state,

    subscribe: changed.add,

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
     * called (#161). Resolves false, and marks the state `notCleared`, when
     * the phone's storage could not be cleared; the token is never used
     * again (#155, S3). A sign-in that lands meanwhile is kept.
     */
    async signOut(): Promise<boolean> {
      const mine = turn;
      let cleared = true;
      try {
        await api.signOut();
      } catch {
        cleared = false;
      }
      // A failed clear signals the sign-out itself before it rejects, so
      // signed-out still takes the mark; a sign-in that landed is kept.
      if (mine === turn || state.status === "signed-out") {
        move(cleared ? { status: "signed-out" } : { status: "signed-out", notCleared: true });
      }
      return cleared;
    },
  };
}

// Not `Session`: @ygo/contracts uses that name for the token pair.
export type AppSession = ReturnType<typeof createSession>;

/** The current state; the screen re-renders when it changes. */
export function useSession(session: AppSession): SessionState {
  return useSyncExternalStore(session.subscribe, session.get);
}
