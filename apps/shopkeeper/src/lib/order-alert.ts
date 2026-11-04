import { Platform } from "react-native";
import notifee, {
  AndroidCategory,
  AndroidImportance,
  AndroidNotificationSetting,
  type Notification,
} from "react-native-notify-kit";

export interface OrderAlertOptions {
  orderId: string;
  ringAttemptId?: string;
  orderNumber?: number;
  title?: string;
  body?: string;
  hasFullScreenIntent?: boolean;
}

/** Android identity for new-order alerts: later rings and re-rings share this key so they replace in-place (#508). */
export const orderAlertKey = (orderId: string) => `order-${orderId}`;

/**
 * Checks whether Android allows fullScreenIntent over the lock screen (#508).
 * Android 14+ gives the user a toggle; older versions grant it with USE_FULL_SCREEN_INTENT.
 */
export async function checkFullScreenIntent(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  try {
    const settings = await notifee.getNotificationSettings();
    return settings.android?.fullScreenIntent === AndroidNotificationSetting.ENABLED;
  } catch {
    return false;
  }
}

/**
 * Builds the Notifee notification payload for S01 (full-screen alert) or S02 (loud heads-up notification fallback).
 * Both use the same `order-<id>` identity so re-rings replace the existing alert without stacking (#508).
 */
export function buildOrderAlert({
  orderId,
  ringAttemptId,
  orderNumber,
  title,
  body,
  hasFullScreenIntent = true,
}: OrderAlertOptions): Notification {
  const key = orderAlertKey(orderId);
  const alertTitle = title ?? (orderNumber ? `New order #${orderNumber}` : "New order");
  const alertBody = body ?? "Accept or reject it within 10 minutes.";

  return {
    id: key,
    title: alertTitle,
    body: alertBody,
    data: {
      orderId,
      ...(ringAttemptId ? { ringAttemptId } : {}),
      kind: "order_placed",
    },
    android: {
      channelId: "new-orders",
      tag: key,
      category: AndroidCategory.ALARM,
      importance: AndroidImportance.HIGH,
      lightUpScreen: true,
      pressAction: {
        id: "default",
        launchActivity: "default",
      },
      ...(hasFullScreenIntent
        ? {
            fullScreenAction: {
              id: "default",
              launchActivity: "default",
            },
          }
        : {}),
    },
  };
}

/** Displays S01/S02 on Android, returning the displayed notification ID (#508). */
export async function displayOrderAlert(options: OrderAlertOptions): Promise<string> {
  const hasFullScreen = options.hasFullScreenIntent ?? (await checkFullScreenIntent());
  const payload = buildOrderAlert({ ...options, hasFullScreenIntent: hasFullScreen });
  return notifee.displayNotification(payload);
}

