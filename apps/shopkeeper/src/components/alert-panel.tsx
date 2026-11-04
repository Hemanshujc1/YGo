import { Button, Text, useInFront } from "@ygo/mobile";
import { NEW_ORDER_SOUND, NEW_ORDERS_CHANNEL } from "@ygo/mobile/push";
import { applicationId } from "expo-application";
import { getNotificationChannelAsync, getPermissionsAsync, scheduleNotificationAsync } from "expo-notifications";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Linking, Platform, View } from "react-native";
import { api } from "../api";
import { type AlertCheck, alertCheck, type Fix, fixFor, limited } from "../lib/alert-check";
import { push } from "../lib/push";
import { createShopOrders } from "../lib/shop-orders";
import { strings } from "../strings";
import { Countdown, useSecondsLeft } from "./countdown";
import { OrderRow } from "./order-row";

const words = strings.alerts;
const os = Platform.OS === "ios" ? "ios" : "android";

async function readCheck(): Promise<AlertCheck> {
  const [permission, channel] = await Promise.all([
    getPermissionsAsync(),
    os === "android" ? getNotificationChannelAsync(NEW_ORDERS_CHANNEL).catch(() => null) : null,
  ]);
  return alertCheck(permission, channel, os);
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
  const first = view.orders?.new[0];
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
  const recheck = useCallback(() => void readCheck().then(setCheck, () => undefined), []);
  const stop = useCallback(() => {}, []);
  useInFront({ start: recheck, stop });
  // Once per phone, the first time orders can arrive (owner's answer 3 on #507).
  useEffect(() => void push.ask().then(recheck), [recheck]);

  if (!check || !limited(check)) return null;
  const fix = (row: "notifications" | "ringing") => {
    const chosen = fixFor(row, check, os);
    if (chosen === "ask") void push.askAgain().then(recheck);
    else void openSettings(chosen);
  };
  return (
    <View className="gap-4">
      <PinnedOrder />
      <View className="gap-3 rounded-card border border-border bg-surface p-4">
        <Text accessibilityRole="header" className="text-title font-semibold text-text">{words.title}</Text>
        <Text className="text-body text-muted">{words.body}</Text>
        <Row label={words.notifications} on={check.notifications} fix={fixFor("notifications", check, os)} onFix={() => fix("notifications")} />
        <Row label={words.ringing} on={check.ringing} fix={fixFor("ringing", check, os)} onFix={() => fix("ringing")} />
        <Button label={words.test} variant="text" onPress={() => void testAlert()} />
      </View>
    </View>
  );
}
