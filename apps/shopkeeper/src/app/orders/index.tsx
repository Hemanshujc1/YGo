import type { ShopOrdersResponse } from "@ygo/contracts";
import { Button, Text, useInFront } from "@ygo/mobile";
import { NotificationsBell } from "@ygo/mobile/notification-parts";
import { useState, useSyncExternalStore } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { access, api, session } from "../../api";
import { AlertPanel } from "../../components/alert-panel";
import { ExpiryCountdown } from "../../components/countdown";
import { OpenSwitch } from "../../components/open-switch";
import { OrderRow } from "../../components/order-row";
import { deliveryCache } from "../../lib/delivery-cache";
import { useAccountRole } from "../../lib/account-role";
import { inbox } from "../../lib/inbox";
import { createShopOrders } from "../../lib/shop-orders";
import { strings } from "../../strings";

// S04 Orders (#431): New, Accepted and Done today, read every 15 s while in front.

const words = strings.orders;
const groups = ["new", "accepted", "doneToday"] as const satisfies ReadonlyArray<keyof ShopOrdersResponse>;

export default function OrdersScreen() {
  const insets = useSafeAreaInsets();
  const [orders] = useState(() => createShopOrders(api, undefined, undefined, undefined, { saveList: deliveryCache.saveList }));
  const view = useSyncExternalStore(orders.subscribe, orders.get);
  useInFront(orders);
  const shown = view.orders;
  const owner = useAccountRole() === "owner";
  const identity = session.get();
  // The last answer the server gave, which names the state (the saved record only knows whether the shop answers orders).
  const state = "account" in identity ? access.answer(identity.account.id)?.state : undefined;
  const none = shown && groups.every((group) => shown[group].length === 0);

  return (
    <ScrollView
      className="flex-1 bg-bg"
      contentContainerClassName="gap-4 px-4"
      contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 32 }}
      refreshControl={<RefreshControl refreshing={view.refreshing} onRefresh={() => void orders.refresh()} progressViewOffset={insets.top} />}
    >
      {/* S41's bell, only where orders and their notifications arrive (owner's answer 6 on #507). */}
      <View className="flex-row justify-end"><NotificationsBell inbox={inbox} words={strings.notifications} /></View>
      {/* S03 (#507): where orders can arrive, so the alarm must ring. */}
      <AlertPanel />
      {owner && state === "live" && <OpenSwitch />}
      {state === "suspended" && <Text className="text-body text-danger">{strings.stock.suspended}</Text>}
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
          {shown[group].map((order) => (
            <OrderRow key={order.id} order={order} chip={group !== "new"}>
              {order.status === "awaiting_customer_confirm" && order.confirmByAt && (
                <ExpiryCountdown expiresAt={order.confirmByAt} offset={view.offset} />
              )}
            </OrderRow>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}
