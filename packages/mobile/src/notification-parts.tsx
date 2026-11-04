import type { Notification } from "@ygo/contracts";
import { formatDateTime } from "@ygo/format";
import { Link } from "expo-router";
import { Bell } from "lucide-react-native";
import { useSyncExternalStore } from "react";
import { Pressable, View } from "react-native";
import { colourIcons } from "./icons";
import { useInFront } from "./in-front";
import type { createNotifications } from "./notifications";
import { Text } from "./text";

colourIcons(Bell);

/**
 * One row of C22 or S41 (#506, #507): an icon, the fact in bold, the time, and the app's "New" while unread, as a tint
 * alone is never enough (design system, Notification row).
 */
export function NotificationRow({ row, newWord, onPress }: { row: Notification; newWord: string; onPress(): void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      className={`flex-row gap-3 rounded-card border bg-surface p-4 active:bg-primary-subtle ${row.read ? "border-border" : "border-primary"}`}
    >
      <Bell className={row.read ? "text-muted" : "text-primary"} size={20} />
      <View className="flex-1 gap-1">
        <View className="flex-row items-start justify-between gap-3">
          <Text className={`flex-1 text-body text-text ${row.read ? "font-medium" : "font-semibold"}`}>{row.title}</Text>
          {!row.read && <Text className="text-label font-semibold text-primary">{newWord}</Text>}
        </View>
        <Text className="text-secondary text-text">{row.body}</Text>
        <Text className="text-secondary tabular-nums text-muted">{formatDateTime(row.createdAt)}</Text>
      </View>
    </Pressable>
  );
}

/**
 * The Home bell, the way into C22 or S41 (#506, #507), with a dot while anything is unread; read each time Home comes
 * to the front and when a push arrives.
 */
export function NotificationsBell({ inbox, words }: { inbox: ReturnType<typeof createNotifications>; words: { open: string; unread: string } }) {
  const { unread } = useSyncExternalStore(inbox.subscribe, inbox.get);
  useInFront(inbox);
  return (
    <Link href="/notifications" asChild>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={unread ? words.unread : words.open}
        className="size-12 items-center justify-center rounded-full active:bg-primary-subtle"
      >
        <Bell className="text-text" />
        {unread && <View className="absolute right-3 top-3 size-2.5 rounded-full bg-accent" />}
      </Pressable>
    </Link>
  );
}
