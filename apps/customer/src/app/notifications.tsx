import type { Notification } from "@ygo/contracts";
import { formatDateTime } from "@ygo/format";
import { Button, Text, useInFront } from "@ygo/mobile";
import { router } from "expo-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../api";
import { Bell } from "../components/icons";
import { TopBar } from "../components/top-bar";
import { createNotifications } from "../lib/notifications";
import { push } from "../lib/push";
import { strings } from "../strings";

// C22 Notifications (#506): the server's newest 50, a tap reads one and opens its order (owner's answers 5 and 14 on #55).

const words = strings.notifications;

/** An icon, the fact in bold, the time, and "New" while unread: a tint alone is never enough (design system, Notification row). */
function Row({ row, onPress }: { row: Notification; onPress(): void }) {
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
          {!row.read && <Text className="text-label font-semibold text-primary">{words.new}</Text>}
        </View>
        <Text className="text-secondary text-text">{row.body}</Text>
        <Text className="text-secondary tabular-nums text-muted">{formatDateTime(row.createdAt)}</Text>
      </View>
    </Pressable>
  );
}

export default function NotificationsScreen() {
  const insets = useSafeAreaInsets();
  const [list] = useState(() => createNotifications(api));
  const view = useSyncExternalStore(list.subscribe, list.get);
  useInFront(list);
  useEffect(() => push.onReceived(list.pushed), [list]);
  const rows = view.notifications;

  const open = (row: Notification) => {
    list.read(row.id);
    if (row.orderId) router.push({ pathname: "/order/[id]", params: { id: row.orderId } });
  };

  return (
    <View className="flex-1 bg-bg" style={{ paddingTop: insets.top }}>
      <TopBar
        title={words.title}
        action={view.unread && rows ? <Button label={words.readAll} onPress={() => void list.readAll()} variant="text" /> : undefined}
      />
      <ScrollView
        contentContainerClassName="gap-2.5 px-4 pt-2"
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
        refreshControl={<RefreshControl refreshing={view.refreshing} onRefresh={() => void list.refresh()} />}
      >
        {view.status === "loading" && (
          <View className="min-h-12 flex-row items-center gap-2">
            <ActivityIndicator className="text-primary" />
            <Text className="text-body text-muted">{words.loading}</Text>
          </View>
        )}
        {view.status === "failed" && (
          <View className="items-start">
            <Text className="text-body font-semibold text-text">{words.failed}</Text>
            <Text className="text-secondary text-muted">{view.message}</Text>
            <Button label={words.retry} onPress={() => void list.retry()} variant="text" />
          </View>
        )}
        {view.status === "ready" && view.message && <Text accessibilityLiveRegion="polite" className="text-secondary text-danger">{view.message}</Text>}
        {rows?.length === 0 && <Text className="text-body text-muted">{words.empty}</Text>}
        {rows?.map((row) => <Row key={row.id} row={row} onPress={() => open(row)} />)}
      </ScrollView>
    </View>
  );
}
