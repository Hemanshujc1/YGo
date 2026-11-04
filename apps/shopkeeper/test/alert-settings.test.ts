import { beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ OS: "android" }));
const linking = vi.hoisted(() => ({ sendIntent: vi.fn(), openSettings: vi.fn() }));
const startActivityAsync = vi.hoisted(() => vi.fn());
vi.mock("react-native", () => ({ Platform: platform, Linking: linking }));
vi.mock("expo-application", () => ({ applicationId: "dev.local.ygoshopkeeper" }));
vi.mock("expo-intent-launcher", () => ({ startActivityAsync }));
vi.mock("@ygo/mobile/push", () => ({ NEW_ORDERS_CHANNEL: "new-orders" }));

import { openSettings } from "../src/lib/alert-settings";

const appPackage = { key: "android.provider.extra.APP_PACKAGE", value: "dev.local.ygoshopkeeper" };

beforeEach(() => {
  vi.resetAllMocks();
  platform.OS = "android";
  linking.sendIntent.mockResolvedValue(undefined);
  linking.openSettings.mockResolvedValue(undefined);
  startActivityAsync.mockResolvedValue({ resultCode: 0 });
});

describe("S03 settings pages (#511)", () => {
  it("opens YGo's own Full screen notifications page on Android", async () => {
    await openSettings("full-screen-settings");
    expect(startActivityAsync).toHaveBeenCalledWith("android.settings.MANAGE_APP_USE_FULL_SCREEN_INTENT", { data: "package:dev.local.ygoshopkeeper" });
    expect(linking.sendIntent).not.toHaveBeenCalled();
    expect(linking.openSettings).not.toHaveBeenCalled();
  });

  it("falls back to the app's notification settings, then the app's settings", async () => {
    startActivityAsync.mockRejectedValue(new Error("No activity"));
    await openSettings("full-screen-settings");
    expect(linking.sendIntent).toHaveBeenCalledWith("android.settings.APP_NOTIFICATION_SETTINGS", [appPackage]);
    expect(linking.openSettings).not.toHaveBeenCalled();

    linking.sendIntent.mockRejectedValue(new Error("No activity"));
    await openSettings("full-screen-settings");
    expect(linking.openSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps the channel page for a muted alarm and never uses the launcher for it", async () => {
    await openSettings("channel-settings");
    expect(startActivityAsync).not.toHaveBeenCalled();
    expect(linking.sendIntent).toHaveBeenCalledWith("android.settings.CHANNEL_NOTIFICATION_SETTINGS",
      [appPackage, { key: "android.provider.extra.CHANNEL_ID", value: "new-orders" }]);
  });

  it("opens the app's settings on an iPhone", async () => {
    platform.OS = "ios";
    await openSettings("app-settings");
    expect(startActivityAsync).not.toHaveBeenCalled();
    expect(linking.sendIntent).not.toHaveBeenCalled();
    expect(linking.openSettings).toHaveBeenCalledTimes(1);
  });
});
