/** A set of change listeners: `add` answers its own unsubscribe. */
export function listeners() {
  const set = new Set<() => void>();
  return {
    add(listener: () => void) {
      set.add(listener);
      return () => void set.delete(listener);
    },
    notify: () => set.forEach((listener) => listener()),
  };
}
