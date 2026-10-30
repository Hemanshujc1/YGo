import type { OrderLine, OrderResponse } from "@ygo/contracts";
import { formatTime } from "@ygo/format";
import { Button, Confirm, StatusChip, Text } from "@ygo/mobile";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Linking, Pressable, RefreshControl, ScrollView, View } from "react-native";
import Animated, { Easing, useAnimatedProps, useReducedMotion, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Path } from "react-native-svg";
import { Phone } from "../../components/icons";
import { QuoteRows } from "../../components/quote-rows";
import { TopBar } from "../../components/top-bar";
import { money } from "../../lib/money";
import { treatments } from "../../lib/order";
import { addressLine } from "../../lib/saved-addresses";
import { packLabel } from "../../lib/shop-page";
import { useOrder } from "../../lib/use-order";
import { strings } from "../../strings";

// C09 Order waiting for shop and C19 Order detail (#427): one screen, C09 while the order is placed.
// Call the shop is in every state; Cancel is free until the shop answers (ORD-5, ORD-8).

const words = strings.order;

const AnimatedPath = Animated.createAnimatedComponent(Path);
/** The check's path length, so the dash draws it from start to end. */
const TICK = 34;

/** "Order placed": one check mark drawing in a ring over 400 ms, the app's only celebration (design system section 4). */
function PlacedMark() {
  const still = useReducedMotion();
  const drawn = useSharedValue(still ? 1 : 0);
  useEffect(() => {
    if (!still) drawn.value = withTiming(1, { duration: 400, easing: Easing.out(Easing.cubic) });
  }, [drawn, still]);
  const tick = useAnimatedProps(() => ({ strokeDashoffset: TICK * (1 - drawn.value) }));
  return (
    <View accessible accessibilityLabel={words.placed} className="flex-row items-center gap-3">
      <Svg width={48} height={48} viewBox="0 0 48 48" className="text-success">
        <Circle cx={24} cy={24} r={22} stroke="currentColor" strokeWidth={3} fill="none" />
        <AnimatedPath d="M14 25 L21 32 L34 18" stroke="currentColor" strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" fill="none" strokeDasharray={TICK} animatedProps={tick} />
      </Svg>
      <Text className="text-title font-semibold text-text">{words.placed}</Text>
    </View>
  );
}

/** "Aashirvaad · 2 × 5 kg", or "500 g of a 1 kg pack" for the part of a pack bought (#377). */
const lineLabel = (line: OrderLine) => {
  const pack = packLabel(line.quantity, line.baseUnit);
  return [line.brand, line.part ? words.part(packLabel(line.part, line.baseUnit), pack) : `${line.count} × ${pack}`].filter(Boolean).join(" · ");
};

const call = (phone: string) => void Linking.openURL(`tel:${phone}`);

/** Call the shop, or why there is none: an Owner may have no phone number (owner's answer 10 on #427). */
function CallShop({ phone }: { phone: string | null }) {
  if (!phone) return <Text className="text-secondary text-muted">{words.noPhone}</Text>;
  return <Button label={words.call} icon={Phone} variant="secondary" onPress={() => call(phone)} />;
}

function Detail({ order, placed }: { order: OrderResponse; placed: boolean }) {
  const quote = { productValue: order.productValue, deliveryFee: order.deliveryFee, smallCartFee: order.smallCartFee, total: order.total };
  return (
    <View className="gap-4">
      {placed && order.status === "placed" && <PlacedMark />}
      <View className="gap-2">
        <StatusChip word={words.statuses[order.status]} treatment={treatments[order.status]} />
        <Text className="text-secondary tabular-nums text-muted">{`${order.shop.name} · ${formatTime(order.placedAt)}`}</Text>
        {order.status === "placed" && <Text className="text-body text-text">{words.waiting}</Text>}
        {order.rejectReason && <Text className="text-body text-text">{words.rejectedBecause(words.rejectReasons[order.rejectReason])}</Text>}
      </View>

      <View className="rounded-card border border-border bg-surface px-4">
        {order.lines.map((line, index) => (
          <View key={index} className={`flex-row gap-3 py-3 ${index > 0 ? "border-t border-border" : ""}`}>
            <View className="flex-1">
              <Text className="text-body font-semibold text-text">{line.name}</Text>
              <Text className="text-secondary tabular-nums text-muted">{lineLabel(line)}</Text>
            </View>
            <Text className="text-label font-semibold tabular-nums text-text">{money(line.lineTotal)}</Text>
          </View>
        ))}
      </View>

      <QuoteRows quote={quote}>
        <Text className="mt-2 text-secondary text-muted">{words.pay}</Text>
      </QuoteRows>

      <View>
        <Text className="text-secondary text-muted">{words.deliverTo}</Text>
        <Text className="text-body text-text">{`${strings.confirm[order.address.label]} · ${addressLine(order.address)}`}</Text>
      </View>
    </View>
  );
}

export default function OrderScreen() {
  const insets = useSafeAreaInsets();
  // `phone` comes with a link from a list of orders, so Call the shop shows while the order loads or fails (#52 answer 13).
  const { id, placed, phone: carried } = useLocalSearchParams<{ id: string; placed?: string; phone?: string }>();
  const { order, view } = useOrder(id ?? "");
  const [asking, setAsking] = useState(false);
  const shown = view.order;
  // Unknown until the order is read, when no phone came with the link.
  const phone = shown ? shown.shop.phone : carried || undefined;

  return (
    <View className="flex-1 bg-bg" style={{ paddingTop: insets.top }}>
      <TopBar
        title={shown ? words.title(shown.number) : words.titleLoading}
        action={phone && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={words.call}
            onPress={() => call(phone)}
            className="size-12 items-center justify-center rounded-full active:bg-primary-subtle"
          >
            <Phone className="text-primary" />
          </Pressable>
        )}
      />
      <ScrollView
        contentContainerClassName="gap-4 px-4"
        contentContainerStyle={{ paddingTop: 8, paddingBottom: insets.bottom + 32 }}
        refreshControl={<RefreshControl refreshing={view.refreshing} onRefresh={() => void order.refresh()} />}
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
            <Button label={words.retry} onPress={() => void order.retry()} variant="text" />
          </View>
        )}
        {shown && <Detail order={shown} placed={placed === "1"} />}

        {phone !== undefined && (
          <View className="gap-2.5">
            <CallShop phone={phone} />
            {shown?.status === "placed" && (
              <Button label={view.cancelling ? words.cancelling : words.cancel} busy={view.cancelling} onPress={() => setAsking(true)} variant="text" />
            )}
            {view.notice && <Text accessibilityLiveRegion="polite" className="text-secondary text-text">{view.notice}</Text>}
          </View>
        )}
      </ScrollView>
      <Confirm
        visible={asking}
        title={words.cancelTitle}
        body={words.cancelBody}
        confirm={words.cancel}
        cancel={words.keep}
        onConfirm={() => {
          setAsking(false);
          void order.cancel();
        }}
        onCancel={() => setAsking(false)}
      />
    </View>
  );
}
