import { Button, Text, useInFront } from "@ygo/mobile";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../api";
import { OrderRow } from "../components/order-row";
import { deliveryCache, openDelivery } from "../lib/delivery-cache";
import { attentionCount } from "../lib/delivery-store";
import { stockSync } from "../lib/stock-sync";
import { createShopOrders } from "../lib/shop-orders";
import { strings } from "../strings";

const words = strings.orders;
export default function DeliveriesScreen() {
  const insets = useSafeAreaInsets();
  const [orders] = useState(() => createShopOrders(api, undefined, undefined, undefined, deliveryCache));
  const view = useSyncExternalStore(orders.subscribe, orders.get);
  useInFront(orders);
  const shown = view.orders;
  // Work waiting or refused on this phone changes as the sync runs.
  const sync = useSyncExternalStore(stockSync.subscribe, stockSync.get);
  const [refused, setRefused] = useState<string[]>([]);
  useEffect(() => {
    let gone = false;
    void openDelivery().then((open) => { if (!gone) setRefused(open?.queue.deliveries.refusedIds() ?? []); }).catch(() => undefined);
    return () => { gone = true; };
  }, [sync.running, sync.outcome, view.orders]);
  // The server's flags come from a fresh read; offline, from the encrypted copy.
  const list = shown?.canDeliver ? shown.myDeliveries : view.cached ?? [];
  const attention = attentionCount(shown?.offlineDeliveryIssueCount ?? 0, list.filter((order) => order.offlineDeliveryIssue).map((order) => order.id), refused);
  return <ScrollView className="flex-1 bg-bg" contentContainerClassName="gap-4 px-4" contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 32 }} refreshControl={<RefreshControl refreshing={view.refreshing} onRefresh={() => void orders.refresh()} progressViewOffset={insets.top} />}>
    <Text accessibilityRole="header" className="text-title-large font-semibold text-text">{words.groups.myDeliveries}</Text>
    {view.status === "loading" && <View className="min-h-12 flex-row items-center gap-2"><ActivityIndicator className="text-primary"/><Text className="text-body text-muted">{words.loading}</Text></View>}
    {view.message && <Text accessibilityLiveRegion="polite" className="text-body text-danger">{view.message}</Text>}
    {view.status === "failed" && <Button label={words.retry} variant="secondary" onPress={() => void orders.retry()} />}
    {attention > 0 && <Text accessibilityLiveRegion="polite" className="text-body font-semibold text-danger">{words.needsAttentionCount(attention)}</Text>}
    {!shown && view.cached && <Text className="text-secondary text-muted">{words.cachedOrder}</Text>}
    {(shown?.canDeliver || (!shown && view.cached)) && list.map((order) => <OrderRow key={order.id} order={order} chip attention={order.offlineDeliveryIssue || refused.includes(order.id)} />)}
    {((shown?.canDeliver && list.length === 0) || (!shown && view.cached?.length === 0)) && <Text className="text-body text-muted">{words.noDeliveries}</Text>}
    {shown && !shown.canDeliver && <Text className="text-body text-danger">{strings.errors.FORBIDDEN}</Text>}
  </ScrollView>;
}
