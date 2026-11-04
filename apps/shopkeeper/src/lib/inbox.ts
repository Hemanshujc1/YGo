import { createInbox } from "@ygo/mobile/notifications";
import { api, session } from "../api";
import { strings } from "../strings";
import { push } from "./push";

/** The one S41 store, shared by the Home bell and S41 (#507), emptied whenever the signed-in account changes. */
export const inbox = createInbox(api, { offline: strings.notifications.offline, errors: strings.errors, readAllFailed: strings.notifications.readAllFailed }, session, push.onReceived);
