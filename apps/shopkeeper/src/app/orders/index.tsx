import type { ShopOrderSummary, ShopOrdersResponse } from "@ygo/contracts";
import { formatTime } from "@ygo/format";
import { Button, StatusChip, Text, useInFront } from "@ygo/mobile";
import { Link } from "expo-router";
import { useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../../api";
import { createShopOrders, money, treatments } from "../../lib/shop-orders";
import { strings } from "../../strings";

// S04 Orders (#431): New, Accepted and Done today, read every 15 s while in front.

const words = strings.orders;
const groups = ["new", "accepted", "doneToday"] as const satisfies ReadonlyArray<keyof ShopOrdersResponse>;

function Row({ order, chip }: { order: ShopOrderSummary; chip: boolean }) {
  return (
    <Link href={`/orders/${order.id}`} asChild>
      <Pressable accessibilityRole="button" className="gap-1 rounded-card border border-border bg-surface p-4 active:bg-primary-subtle">
        <View className="flex-row items-center justify-between gap-3">
          <Text className="text-body font-semibold text-text">{words.detailTitle(order.number)}</Text>
          <Text className="text-secondary tabular-nums text-muted">{formatTime(order.placedAt)}</Text>
        </View>
        <Text className="text-body tabular-nums text-text">{words.row(order.itemCount, money(order.total))}</Text>
        <Text className="text-secondary text-muted">{[order.address.flat, order.address.areaLine].filter(Boolean).join(", ")}</Text>
        {/* Done today mixes delivered, rejected, expired and cancelled orders (owner's answer 3 on #431). */}
        {chip && <StatusChip word={words.statuses[order.status]} treatment={treatments[order.status]} />}
      </Pressable>
    </Link>
  );
}

export default function OrdersScreen() {
  const insets = useSafeAreaInsets();
  const [orders] = useState(() => createShopOrders(api));
  const view = useSyncExternalStore(orders.subscribe, orders.get);
  useInFront(orders);
  const shown = view.orders;
  const none = shown && groups.every((group) => shown[group].length === 0);

  return (
    <ScrollView
      className="flex-1 bg-bg"
      contentContainerClassName="gap-4 px-4"
      contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 32 }}
      refreshControl={<RefreshControl refreshing={view.refreshing} onRefresh={() => void orders.refresh()} progressViewOffset={insets.top} />}
    >
      <Link href="/" className="py-3 text-body text-primary">{words.back}</Link>
      <Text accessibilityRole="header" className="text-title-large font-semibold text-text">{words.title}</Text>
      {view.status === "loading" && (
        <View className="min-h-12 flex-row items-center gap-2">
          <ActivityIndicator className="text-primary" />
          <Text className="text-body text-muted">{words.loading}</Text>
        </View>
      )}
      {view.message && <Text accessibilityLiveRegion="polite" className="text-body text-danger">{view.message}</Text>}
      {view.status === "failed" && <Button label={words.retry} variant="secondary" onPress={() => void orders.retry()} />}
      {none && <Text className="text-body text-muted">{words.empty}</Text>}
      {shown && groups.map((group) => shown[group].length > 0 && (
        <View key={group} className="gap-2.5">
          <Text accessibilityRole="header" className="text-title font-semibold text-text">{words.groups[group]}</Text>
          {shown[group].map((order) => <Row key={order.id} order={order} chip={group !== "new"} />)}
        </View>
      ))}
    </ScrollView>
  );
}
