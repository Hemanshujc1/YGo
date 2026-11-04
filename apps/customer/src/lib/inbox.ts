import { createInbox } from "@ygo/mobile/notifications";
import { api, session } from "../api";
import { strings } from "../strings";
import { push } from "./push";

/** The one C22 store, shared by the Home bell and C22 (#506), emptied whenever the signed-in account changes. */
export const inbox = createInbox(api, { offline: strings.area.offline, errors: strings.errors, readAllFailed: strings.notifications.readAllFailed }, session, push.onReceived);
