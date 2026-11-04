import { Button, Text, useInFront } from "@ygo/mobile";
import { NEW_ORDER_SOUND, NEW_ORDERS_CHANNEL } from "@ygo/mobile/push";
import { applicationId } from "expo-application";
import { getNotificationChannelAsync, getPermissionsAsync, scheduleNotificationAsync } from "expo-notifications";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Linking, Platform, View } from "react-native";
import { api } from "../api";
import { type AlertCheck, alertCheck, type Fix, fixFor, limited, type Phone } from "../lib/alert-check";
import { checkFullScreenIntent } from "../lib/order-alert";
import { push } from "../lib/push";
import { createShopOrders, waitingOrder } from "../lib/shop-orders";
import { strings } from "../strings";
import { Countdown, useSecondsLeft } from "./countdown";
import { OrderRow } from "./order-row";

const words = strings.alerts;
const os = Platform.OS === "ios" ? "ios" : "android";
const phone: Phone = { os, version: Number(Platform.Version) };

/** A permission the phone can't read counts as off, so S03 shows rather than hides a problem. */
async function readCheck(): Promise<AlertCheck> {
  // The channel is read once the app has made it, or failed to.
  await push.newOrdersReady;
  const [permission, channel, fullScreen] = await Promise.all([
    getPermissionsAsync().catch(() => ({ granted: false, canAskAgain: false })),
    os === "android" ? getNotificationChannelAsync(NEW_ORDERS_CHANNEL).catch(() => null) : null,
    // A failed read stays unknown, so S03 shows for it only when Android reports the permission off.
    os === "android" ? checkFullScreenIntent().catch(() => undefined) : undefined,
  ]);
  return alertCheck(permission, channel, phone, fullScreen);
}

/** Android's own page for the app's notifications or the New orders channel; any other phone gets the app's settings. */
async function openSettings(fix: Exclude<Fix, "ask">) {
  if (os === "android" && applicationId) {
    const extras = [{ key: "android.provider.extra.APP_PACKAGE", value: applicationId }];
    if (fix === "channel-settings") extras.push({ key: "android.provider.extra.CHANNEL_ID", value: NEW_ORDERS_CHANNEL });
    const opened = await Linking.sendIntent(
      fix === "channel-settings" ? "android.settings.CHANNEL_NOTIFICATION_SETTINGS" : "android.settings.APP_NOTIFICATION_SETTINGS",
      extras,
    ).then(() => true, () => false);
    if (opened) return;
  }
  await Linking.openSettings();
}

/** The new-order alarm on demand, so the shopkeeper hears it without a real order; a tap on it opens nothing. */
const testAlert = () => scheduleNotificationAsync({
  content: { title: words.testTitle, body: words.testBody, sound: NEW_ORDER_SOUND, data: { loud: true } },
  trigger: os === "android" ? { channelId: NEW_ORDERS_CHANNEL } : null,
}).catch(() => undefined);

/** The oldest New order, pinned above the panel with its countdown, read as S04 reads it while Home is in front. */
function PinnedOrder() {
  const [orders] = useState(() => createShopOrders(api));
  const view = useSyncExternalStore(orders.subscribe, orders.get);
  useInFront(orders);
  // Re-picked at each tick of the countdown, so an order whose time ran out gives way to the next at once.
  const first = waitingOrder(view.orders, view.offset, Date.now());
  const seconds = useSecondsLeft(first?.expiresAt ?? null, view.offset);
  if (!first) return null;
  return (
    <View className="gap-2">
      <Text accessibilityRole="header" className="text-title font-semibold text-text">{words.waitingTitle}</Text>
      <OrderRow order={first} chip={false}>{seconds !== null && <Countdown seconds={seconds} />}</OrderRow>
    </View>
  );
}

function Row({ label, on, fix, onFix }: { label: string; on: boolean; fix: Fix; onFix(): void }) {
  return (
    <View className="flex-row items-center justify-between gap-3">
      <View className="flex-1">
        <Text className="text-body font-semibold text-text">{label}</Text>
        <Text className={`text-secondary ${on ? "text-success" : "text-warning"}`}>{on ? words.on : words.off}</Text>
      </View>
      {!on && <Button label={fix === "ask" ? words.allow : words.openSettings} variant="secondary" onPress={onFix} />}
    </View>
  );
}

/**
 * S03 (#507), on a Live or Suspended shop's Home: asks for notifications the first time it shows, then checks again
 * each time Home comes to the front or the app comes back from the settings. Shown only when notifications are off or
 * the New orders channel won't ring, with the oldest waiting order pinned above it.
 */
export function AlertPanel() {
  const [check, setCheck] = useState<AlertCheck | null>(null);
  const allowed = useRef<boolean | null>(null);
  const recheck = useCallback(() => void readCheck().then((next) => {
    // Turned on in the phone's settings: the launch found no permission, so the token goes now.
    if (next.notifications && allowed.current === false) void push.resend();
    allowed.current = next.notifications;
    setCheck(next);
  }), []);
  const stop = useCallback(() => {}, []);
  useInFront({ start: recheck, stop });
  // Once per phone, the first time orders can arrive (owner's answer 3 on #507).
  // A prompt answered here has sent the token already, so the next check doesn't send it again.
  const asked = useCallback(() => {
    allowed.current = null;
    recheck();
  }, [recheck]);
  useEffect(() => void push.ask().then(asked), [asked]);

  if (!check || !limited(check)) return null;
  const fix = (row: "notifications" | "ringing") => {
    const chosen = fixFor(row, check, phone);
    if (chosen === "ask") void push.askAgain().then(asked);
    else void openSettings(chosen);
  };
  return (
    <View className="gap-4">
      <PinnedOrder />
      <View className="gap-3 rounded-card border border-border bg-surface p-4">
        <Text accessibilityRole="header" className="text-title font-semibold text-text">{words.title}</Text>
        <Text className="text-body text-muted">{words.body}</Text>
        <Row label={words.notifications} on={check.notifications} fix={fixFor("notifications", check, phone)} onFix={() => fix("notifications")} />
        <Row label={words.ringing} on={check.ringing} fix={fixFor("ringing", check, phone)} onFix={() => fix("ringing")} />
        {phone.os === "android" && check.fullScreen !== undefined && (
          <View className="flex-row items-center justify-between gap-3">
            <View className="flex-1">
              <Text className="text-body font-semibold text-text">{words.fullScreen}</Text>
              <Text className={`text-secondary ${check.fullScreen ? "text-success" : "text-warning"}`}>
                {check.fullScreen ? words.on : words.off}
              </Text>
            </View>
          </View>
        )}
        {/* Nothing can show while notifications are off. */}
        {check.notifications && <Button label={words.test} variant="text" onPress={() => void testAlert()} />}
      </View>
    </View>
  );
}
