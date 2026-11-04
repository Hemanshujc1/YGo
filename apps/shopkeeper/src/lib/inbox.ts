import { createNotifications } from "@ygo/mobile/notifications";
import { api, session } from "../api";
import { strings } from "../strings";
import { push } from "./push";

/** The one S41 store, shared by the Home bell and S41 (#507), emptied whenever the signed-in account changes. */
export const inbox = createNotifications(api, { offline: strings.notifications.offline, errors: strings.errors, readAllFailed: strings.notifications.readAllFailed });

let shownFor: string | null = null;
session.subscribe(() => {
  const state = session.get();
  const accountId = "account" in state ? state.account.id : null;
  if (accountId !== shownFor) inbox.reset();
  shownFor = accountId;
});
push.onReceived(inbox.pushed);
