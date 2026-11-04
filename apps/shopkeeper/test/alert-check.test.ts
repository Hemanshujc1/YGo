import { describe, expect, it } from "vitest";
import { alertCheck, fixFor, limited } from "../src/lib/alert-check";

const allowed = { granted: true, canAskAgain: true };
const loud = { importance: 7, sound: "custom" };
const android = { os: "android" as const, version: 34 };
const ios = { os: "ios" as const, version: 17 };

describe("S03 alert check (#507)", () => {
  it("shows nothing while notifications are allowed and the New orders channel rings", () => {
    expect(limited(alertCheck(allowed, loud, android))).toBe(false);
    expect(limited(alertCheck(allowed, { importance: 6, sound: "custom" }, android))).toBe(false);
  });

  it("shows when only the lock-screen permission is off on Android, and not when it is on or unknown", () => {
    const off = alertCheck(allowed, loud, android, false);
    expect(off).toMatchObject({ notifications: true, ringing: true, fullScreen: false });
    expect(limited(off)).toBe(true);
    expect(limited(alertCheck(allowed, loud, android, true))).toBe(false);
    expect(limited(alertCheck(allowed, loud, android))).toBe(false);
  });

  it("shows when notifications are off", () => {
    const check = alertCheck({ granted: false, canAskAgain: true }, loud, android);
    expect(check).toEqual({ notifications: false, ringing: true, canAsk: true });
    expect(limited(check)).toBe(true);
  });

  it("shows when the New orders channel is lowered, silenced, blocked or missing on Android", () => {
    expect(alertCheck(allowed, { importance: 5, sound: "custom" }, android).ringing).toBe(false);
    expect(alertCheck(allowed, { importance: 7, sound: null }, android).ringing).toBe(false);
    expect(alertCheck(allowed, { importance: 2, sound: "custom" }, android).ringing).toBe(false);
    expect(alertCheck(allowed, null, android).ringing).toBe(false);
  });

  it("counts a phone older than Android 8, which has no channels, as ringing", () => {
    expect(alertCheck(allowed, null, { os: "android", version: 25 }).ringing).toBe(true);
  });

  it("reads sounds from the permission on an iPhone, whatever the channel", () => {
    expect(alertCheck({ ...allowed, ios: { allowsSound: false } }, null, ios).ringing).toBe(false);
    expect(alertCheck({ ...allowed, ios: { allowsSound: true } }, { importance: 2, sound: null }, ios).ringing).toBe(true);
  });

  it("asks while the phone still allows it, else opens settings; a muted alarm opens its channel on Android", () => {
    const off = alertCheck({ granted: false, canAskAgain: true }, loud, android);
    expect(fixFor("notifications", off, android)).toBe("ask");
    expect(fixFor("notifications", { ...off, canAsk: false }, android)).toBe("app-settings");
    expect(fixFor("ringing", off, android)).toBe("channel-settings");
    expect(fixFor("ringing", off, ios)).toBe("app-settings");
  });

  it("opens settings before Android 13, which has no prompt to show", () => {
    const off = alertCheck({ granted: false, canAskAgain: true }, loud, { os: "android", version: 32 });
    expect(off.canAsk).toBe(false);
    expect(fixFor("notifications", off, android)).toBe("app-settings");
  });

  it("detects fullScreen on Android (#508)", () => {
    expect(alertCheck(allowed, loud, android, true).fullScreen).toBe(true);
    expect(alertCheck(allowed, loud, android, false).fullScreen).toBe(false);
    expect(alertCheck(allowed, loud, ios, true).fullScreen).toBeUndefined();
  });
});
