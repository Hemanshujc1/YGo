import { describe, expect, it } from "vitest";
import { PushTokenBody } from "../src/index";

describe("PushTokenBody (#505)", () => {
  it("accepts an Expo push token with optional platform", () => {
    for (const token of ["ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]", "ExpoPushToken[abc-123]"]) {
      expect(PushTokenBody.parse({ token })).toEqual({ token });
      expect(PushTokenBody.parse({ token, platform: "android" })).toEqual({ token, platform: "android" });
      expect(PushTokenBody.parse({ token, platform: "ios" })).toEqual({ token, platform: "ios" });
    }
  });

  it("refuses anything else", () => {
    for (const token of ["", "ExponentPushToken[]", "fcm-token", `ExponentPushToken[${"x".repeat(200)}]`]) {
      expect(PushTokenBody.safeParse({ token }).success).toBe(false);
    }
    expect(PushTokenBody.safeParse({ token: "ExpoPushToken[abc-123]", platform: "web" }).success).toBe(false);
  });
});
