import { api, session } from "../api";
import { createNotifications } from "./notifications";
import { push } from "./push";

/** The one C22 store, shared by the Home bell and C22 (#506), emptied whenever the signed-in account changes. */
export const inbox = createNotifications(api);

let shownFor: string | null = null;
session.subscribe(() => {
  const state = session.get();
  const accountId = "account" in state ? state.account.id : null;
  if (accountId !== shownFor) inbox.reset();
  shownFor = accountId;
});
push.onReceived(inbox.pushed);
