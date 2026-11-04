import type { Notification } from "@ygo/contracts";
import { Button, Text, useInFront } from "@ygo/mobile";
import { NotificationRow } from "@ygo/mobile/notification-parts";
import { Link, router } from "expo-router";
import { useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { inbox as list } from "../lib/inbox";
import { strings } from "../strings";

// S41 Shop notifications (#507): the server's newest 50, already sorted into the Owner's and the Staff's kinds; a tap
// reads one and opens its order on S05 (owner's answers 5 and 14 on #55).

const words = strings.notifications;

export default function NotificationsScreen() {
  const insets = useSafeAreaInsets();
  const view = useSyncExternalStore(list.subscribe, list.get);
  useInFront(list);
  const rows = view.notifications;

  const open = (row: Notification) => {
    if (!row.read) list.read(row.id);
    if (row.orderId) router.push({ pathname: "/orders/[id]", params: { id: row.orderId } });
  };

  return (
    <ScrollView
      className="flex-1 bg-bg"
      contentContainerClassName="gap-2.5 px-4"
      contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 32 }}
      refreshControl={<RefreshControl refreshing={view.refreshing} onRefresh={() => void list.refresh()} progressViewOffset={insets.top} />}
    >
      <View className="flex-row items-center justify-between gap-3">
        <Link href="/" asChild><Pressable accessibilityRole="button" className="py-3"><Text className="text-body text-primary">{words.back}</Text></Pressable></Link>
        {view.unread && rows && <Button label={words.readAll} onPress={() => void list.readAll()} variant="text" />}
      </View>
      <Text accessibilityRole="header" className="text-title-large font-semibold text-text">{words.title}</Text>
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
      {rows?.map((row) => <NotificationRow key={row.id} row={row} newWord={words.new} onPress={() => open(row)} />)}
    </ScrollView>
  );
}
