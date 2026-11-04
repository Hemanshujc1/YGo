import type { ApiResult } from "@ygo/api-client";
import type { ErrorCode, Notification, NotificationsResponse } from "@ygo/contracts";

export type NotificationsView = {
  status: "loading" | "ready" | "failed";
  notifications: Notification[] | null;
  /** The Home bell's dot: a shown row is unread, or one beyond the 50 shown is. */
  unread: boolean;
  /** Why the list couldn't be read, or why Mark all as read failed. */
  message: string | null;
  /** A pull to refresh is on its way. */
  refreshing: boolean;
};

type Client = {
  notifications(): Promise<ApiResult<NotificationsResponse>>;
  readNotification(id: string): Promise<ApiResult<undefined>>;
  readAllNotifications(): Promise<ApiResult<undefined>>;
};

/** Each app's own words for what went wrong. */
export type NotificationsWords = { offline: string; errors: Record<ErrorCode, string>; readAllFailed: string };

/**
 * C22 or S41 and the Home bell (#506, #507), one store for both, so a row read on C22 is read on the bell too. It reads the list
 * each time either screen comes to the front, and again when a push arrives while one is. A tapped row shows as read
 * at once and is marked on the server behind it; one that fails to save shows "New" again at the next read (owner's
 * answer 8 on #506). Rows read here stay read over an answer that left before the server marked them.
 */
export function createNotifications(client: Client, words: NotificationsWords) {
  const blank: NotificationsView = { status: "loading", notifications: null, unread: false, message: null, refreshing: false };
  let view = blank;
  // An unread row the server has beyond the 50 shown, which lights the bell all the same.
  let unreadBeyond = false;
  const readHere = new Set<string>();
  // While Mark all as read is on its way, an answer's unread flag is out of date.
  let readingAll = false;
  // How many screens are in front: Home's bell and C22 hand over as one opens over the other.
  let inFront = 0;
  let ticket = 0;
  const listeners = new Set<() => void>();

  const set = (next: Partial<NotificationsView>) => {
    const rows = next.notifications ?? view.notifications;
    view = { ...view, ...next, unread: unreadBeyond || (rows?.some((row) => !row.read) ?? false) };
    for (const listener of listeners) listener();
  };

  const shown = (rows: Notification[]) => rows.map((row) => (readHere.has(row.id) ? { ...row, read: true } : row));

  async function read(pull = false) {
    const mine = ++ticket;
    if (pull) set({ refreshing: true });
    else if (!view.notifications) set({ status: "loading", message: null });
    const answer = await client.notifications().catch(() => "offline" as const);
    if (mine !== ticket) return;
    if (answer !== "offline" && answer.ok) {
      // Judged on the server's own rows: a row read here meanwhile is still unread in its answer.
      unreadBeyond = !readingAll && answer.data.unread && answer.data.notifications.every((row) => row.read);
      set({ status: "ready", notifications: shown(answer.data.notifications), message: null, refreshing: false });
    } else {
      const message = answer === "offline" ? words.offline : words.errors[answer.code];
      set({ status: view.notifications ? "ready" : "failed", message, refreshing: false });
    }
  }

  return {
    get: () => view,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** A screen came to the front: read now. */
    start() {
      inFront++;
      void read();
    },
    /** A screen closed or the app went to the background. */
    stop() {
      inFront = Math.max(0, inFront - 1);
    },
    /** A push arrived while the app is open: read again if a screen is in front. */
    pushed() {
      if (inFront > 0) void read();
    },
    /** Another account signed in: nothing of the last one stays. */
    reset() {
      ticket++;
      readHere.clear();
      unreadBeyond = false;
      readingAll = false;
      view = blank;
      for (const listener of listeners) listener();
    },
    /** Pull to refresh. */
    refresh: () => read(true),
    /** Try again after a failed read. */
    retry: () => read(),
    /** A tapped unread row: read at once here, marked on the server behind it. */
    read(id: string) {
      readHere.add(id);
      if (view.notifications) set({ notifications: shown(view.notifications) });
      void client.readNotification(id).then(
        (answer) => {
          if (!answer.ok) readHere.delete(id);
          // The last shown unread row: only the server knows whether older ones beyond the 50 are unread.
          else if (!view.unread) void read();
        },
        () => readHere.delete(id),
      );
    },
    /** "Mark all as read": the rows show read at once, and come back with a message if the server refuses. */
    async readAll() {
      const rows = view.notifications;
      if (!rows) return;
      const marked = rows.filter((row) => !row.read).map((row) => row.id);
      const beyond = unreadBeyond;
      for (const id of marked) readHere.add(id);
      unreadBeyond = false;
      readingAll = true;
      set({ notifications: shown(rows), message: null });
      const answer = await client.readAllNotifications().catch(() => null);
      readingAll = false;
      if (answer?.ok) return;
      // Only the rows this marked come back, on whatever list is shown now.
      for (const id of marked) readHere.delete(id);
      unreadBeyond ||= beyond;
      const now = view.notifications ?? [];
      set({ notifications: now.map((row) => (marked.includes(row.id) ? { ...row, read: false } : row)), message: words.readAllFailed });
    },
  };
}
