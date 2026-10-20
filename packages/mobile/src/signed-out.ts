import { listeners } from "./listeners";

// The session ended without a sign-out: the server refused the token, or the
// phone could not clear it. An event, not a latch: a later sign-in starts anew.
const ended = listeners();

/** Pass to `createApiClient` as `onSignedOut`: the app goes back to C01 (#155, Q5). */
export const showSignedOut = ended.notify;

export const onSignedOut = ended.add;
