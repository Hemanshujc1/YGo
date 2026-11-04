import * as TaskManager from "expo-task-manager";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { api } from "../api";
import { checkFullScreenIntent, displayOrderAlert } from "./order-alert";

export const BACKGROUND_NOTIFICATION_TASK = "YGO_BACKGROUND_NOTIFICATION_TASK";

/**
 * Background notification task registered at module scope (#508): catches data-only new-order pushes
 * when the app is in the background or swiped away, displays S01/S02 under identity order-<id>,
 * and sends the ring attempt acknowledgement to the server.
 */
if (Platform.OS === "android") {
  TaskManager.defineTask(BACKGROUND_NOTIFICATION_TASK, async ({ data, error }) => {
    if (error) {
      console.warn("Background notification task error:", error);
      return;
    }
    const notification = (data as { notification?: { request?: { content?: { data?: Record<string, unknown>; title?: string; body?: string } } } })?.notification;
    const content = notification?.request?.content;
    const pushData = (content?.data ?? {}) as Record<string, unknown>;

    const orderId = typeof pushData.orderId === "string" ? pushData.orderId : null;
    const ringAttemptId = typeof pushData.ringAttemptId === "string" ? pushData.ringAttemptId : null;
    const kind = typeof pushData.kind === "string" ? pushData.kind : null;

    if (orderId && kind === "order_placed") {
      // Unknown counts as not allowed here, so the alert falls back to S02.
      const hasFullScreen = (await checkFullScreenIntent()) === true;
      await displayOrderAlert({
        orderId,
        ringAttemptId: ringAttemptId ?? undefined,
        title: typeof content?.title === "string" ? content.title : undefined,
        body: typeof content?.body === "string" ? content.body : undefined,
        hasFullScreenIntent: hasFullScreen,
      });

      if (ringAttemptId) {
        await api.ackRingAttempt(ringAttemptId).catch(() => undefined);
      }
    }
  });

  void Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK).catch(() => undefined);
}

