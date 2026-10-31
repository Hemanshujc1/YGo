import { RejectReason, type ShopOrderResponse } from "@ygo/contracts";
import { formatTime } from "@ygo/format";
import { Button, StatusChip, Text, useInFront } from "@ygo/mobile";
import { Link, router, useLocalSearchParams } from "expo-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Modal, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../../api";
import { money } from "../../lib/money";
import { clock, createShopOrder, lineLabel, secondsLeft, shortLabel, treatments } from "../../lib/shop-orders";
import { strings } from "../../strings";

// S05 New order detail (#431): Accept is the biggest and lowest button; Reject asks for a reason first.

const words = strings.orders;

/** Seconds left by the server's clock, ticking once a second while the order is New, until it reaches 0. */
function useSecondsLeft(expiresAt: string | null, offset: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!expiresAt) return;
    setNow(Date.now());
    const tick = setInterval(() => {
      const phone = Date.now();
      setNow(phone);
      if (secondsLeft(expiresAt, offset, phone) === 0) clearInterval(tick);
    }, 1000);
    return () => clearInterval(tick);
  }, [expiresAt, offset]);
  return expiresAt ? secondsLeft(expiresAt, offset, now) : null;
}

/** 20/28 tabular in a bordered pill; under one minute a 2 px warning border, never flashing (design system section 5). */
function Countdown({ seconds }: { seconds: number }) {
  const low = seconds < 60;
  // Only "Time is up" is read out; a reading every second would drown the buttons.
  return (
    <View accessibilityLiveRegion={seconds === 0 ? "polite" : "none"} className={`self-start rounded-full px-4 py-1 ${low ? "border-2 border-warning" : "border border-border-strong"}`}>
      <Text className="text-title font-semibold tabular-nums text-text">{seconds > 0 ? words.expiresIn(clock(seconds)) : words.timeUp}</Text>
    </View>
  );
}

function Detail({ order }: { order: ShopOrderResponse }) {
  const { address } = order;
  return (
    <View className="gap-4">
      <View className="gap-2">
        <StatusChip word={words.statuses[order.status]} treatment={treatments[order.status]} />
        <Text className="text-secondary tabular-nums text-muted">{formatTime(order.placedAt)}</Text>
        {order.rejectReason && <Text className="text-body text-text">{words.rejectedBecause(words.reasons[order.rejectReason])}</Text>}
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
      <View className="rounded-card border border-border bg-surface p-4">
        <View className="flex-row items-center justify-between gap-3">
          <Text className="text-body font-semibold text-text">{words.collect}</Text>
          <Text className="text-title font-semibold tabular-nums text-text">{money(order.total)}</Text>
        </View>
        <Text className="mt-2 text-secondary text-muted">{words.collectNote}</Text>
      </View>
      <View>
        <Text className="text-secondary text-muted">{words.deliverTo}</Text>
        <Text selectable className="text-body text-text">
          {`${words.labels[address.label]} · ${[address.flat, address.areaLine, address.pincode].filter(Boolean).join(", ")}`}
        </Text>
      </View>
    </View>
  );
}

/** "Reject this order?": a fixed list of reasons; Reject stays off until one is chosen (design system, Reason picker). */
function RejectSheet({ chosen, onChoose, onConfirm, onCancel }: {
  chosen: RejectReason | null;
  onChoose: (reason: RejectReason) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal transparent visible animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onCancel}>
      <View className="flex-1 justify-end bg-scrim">
        <View accessibilityViewIsModal className="gap-2 rounded-t-sheet bg-raised px-4 pt-4" style={{ paddingBottom: insets.bottom + 12 }}>
          <Text accessibilityRole="header" className="text-headline font-semibold text-text">{words.sheet.title}</Text>
          <View accessibilityRole="radiogroup">
            {RejectReason.options.map((reason) => (
              <Pressable
                key={reason}
                accessibilityRole="radio"
                accessibilityState={{ checked: reason === chosen }}
                onPress={() => onChoose(reason)}
                className="min-h-12 flex-row items-center gap-3 rounded-input px-3 active:bg-primary-subtle"
              >
                <View className={`size-5 items-center justify-center rounded-full border-2 ${reason === chosen ? "border-primary" : "border-border-strong"}`}>
                  {reason === chosen && <View className="size-2.5 rounded-full bg-primary" />}
                </View>
                <Text className="text-body text-text">{words.reasons[reason]}</Text>
              </Pressable>
            ))}
          </View>
          <Button label={words.sheet.confirm} disabled={!chosen} onPress={onConfirm} />
          <Button label={words.sheet.cancel} variant="text" onPress={onCancel} />
        </View>
      </View>
    </Modal>
  );
}

export default function OrderScreen() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [order] = useState(() => createShopOrder(api, id ?? ""));
  const view = useSyncExternalStore(order.subscribe, order.get);
  useInFront(order);
  const [rejecting, setRejecting] = useState<{ chosen: RejectReason | null } | null>(null);
  const shown = view.order;
  const isNew = shown?.status === "placed";
  const seconds = useSecondsLeft(isNew ? shown.expiresAt : null, view.offset);
  const timeUp = view.expired || seconds === 0;
  const done = (answered: boolean) => answered && router.replace("/orders");

  return (
    <View className="flex-1 bg-bg">
      <ScrollView
        contentContainerClassName="gap-4 px-4"
        contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={view.refreshing} onRefresh={() => void order.refresh()} progressViewOffset={insets.top} />}
      >
        <Link href="/orders" asChild><Pressable accessibilityRole="button" className="py-3"><Text className="text-body text-primary">{words.back}</Text></Pressable></Link>
        <Text accessibilityRole="header" className="text-title-large font-semibold text-text">{shown ? words.detailTitle(shown.number) : words.titleLoading}</Text>
        {isNew && seconds !== null && <Countdown seconds={timeUp ? 0 : seconds} />}
        {view.status === "loading" && (
          <View className="min-h-12 flex-row items-center gap-2">
            <ActivityIndicator className="text-primary" />
            <Text className="text-body text-muted">{words.loadingOne}</Text>
          </View>
        )}
        {view.status === "failed" && (
          <View className="items-start">
            <Text className="text-body font-semibold text-text">{words.failed}</Text>
            <Text className="text-secondary text-muted">{view.message}</Text>
            <Button label={words.retry} onPress={() => void order.retry()} variant="text" />
          </View>
        )}
        {view.notice && (
          <View accessibilityLiveRegion="polite" className="gap-1">
            <Text className="text-body font-semibold text-danger">{view.notice}</Text>
            {view.shortLines.length > 0 && <Text className="text-secondary text-text">{words.shortTitle}</Text>}
            {view.shortLines.map((line, index) => <Text key={index} className="text-secondary tabular-nums text-text">{`• ${shortLabel(line)}`}</Text>)}
          </View>
        )}
        {shown && <Detail order={shown} />}
      </ScrollView>

      {isNew && (
        <View className="gap-2.5 border-t border-border bg-surface px-4 pt-3" style={{ paddingBottom: insets.bottom + 12 }}>
          <Button
            label={view.answering === "reject" ? words.rejecting : words.reject}
            variant="secondary"
            busy={view.answering === "reject"}
            disabled={timeUp || view.answering !== null}
            // After NOT_ENOUGH_STOCK, "Items out of stock" is the likely reason (owner's answer 8 on #431).
            onPress={() => setRejecting({ chosen: view.shortLines.length > 0 ? "out_of_stock" : null })}
          />
          <Button
            label={view.answering === "accept" ? words.accepting : words.accept}
            busy={view.answering === "accept"}
            disabled={timeUp || view.answering !== null}
            onPress={() => void order.accept().then(done)}
          />
        </View>
      )}
      {rejecting && (
        <RejectSheet
          chosen={rejecting.chosen}
          onChoose={(chosen) => setRejecting({ chosen })}
          onCancel={() => setRejecting(null)}
          onConfirm={() => {
            if (!rejecting.chosen) return;
            const reason = rejecting.chosen;
            setRejecting(null);
            void order.reject(reason).then(done);
          }}
        />
      )}
    </View>
  );
}
