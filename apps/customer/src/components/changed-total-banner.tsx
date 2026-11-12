import { Text } from "@ygo/mobile";
import { router, useSegments } from "expo-router";
import { type ReactNode, useEffect, useSyncExternalStore } from "react";
import { Pressable, View } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { type AwaitingOrder, changedTotalBanner } from "../lib/changed-total-banner";
import { money } from "../lib/money";
import { strings } from "../strings";
import { ExpiryCountdown } from "./countdown";

const words = strings.order.changedTotalBanner;

/**
 * The banner above `children` (the app's screens). While it shows it covers the status bar, so the screens below see no top inset
 * and don't pad for it a second time (#578).
 */
export function ChangedTotalBanner({ children }: { children?: ReactNode }) {
  const insets = useSafeAreaInsets();
  const segments = useSegments();
  const view = useSyncExternalStore(changedTotalBanner.subscribe, changedTotalBanner.get);

  useEffect(() => {
    changedTotalBanner.start();
    return () => changedTotalBanner.stop();
  }, []);

  const order = segments[0] === "order" ? null : view.order;
  // One tree either way, so the screens below keep their state when the banner comes and goes.
  return (
    <>
      {order && <Banner order={order} top={insets.top} />}
      <SafeAreaInsetsContext.Provider value={order ? { ...insets, top: 0 } : insets}>{children}</SafeAreaInsetsContext.Provider>
    </>
  );
}

function Banner({ order, top }: { order: AwaitingOrder; top: number }) {
  return (
    <View style={{ paddingTop: top }} className="border-b border-warning bg-warning-subtle">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${words.title}: ${words.totalChangedTo(money(order.proposedTotal))}`}
        onPress={() => router.navigate({ pathname: "/order/[id]", params: { id: order.id } })}
        className="flex-row items-center justify-between gap-3 px-4 py-2.5 active:opacity-80"
      >
        <View className="flex-1 min-w-0 gap-0.5">
          <Text numberOfLines={1} className="text-secondary font-semibold text-warning-text">{words.title}</Text>
          <Text className="text-body font-bold tabular-nums text-text">
            {words.totalChangedTo(money(order.proposedTotal))}
          </Text>
        </View>
        <View className="shrink-0 flex-row items-center gap-2">
          <ExpiryCountdown confirmByAt={order.confirmByAt} />
          <Text className="text-body font-semibold text-primary">{words.review}</Text>
        </View>
      </Pressable>
    </View>
  );
}

