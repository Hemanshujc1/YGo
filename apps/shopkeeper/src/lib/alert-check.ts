/**
 * `AndroidImportance.HIGH` in `expo-notifications`, where HIGH and above make a sound and pop up; written out so this
 * file loads without the native module in tests.
 */
const HIGH = 6;
/** Android 8, the first with channels, and Android 13, the first that shows a prompt for notifications. */
const CHANNELS_FROM = 26;
const PROMPT_FROM = 33;

/** What the phone says about notifications, as `expo-notifications` reports it. */
export type Permission = { granted: boolean; canAskAgain: boolean; ios?: { allowsSound: boolean | null } };
/** The New orders channel, or null when the phone has none. */
export type Channel = { importance: number; sound: string | null } | null;
/** The phone: on Android, `version` is its API level. */
export type Phone = { os: "android" | "ios"; version: number };

export type AlertCheck = { notifications: boolean; ringing: boolean; canAsk: boolean };

/**
 * S03's two rows (#507): whether notifications are allowed, and whether a new order still rings: on Android the New
 * orders channel exists and is not muted or lowered below HIGH; on an iPhone sounds are allowed. Before Android 13
 * there is no prompt to show, only the settings.
 */
export function alertCheck(permission: Permission, channel: Channel, phone: Phone): AlertCheck {
  const ringing = phone.os === "ios"
    ? permission.ios?.allowsSound !== false
    : phone.version < CHANNELS_FROM || (channel !== null && channel.importance >= HIGH && channel.sound !== null);
  const canAsk = permission.canAskAgain && (phone.os === "ios" || phone.version >= PROMPT_FROM);
  return { notifications: permission.granted, ringing, canAsk };
}

/** S03 shows only when something would keep a new order from ringing. */
export const limited = (check: AlertCheck) => !check.notifications || !check.ringing;

export type Fix = "ask" | "app-settings" | "channel-settings";

/**
 * Each row's one button (owner's answers 3 and 5 on #507): the system prompt while the phone still allows it, else the
 * app's settings; a muted alarm opens the New orders channel's own settings on Android, the app's settings on an iPhone.
 */
export function fixFor(row: "notifications" | "ringing", check: AlertCheck, phone: Phone): Fix {
  if (row === "notifications") return check.canAsk ? "ask" : "app-settings";
  return phone.os === "android" ? "channel-settings" : "app-settings";
}
