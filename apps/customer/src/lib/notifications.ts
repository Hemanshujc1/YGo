import type { ApiResult } from "@ygo/api-client";
import type { Notification, NotificationsResponse } from "@ygo/contracts";
import { strings } from "../strings";

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

/**
 * C22 and the Home bell (#506): reads the list each time its screen comes to the front, and again when a push
 * arrives while it is. A tapped row shows as read at once and is marked on the server behind it; one that fails to
 * save shows "New" again at the next read (owner's answer 8 on #506).
 */
export function createNotifications(client: Client) {
  let view: NotificationsView = { status: "loading", notifications: null, unread: false, message: null, refreshing: false };
  // An unread row the server has beyond the 50 shown, which lights the bell all the same.
  let unreadBeyond = false;
  // Rows read here, kept read over an answer that left before the server marked them.
  const readHere = new Set<string>();
  let running = false;
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
      unreadBeyond = answer.data.unread && answer.data.notifications.every((row) => row.read);
      set({ status: "ready", notifications: shown(answer.data.notifications), message: null, refreshing: false });
    } else {
      const message = answer === "offline" ? strings.area.offline : strings.errors[answer.code];
      set({ status: view.notifications ? "ready" : "failed", message, refreshing: false });
    }
  }

  return {
    get: () => view,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** The screen is in front: read now. */
    start() {
      running = true;
      void read();
    },
    /** The screen closed or the app went to the background. */
    stop() {
      running = false;
    },
    /** A push arrived while the app is open: read again if the screen is in front. */
    pushed() {
      if (running) void read();
    },
    /** Pull to refresh. */
    refresh: () => read(true),
    /** Try again after a failed read. */
    retry: () => read(),
    /** A tapped row: read at once here, marked on the server behind it. */
    read(id: string) {
      readHere.add(id);
      if (view.notifications) set({ notifications: shown(view.notifications) });
      void client.readNotification(id).then((answer) => answer.ok || readHere.delete(id), () => readHere.delete(id));
    },
    /** "Mark all as read": the rows show read at once, and come back with a message if the server refuses. */
    async readAll() {
      const before = view.notifications;
      if (!before) return;
      const beyond = unreadBeyond;
      ticket++;
      unreadBeyond = false;
      set({ notifications: before.map((row) => ({ ...row, read: true })), message: null, refreshing: false });
      const answer = await client.readAllNotifications().catch(() => null);
      if (answer?.ok) for (const row of before) readHere.add(row.id);
      else {
        unreadBeyond = beyond;
        set({ notifications: shown(before), message: strings.notifications.readAllFailed });
      }
    },
  };
}
