import type { OrderSummary } from "@ygo/contracts";
import { formatDateTime } from "@ygo/format";
import { Button, StatusChip, Text, useInFront } from "@ygo/mobile";
import { Link } from "expo-router";
import { useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../api";
import { TopBar } from "../components/top-bar";
import { money } from "../lib/money";
import { shownStatus, treatments } from "../lib/order";
import { createOrders } from "../lib/orders";
import { strings } from "../strings";

// C18 Order list (#426): active orders first, each opening C19 with the shop's phone carried in (ORD-8).

const words = strings.orders;

function Row({ order }: { order: OrderSummary }) {
  const status = shownStatus(order);
  return (
    <Link href={{ pathname: "/order/[id]", params: { id: order.id, ...(order.shop.phone && { phone: order.shop.phone }) } }} asChild>
      <Pressable accessibilityRole="button" className="gap-1 rounded-card border border-border bg-surface p-4 active:bg-primary-subtle">
        <View className="flex-row items-center justify-between gap-3">
          <Text className="flex-1 text-body font-semibold text-text">{order.shop.name}</Text>
          <Text className="text-label font-semibold tabular-nums text-text">{money(order.total)}</Text>
        </View>
        <Text className="text-secondary tabular-nums text-muted">{`${strings.order.title(order.number)} · ${formatDateTime(order.placedAt)}`}</Text>
        <StatusChip word={strings.order.statuses[status]} treatment={treatments[status]} />
      </Pressable>
    </Link>
  );
}

export default function OrdersScreen() {
  const insets = useSafeAreaInsets();
  const [orders] = useState(() => createOrders(api));
  const view = useSyncExternalStore(orders.subscribe, orders.get);
  useInFront(orders);
  const shown = view.orders;
  const groups = shown ? ([["active", shown.active], ["past", shown.past]] as const) : [];

  return (
    <View className="flex-1 bg-bg" style={{ paddingTop: insets.top }}>
      <TopBar title={words.title} />
      <ScrollView
        contentContainerClassName="gap-4 px-4"
        contentContainerStyle={{ paddingTop: 8, paddingBottom: insets.bottom + 32 }}
        refreshControl={<RefreshControl refreshing={view.refreshing} onRefresh={() => void orders.refresh()} />}
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
            <Button label={words.retry} onPress={() => void orders.retry()} variant="text" />
          </View>
        )}
        {view.status === "ready" && view.message && <Text accessibilityLiveRegion="polite" className="text-secondary text-danger">{view.message}</Text>}
        {shown && shown.active.length === 0 && shown.past.length === 0 && <Text className="text-body text-muted">{words.empty}</Text>}
        {groups.map(([group, rows]) => rows.length > 0 && (
          <View key={group} className="gap-2.5">
            <Text accessibilityRole="header" className="text-title font-semibold text-text">{words[group]}</Text>
            {rows.map((order) => <Row key={order.id} order={order} />)}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
