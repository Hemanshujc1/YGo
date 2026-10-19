// Once the server refuses this version, every later call is refused too, so
// the update screen stays until the app restarts.
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
