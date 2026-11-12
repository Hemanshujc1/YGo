import type { OrderLine, OrderProposal, OrderResponse } from "@ygo/contracts";
import { formatTime, trimDecimal } from "@ygo/format";
import { Button, Confirm, StatusChip, Text } from "@ygo/mobile";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, RefreshControl, ScrollView, View } from "react-native";
import Animated, { Easing, useAnimatedProps, useReducedMotion, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Path } from "react-native-svg";
import { Countdown, useSecondsLeft } from "../../components/countdown";
import { Phone } from "../../components/icons";
import { QuoteRows } from "../../components/quote-rows";
import { TopBar } from "../../components/top-bar";
import { api } from "../../api";
import { offerText } from "../../lib/cart";
import { changedTotalBanner } from "../../lib/changed-total-banner";
import { money } from "../../lib/money";
import { shownStatus, statusWord, treatments } from "../../lib/order";
import { hasReceipt, makeReceipt } from "../../lib/receipt";
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
  const status = shownStatus(order);
  const quote = { productValue: order.productValue, shopDiscount: order.shopDiscount, deliveryFee: order.deliveryFee, smallCartFee: order.smallCartFee, total: order.total };
  const pickup = order.fulfilment === "pickup";
  return (
    <View className="gap-4">
      {placed && status === "placed" && <PlacedMark />}
      <View className="gap-2">
        <StatusChip word={statusWord(order.fulfilment, status)} treatment={treatments[status]} />
        <Text className="text-secondary tabular-nums text-muted">{`${order.shop.name} · ${formatTime(order.placedAt)}`}</Text>
        {status === "placed" && <Text className="text-body text-text">{words.waiting}</Text>}
        {status === "expired" && <Text className="text-body text-text">{words.expired}</Text>}
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

      <QuoteRows quote={quote} pickup={pickup ? { fee: order.pickupFee } : undefined}>
        <Text className="mt-2 text-secondary text-muted">{pickup ? words.payAtCounter : words.pay}</Text>
      </QuoteRows>

      <Destination order={order} />
    </View>
  );
}

/** Where the order goes: the address it is delivered to, or the shop to collect a pickup from. */
function Destination({ order }: { order: OrderResponse }) {
  if (order.fulfilment === "pickup") {
    return (
      <View>
        <Text className="text-secondary text-muted">{words.collectFrom}</Text>
        <Text className="text-body text-text">{order.shop.name}</Text>
      </View>
    );
  }
  if (!order.address) return null;
  return (
    <View>
      <Text className="text-secondary text-muted">{words.deliverTo}</Text>
      <Text className="text-body text-text">{`${strings.confirm[order.address.label]} · ${addressLine(order.address)}`}</Text>
    </View>
  );
}

/** C10 Changed total screen (#64, #528, ORD-4, NOT-3): review changed items, fee breakdown, reasons, countdown and confirm. */
function ChangedTotalDetail({ order, proposal, secondsLeft }: { order: OrderResponse; proposal: OrderProposal; secondsLeft: number | null }) {
  return (
    <View className="gap-4">
      <View className="gap-2">
        <StatusChip word={words.statuses.awaiting_customer_confirm} treatment={treatments.awaiting_customer_confirm} />
        <Text className="text-secondary tabular-nums text-muted">{`${order.shop.name} · ${formatTime(order.placedAt)}`}</Text>
      </View>

      <View className="gap-2 rounded-card border border-warning bg-warning-subtle p-4">
        <Text className="text-title font-semibold text-warning-text">{words.changedTotal.heading}</Text>
        {secondsLeft !== null && <Countdown seconds={secondsLeft} />}
        <Text className="text-secondary text-text">{words.changedTotal.subtitle}</Text>
        {proposal.lostShopDiscount && (
          <Text className="text-secondary font-semibold text-text">{words.changedTotal.lostDiscount(offerText(proposal.lostShopDiscount))}</Text>
        )}
      </View>

      <View className="rounded-card border border-border bg-surface px-4">
        {proposal.lines.map((line, index) => {
          const isReduced = line.count < line.originalCount || (line.part !== null && line.part !== line.originalPart);
          const originalPack = packLabel(line.quantity, line.baseUnit);
          const originalLabel = [
            line.brand,
            line.originalPart
              ? words.part(packLabel(line.originalPart, line.baseUnit), originalPack)
              : `${trimDecimal(String(line.originalCount))} × ${originalPack}`,
          ].filter(Boolean).join(" · ");
          const proposedPack = packLabel(line.quantity, line.baseUnit);
          const proposedLabel = [
            line.brand,
            line.part
              ? words.part(packLabel(line.part, line.baseUnit), proposedPack)
              : `${trimDecimal(String(line.count))} × ${proposedPack}`,
          ].filter(Boolean).join(" · ");

          return (
            <View key={index} className={`gap-1.5 py-3 ${index > 0 ? "border-t border-border" : ""}`}>
              <View className="flex-row items-center justify-between gap-3">
                <View className="flex-1">
                  <Text className="text-body font-semibold text-text">{line.name}</Text>
                  {isReduced ? (
                    <View className="flex-row items-center gap-1.5 flex-wrap">
                      <Text className="text-secondary line-through text-muted tabular-nums">
                        {originalLabel}
                      </Text>
                      <Text className="text-secondary font-medium tabular-nums text-text">
                        {proposedLabel}
                      </Text>
                    </View>
                  ) : (
                    <Text className="text-secondary tabular-nums text-muted">{originalLabel}</Text>
                  )}
                </View>
                <View className="items-end">
                  {isReduced ? (
                    <Text className="text-secondary line-through text-muted tabular-nums">
                      {money(line.originalLineTotal)}
                    </Text>
                  ) : null}
                  <Text className="text-label font-semibold tabular-nums text-text">
                    {money(line.lineTotal)}
                  </Text>
                </View>
              </View>
              {line.changeReason && (
                <View className="self-start rounded-full border border-border bg-raised px-2.5 py-0.5">
                  <Text className="text-small-label text-muted">
                    {words.changedTotal.reasons[line.changeReason]}
                  </Text>
                </View>
              )}
            </View>
          );
        })}
      </View>

      <QuoteRows
        quote={{ productValue: proposal.productValue, shopDiscount: proposal.shopDiscount, deliveryFee: proposal.deliveryFee, smallCartFee: proposal.smallCartFee, total: proposal.total }}
        was={{ productValue: proposal.originalProductValue, total: proposal.originalTotal }}
        pickup={order.fulfilment === "pickup" ? { fee: proposal.pickupFee } : undefined}
      >
        <Text className="mt-2 text-secondary text-muted">{order.fulfilment === "pickup" ? words.payAtCounter : words.pay}</Text>
      </QuoteRows>

      <Destination order={order} />
    </View>
  );
}

export default function OrderScreen() {
  const insets = useSafeAreaInsets();
  // `phone` comes with a link from a list of orders, so Call the shop shows while the order loads or fails (#52 answer 13).
  const { id, placed, phone: carried } = useLocalSearchParams<{ id: string; placed?: string; phone?: string }>();
  const { order, view } = useOrder(id ?? "");
  const [asking, setAsking] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [receipt, setReceipt] = useState<"idle" | "making" | "failed">("idle");
  const shown = view.order;
  // Unknown until the order is read, when no phone came with the link.
  const phone = shown ? shown.shop.phone : carried || undefined;
  const isAwaiting = shown?.status === "awaiting_customer_confirm";
  const secondsLeft = useSecondsLeft(isAwaiting ? shown.confirmByAt : null);
  const refreshedExpiryRef = useRef<string | null>(null);
  const refreshedNoProposalRef = useRef(false);

  useEffect(() => {
    refreshedExpiryRef.current = null;
    refreshedNoProposalRef.current = false;
  }, [id]);

  // The banner follows the order's status, so it clears once this one is answered (#578).
  const status = shown?.status;
  useEffect(() => {
    if (status) void changedTotalBanner.refresh();
  }, [status]);

  // Awaiting an answer with no proposal to show: read it again once rather than show buttons with nothing to review (#578).
  const lacksProposal = isAwaiting && !shown?.proposal;
  useEffect(() => {
    if (lacksProposal && !refreshedNoProposalRef.current) {
      refreshedNoProposalRef.current = true;
      void order.refresh();
    }
  }, [lacksProposal, order]);

  useEffect(() => {
    if (isAwaiting && secondsLeft === 0 && shown?.confirmByAt && refreshedExpiryRef.current !== shown.confirmByAt) {
      refreshedExpiryRef.current = shown.confirmByAt;
      void order.refresh();
    }
  }, [secondsLeft, isAwaiting, shown?.confirmByAt, order]);

  return (
    <View className="flex-1 bg-bg" style={{ paddingTop: insets.top }}>
      <TopBar
        title={shown ? words.title(shown.number) : words.titleLoading}
        onBack={() => (router.canGoBack() ? router.back() : router.replace("/orders"))}
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
        {isAwaiting && shown?.proposal ? (
          <ChangedTotalDetail order={shown} proposal={shown.proposal} secondsLeft={secondsLeft} />
        ) : shown ? (
          <Detail order={shown} placed={placed === "1"} />
        ) : null}

        {shown?.status === "arrived" && (
          <View className="items-center gap-3 rounded-card border border-primary bg-surface p-5">
            {shown.handoverCode ? (
              <>
                <Text className="text-body font-semibold text-text">{words.handoverCode}</Text>
                <Text selectable accessibilityRole="text" className="text-display font-bold tabular-nums tracking-widest text-primary">{shown.handoverCode}</Text>
              </>
            ) : (
              <>
                <Text className="text-body text-text">{words.itemCheck}</Text>
                <Button label={view.confirmingItems ? words.checkingItems : words.itemsOk} busy={view.confirmingItems} onPress={() => void order.confirmItems()} />
                {view.notice && <Text accessibilityLiveRegion="polite" className="text-secondary text-danger">{view.notice}</Text>}
                <Text className="text-secondary text-muted">{words.codeSoon}</Text>
              </>
            )}
          </View>
        )}

        {shown?.fulfilment === "pickup" && shown.status === "ready" && shown.handoverCode && (
          <View className="items-center gap-3 rounded-card border border-primary bg-surface p-5">
            <Text className="text-body font-semibold text-text">{words.pickupCode}</Text>
            <Text selectable accessibilityRole="text" className="text-display font-bold tabular-nums tracking-widest text-primary">{shown.handoverCode}</Text>
          </View>
        )}

        {shown && hasReceipt(shown.status) && (
          <View className="gap-2">
            <Button label={receipt === "making" ? words.receipt.making : words.receipt.button} busy={receipt === "making"} variant="secondary" onPress={() => {
              setReceipt("making");
              void makeReceipt(api, shown.id).then((done) => setReceipt(done === "shared" ? "idle" : "failed"));
            }} />
            {receipt === "failed" && <Text accessibilityLiveRegion="polite" className="text-secondary text-danger">{words.receipt.failed}</Text>}
          </View>
        )}

        {isAwaiting && shown?.proposal ? (
          <View className="gap-2.5">
            {view.notice && (
              <Text accessibilityLiveRegion="polite" className="text-secondary text-danger">
                {view.notice}
              </Text>
            )}
            {secondsLeft === 0 && !view.notice && (
              <Text accessibilityLiveRegion="polite" className="text-secondary text-danger">
                {words.changedTotal.timeUpPending}
              </Text>
            )}
            <Button
              label={view.confirmingTotal ? words.changedTotal.confirming : words.changedTotal.confirm}
              disabled={secondsLeft === 0 || view.confirmingTotal || view.decliningTotal}
              busy={view.confirmingTotal}
              onPress={() => {
                if (secondsLeft !== 0) void order.confirmTotal();
              }}
            />
            <Button
              label={view.decliningTotal ? words.changedTotal.cancelling : words.changedTotal.cancelFree}
              variant="secondary"
              disabled={secondsLeft === 0 || view.confirmingTotal || view.decliningTotal}
              busy={view.decliningTotal}
              onPress={() => {
                if (secondsLeft !== 0) void order.declineTotal();
              }}
            />
            {phone !== undefined && <CallShop phone={phone} />}
          </View>
        ) : phone !== undefined ? (
          <View className="gap-2.5">
            <CallShop phone={phone} />
            {/* Past its answer time the shop can't take it, so there is nothing left to cancel. */}
            {shown && shownStatus(shown) === "placed" && (
              <Button label={view.cancelling ? words.cancelling : words.cancel} busy={view.cancelling} onPress={() => setAsking(true)} variant="text" />
            )}
            {/* After acceptance only the shop can agree (ORD-5, #59); nothing from ready on, or once it kept the order. */}
            {shown && ["accepted", "preparing"].includes(shown.status) && !shown.cancelRequest && (
              <Button label={view.asking ? words.asking : words.ask} busy={view.asking} onPress={() => setAskOpen(true)} variant="text" />
            )}
            {shown?.cancelRequest?.status === "asked" && <Text className="text-secondary text-muted">{words.askWaiting}</Text>}
            {shown?.cancelRequest?.status === "kept" && <Text className="text-secondary text-muted">{words.askKept}</Text>}
            {view.notice && <Text accessibilityLiveRegion="polite" className="text-secondary text-text">{view.notice}</Text>}
          </View>
        ) : null}
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
      <Confirm
        visible={askOpen}
        title={words.askTitle}
        body={words.askBody}
        confirm={words.ask}
        cancel={words.keep}
        onConfirm={() => {
          setAskOpen(false);
          void order.ask();
        }}
        onCancel={() => setAskOpen(false)}
      />
    </View>
  );
}
