import { Button, Text, useInFront } from "@ygo/mobile";
import { useState, useSyncExternalStore } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../api";
import { OrderRow } from "../components/order-row";
import { createShopOrders } from "../lib/shop-orders";
import { strings } from "../strings";

const words = strings.orders;
export default function DeliveriesScreen() {
  const insets = useSafeAreaInsets();
  const [orders] = useState(() => createShopOrders(api));
  const view = useSyncExternalStore(orders.subscribe, orders.get);
  useInFront(orders);
  const shown = view.orders;
  return <ScrollView className="flex-1 bg-bg" contentContainerClassName="gap-4 px-4" contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 32 }} refreshControl={<RefreshControl refreshing={view.refreshing} onRefresh={() => void orders.refresh()} progressViewOffset={insets.top} />}>
    <Text accessibilityRole="header" className="text-title-large font-semibold text-text">{words.groups.myDeliveries}</Text>
    {view.status === "loading" && <View className="min-h-12 flex-row items-center gap-2"><ActivityIndicator className="text-primary"/><Text className="text-body text-muted">{words.loading}</Text></View>}
    {view.message && <Text accessibilityLiveRegion="polite" className="text-body text-danger">{view.message}</Text>}
    {view.status === "failed" && <Button label={words.retry} variant="secondary" onPress={() => void orders.retry()} />}
    {shown?.myDeliveries.map((order) => <OrderRow key={order.id} order={order} chip />)}
    {shown?.canDeliver && shown.myDeliveries.length === 0 && <Text className="text-body text-muted">{words.noDeliveries}</Text>}
    {shown && !shown.canDeliver && <Text className="text-body text-danger">{strings.errors.FORBIDDEN}</Text>}
  </ScrollView>;
}
