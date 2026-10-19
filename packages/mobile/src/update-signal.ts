// Once set, the update screen stays until the app restarts (owner decision on
// #137), even if the server later lowers its minimum. A reload in Metro clears it.
let required = false;
const listeners = new Set<() => void>();

/** Pass to `createApiClient` as `onUpdateRequired`: any refused call shows the update screen. */
export function showUpdateRequired() {
  if (required) return;
  required = true;
  listeners.forEach((listener) => listener());
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function isUpdateRequired() {
  return required;
}
