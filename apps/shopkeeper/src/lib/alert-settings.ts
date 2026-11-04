import { NEW_ORDERS_CHANNEL } from "@ygo/mobile/push";
import { applicationId } from "expo-application";
import { startActivityAsync } from "expo-intent-launcher";
import { Linking, Platform } from "react-native";
import type { Fix } from "./alert-check";

/** Android 14's page for one app's "Full screen notifications" toggle; it needs the package as the intent's data (#511). */
const FULL_SCREEN_SETTINGS = "android.settings.MANAGE_APP_USE_FULL_SCREEN_INTENT";

/**
 * Android's own page for the app's notifications, the New orders channel or showing over the lock screen; when a page
 * can't open, the app's notification settings, then the app's settings. Any other phone gets the app's settings.
 */
export async function openSettings(fix: Exclude<Fix, "ask">) {
  if (Platform.OS === "android" && applicationId) {
    const opened = (promise: Promise<unknown>) => promise.then(() => true, () => false);
    // Settles once the shopkeeper leaves the page, or at once when the phone has no such page.
    if (fix === "full-screen-settings"
      && await opened(startActivityAsync(FULL_SCREEN_SETTINGS, { data: `package:${applicationId}` }))) return;
    const extras = [{ key: "android.provider.extra.APP_PACKAGE", value: applicationId }];
    if (fix === "channel-settings") extras.push({ key: "android.provider.extra.CHANNEL_ID", value: NEW_ORDERS_CHANNEL });
    if (await opened(Linking.sendIntent(
      fix === "channel-settings" ? "android.settings.CHANNEL_NOTIFICATION_SETTINGS" : "android.settings.APP_NOTIFICATION_SETTINGS",
      extras,
    ))) return;
  }
  await Linking.openSettings();
}
