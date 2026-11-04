import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Platform: { OS: "android", Version: 34 },
}));

vi.mock("react-native-notify-kit", () => ({
  default: {
    displayNotification: vi.fn(),
    getNotificationSettings: vi.fn().mockResolvedValue({
      android: { fullScreenIntent: 1 },
    }),
  },
  AndroidCategory: { ALARM: "alarm" },
  AndroidImportance: { HIGH: 4 },
  AndroidNotificationSetting: { ENABLED: 1, DISABLED: 0 },
}));

import { buildOrderAlert, checkFullScreenIntent, displayOrderAlert, orderAlertKey } from "../src/lib/order-alert";
import notifee from "react-native-notify-kit";

describe("Order Alert Builder (#508)", () => {
  it("generates deterministic replacement identity order-<id>", () => {
    expect(orderAlertKey("123-abc")).toBe("order-123-abc");
  });

  it("builds S01 full-screen alert when hasFullScreenIntent is true", () => {
    const alert = buildOrderAlert({
      orderId: "ord-1",
      ringAttemptId: "att-1",
      orderNumber: 1001,
      hasFullScreenIntent: true,
    });

    expect(alert.id).toBe("order-ord-1");
    expect(alert.title).toBe("New order #1001");
    expect(alert.body).toBe("Accept or reject it within 10 minutes.");
    expect(alert.data).toEqual({
      orderId: "ord-1",
      ringAttemptId: "att-1",
      kind: "order_placed",
    });
    expect(alert.android).toMatchObject({
      channelId: "new-orders",
      tag: "order-ord-1",
      category: "alarm",
      importance: 4,
      lightUpScreen: true,
      fullScreenAction: { id: "default", launchActivity: "default" },
      pressAction: { id: "default", launchActivity: "default" },
    });
  });

  it("builds S02 loud notification fallback without fullScreenAction when hasFullScreenIntent is false", () => {
    const alert = buildOrderAlert({
      orderId: "ord-2",
      ringAttemptId: "att-2",
      title: "New order #1002",
      body: "Order waiting",
      hasFullScreenIntent: false,
    });

    expect(alert.id).toBe("order-ord-2");
    expect(alert.title).toBe("New order #1002");
    expect(alert.body).toBe("Order waiting");
    expect(alert.android?.fullScreenAction).toBeUndefined();
    expect(alert.android).toMatchObject({
      channelId: "new-orders",
      tag: "order-ord-2",
      category: "alarm",
      importance: 4,
      lightUpScreen: true,
      pressAction: { id: "default", launchActivity: "default" },
    });
  });

  it("shares the same tag and id across ring attempts so attempts replace in place", () => {
    const attempt1 = buildOrderAlert({
      orderId: "ord-3",
      ringAttemptId: "att-attempt-1",
      orderNumber: 1003,
    });
    const attempt2 = buildOrderAlert({
      orderId: "ord-3",
      ringAttemptId: "att-attempt-2",
      orderNumber: 1003,
      title: "REMINDER: Order #1003",
    });

    expect(attempt1.id).toBe(attempt2.id);
    expect(attempt1.android?.tag).toBe(attempt2.android?.tag);
    expect(attempt1.data?.orderId).toBe(attempt2.data?.orderId);
    expect(attempt1.data?.ringAttemptId).not.toBe(attempt2.data?.ringAttemptId);
  });

  it("checks fullScreenIntent and displays notification through notify-kit", async () => {
    const granted = await checkFullScreenIntent();
    expect(granted).toBe(true);

    await displayOrderAlert({
      orderId: "ord-4",
      ringAttemptId: "att-4",
      orderNumber: 1004,
      hasFullScreenIntent: true,
    });

    expect(notifee.displayNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "order-ord-4",
        android: expect.objectContaining({
          tag: "order-ord-4",
          fullScreenAction: { id: "default", launchActivity: "default" },
        }),
      }),
    );
  });
});
