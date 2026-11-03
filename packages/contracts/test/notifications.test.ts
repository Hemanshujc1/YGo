import { describe, expect, it } from "vitest";
import { PushTokenBody } from "../src/index";

describe("PushTokenBody (#505)", () => {
  it("accepts an Expo push token", () => {
    for (const token of ["ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]", "ExpoPushToken[abc-123]"]) {
      expect(PushTokenBody.parse({ token })).toEqual({ token });
    }
  });

  it("refuses anything else", () => {
    for (const token of ["", "ExponentPushToken[]", "fcm-token", `ExponentPushToken[${"x".repeat(200)}]`]) {
      expect(PushTokenBody.safeParse({ token }).success).toBe(false);
    }
  });
});
