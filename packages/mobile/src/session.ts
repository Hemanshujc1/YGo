import type { ApiResult } from "@ygo/api-client";
import type { Account, SetThemeBody, ThemeChoice } from "@ygo/contracts";
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
  setTheme(body: SetThemeBody): Promise<ApiResult<Account>>;
  signOut(): Promise<void>;
}

/** The theme the app shows, and whether a choice is being saved. */
export type ThemeView = { choice: ThemeChoice; saving: boolean };

/** This phone's copy of the theme: `phoneTheme` in the apps. */
interface ThemeCopy {
  saved(): ThemeChoice;
  keep(choice: ThemeChoice): void;
}

const byAccount = (account: Account): SessionState =>
  account.name && account.phone ? { status: "signed-in", account } : { status: "profile-needed", account };

// The newest session's hold on `showSignedOut`.
let stopLast = () => {};

/**
 * One per app, beside its client: `createSession(api, phoneTheme)`. A new one
 * takes `showSignedOut` from the last, so Fast Refresh and tests never pile up
 * listeners. Each account the server answers sets the app's theme, since the
 * account's choice wins over the phone's copy (#195, Q2).
 */
export function createSession(api: SessionApi, theme: ThemeCopy) {
  let state: SessionState = { status: "checking" };
  const changed = listeners();
  // Each change bumps it, so a launch check that answers after a sign-in or a sign-out is dropped.
  let turn = 0;
  // The theme the app shows, and whether the picker's save is under way.
  let shown: ThemeView = { choice: theme.saved(), saving: false };
  // Each theme shown bumps it, so a failed save never puts its old theme over a newer one.
  let themeTurn = 0;
  let saving: Promise<boolean> | null = null;

  function show(next: ThemeView) {
    if (next.choice !== shown.choice) {
      themeTurn++;
      theme.keep(next.choice);
    }
    shown = next;
  }

  function move(next: SessionState) {
    if ("account" in next) show({ ...shown, choice: next.account.theme });
    turn++;
    state = next;
    changed.notify();
  }

  async function saveTheme(choice: ThemeChoice): Promise<boolean> {
    const before = shown.choice;
    show({ choice, saving: true });
    changed.notify();
    const mine = themeTurn;
    let saved = false;
    try {
      const answer = await api.setTheme({ theme: choice });
      if (answer.ok) {
        saved = true;
        // The newest account, theme included; an answer that landed meanwhile may hold the old one.
        if ("account" in state) state = { ...state, account: answer.data };
        show({ choice: answer.data.theme, saving: false });
      }
    } catch {
      // No answer: the same as a refusal.
    }
    if (!saved) show({ choice: mine === themeTurn ? before : shown.choice, saving: false });
    saving = null;
    changed.notify();
    return saved;
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

    /** The theme the app shows, for the picker. */
    theme: () => shown,

    /**
     * The theme picker: the app changes at once, then the account saves it.
     * Resolves false, with the old theme back, when the save fails; nothing
     * retries by itself (#195, Q3). One save runs at a time: a choice made
     * meanwhile gets the running save's answer.
     */
    chooseTheme(choice: ThemeChoice): Promise<boolean> {
      saving ??= saveTheme(choice);
      return saving;
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

/** The theme the app shows; the picker re-renders when it changes. */
export function useTheme(session: AppSession): ThemeView {
  return useSyncExternalStore(session.subscribe, session.theme);
}
