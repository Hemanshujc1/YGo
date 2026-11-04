import type { Notification } from "@ygo/contracts";
import { Button, useInFront } from "@ygo/mobile";
import { NotificationList } from "@ygo/mobile/notification-parts";
import { router } from "expo-router";
import { useSyncExternalStore } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TopBar } from "../components/top-bar";
import { inbox as list } from "../lib/inbox";
import { strings } from "../strings";

// C22 Notifications (#506): the server's newest 50, a tap reads one and opens its order (owner's answers 5 and 14 on #55).

const words = strings.notifications;

export default function NotificationsScreen() {
  const insets = useSafeAreaInsets();
  const view = useSyncExternalStore(list.subscribe, list.get);
  useInFront(list);
  const rows = view.notifications;

  const open = (row: Notification) => {
    if (!row.read) list.read(row.id);
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
        <NotificationList view={view} list={list} words={words} onOpen={open} />
      </ScrollView>
    </View>
  );
}
