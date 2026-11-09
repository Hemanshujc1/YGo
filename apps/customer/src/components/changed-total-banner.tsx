import { Text } from "@ygo/mobile";
import { router, useSegments } from "expo-router";
import { useEffect, useSyncExternalStore } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { changedTotalBanner } from "../lib/changed-total-banner";
import { money } from "../lib/money";
import { strings } from "../strings";
import { ExpiryCountdown } from "./countdown";

const words = strings.order.changedTotalBanner;

export function ChangedTotalBanner() {
  const insets = useSafeAreaInsets();
  const segments = useSegments();
  const view = useSyncExternalStore(changedTotalBanner.subscribe, changedTotalBanner.get);

  useEffect(() => {
    changedTotalBanner.start();
    return () => changedTotalBanner.stop();
  }, []);

  const isOrderDetail = segments[0] === "order";
  const order = view.order;

  if (isOrderDetail || !order) return null;

  return (
    <View style={{ paddingTop: insets.top }} className="border-b border-warning bg-warning-subtle">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${words.title}: ${words.totalChangedTo(money(order.total))}`}
        onPress={() => router.navigate({ pathname: "/order/[id]", params: { id: order.id } })}
        className="flex-row items-center justify-between gap-3 px-4 py-2.5 active:opacity-80"
      >
        <View className="flex-1 gap-0.5">
          <Text className="text-secondary font-semibold text-warning-text">{words.title}</Text>
          <Text className="text-body font-bold tabular-nums text-text">
            {words.totalChangedTo(money(order.total))}
          </Text>
        </View>
        <View className="flex-row items-center gap-2">
          <ExpiryCountdown confirmByAt={order.confirmByAt} />
          <Text className="text-body font-semibold text-primary">{words.review}</Text>
        </View>
      </Pressable>
    </View>
  );
}

