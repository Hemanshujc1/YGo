import { listeners } from "./listeners";

// Once set, the update screen stays until the app restarts (owner decision on
// #137), even if the server later lowers its minimum. A reload in Metro clears it.
let required = false;
const changed = listeners();

/** Pass to `createApiClient` as `onUpdateRequired`: any refused call shows the update screen. */
export function showUpdateRequired() {
  if (required) return;
  required = true;
  changed.notify();
}

export const subscribe = changed.add;

export function isUpdateRequired() {
  return required;
}
