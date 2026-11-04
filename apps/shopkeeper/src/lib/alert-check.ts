/** Importance as `expo-notifications` numbers it: HIGH and above make a sound and pop up on Android. */
const HIGH = 6;

/** What the phone says about notifications, as `expo-notifications` reports it. */
export type Permission = { granted: boolean; canAskAgain: boolean; ios?: { allowsSound: boolean | null } };
/** The New orders channel, or null where the phone has none to report. */
export type Channel = { importance: number; sound: string | null } | null;

export type AlertCheck = { notifications: boolean; ringing: boolean; canAsk: boolean };

/**
 * S03's two rows (#507): whether notifications are allowed, and whether a new order still rings: on Android the New
 * orders channel is not muted or lowered below HIGH; on an iPhone sounds are allowed. A channel the phone can't report
 * counts as ringing, as nothing can be fixed there.
 */
export function alertCheck(permission: Permission, channel: Channel, os: "android" | "ios"): AlertCheck {
  const ringing = os === "ios"
    ? permission.ios?.allowsSound !== false
    : channel === null || (channel.importance >= HIGH && channel.sound !== null);
  return { notifications: permission.granted, ringing, canAsk: permission.canAskAgain };
}

/** S03 shows only when something would keep a new order from ringing. */
export const limited = (check: AlertCheck) => !check.notifications || !check.ringing;

export type Fix = "ask" | "app-settings" | "channel-settings";

/**
 * Each row's one button (owner's answers 3 and 5 on #507): the system prompt while the phone still allows it, else the
 * app's settings; a muted alarm opens the New orders channel's own settings on Android, the app's settings on an iPhone.
 */
export function fixFor(row: "notifications" | "ringing", check: AlertCheck, os: "android" | "ios"): Fix {
  if (row === "notifications") return check.canAsk ? "ask" : "app-settings";
  return os === "android" ? "channel-settings" : "app-settings";
}
