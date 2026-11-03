import type { ApiResult } from "@ygo/api-client";
import type { PushTokenBody } from "@ygo/contracts";
import {
  addNotificationReceivedListener, addNotificationResponseReceivedListener, AndroidImportance, clearLastNotificationResponse,
  getExpoPushTokenAsync, getLastNotificationResponse, getPermissionsAsync, type NotificationResponse, requestPermissionsAsync,
  setNotificationChannelAsync, setNotificationHandler,
} from "expo-notifications";
import { Platform } from "react-native";
import { createMMKV } from "react-native-mmkv";
import { listeners } from "./listeners";
import { createPushTaps, type Owner, registerPush, type Tap } from "./push-flow";
import type { SessionState } from "./session";

export type { Tap } from "./push-flow";

type PushApi = {
  savePushToken(body: PushTokenBody): Promise<ApiResult<undefined>>;
  readNotification(id: string): Promise<ApiResult<undefined>>;
};

type PushOptions = {
  api: PushApi;
  session: { get(): SessionState; subscribe(listener: () => void): () => void };
  /** `EXPO_PUBLIC_EAS_PROJECT_ID`: without it the phone registers nothing (owner's answer 10 on #55). */
  projectId: string | undefined;
  /** The name Android's settings show for the app's ordinary pushes. */
  channelName: string;
  /** Opens what a tap points at, once the server confirmed it is this account's. */
  open(tap: Tap): void;
};

/** How long one registration may take before the next may start. */
const REGISTER_LIMIT_MS = 60_000;

// The newest push's listeners, removed when Fast Refresh runs the app's module again, so a tap is handled once.
let stopLast = () => {};

const flags = createMMKV({ id: "push" });
const asked = "asked";

const device = {
  permission: () => getPermissionsAsync(),
  request: async () => (await requestPermissionsAsync()).granted,
  token: async (projectId: string) => (await getExpoPushTokenAsync({ projectId })).data,
  asked: { get: () => flags.getBoolean(asked) === true, set: () => flags.set(asked, true) },
};

/** The push's own data (#505), or nothing for a push that isn't YGo's. */
function tapOf(response: NotificationResponse): Tap | null {
  const data = response.notification.request.content.data as { notificationId?: unknown; orderId?: unknown } | null;
  if (typeof data?.notificationId !== "string") return null;
  return {
    key: response.notification.request.identifier,
    notificationId: data.notificationId,
    orderId: typeof data.orderId === "string" ? data.orderId : null,
  };
}

/**
 * Push for one app (#506): registers after each sign-in and each launch, opens a tapped push, and tells `onReceived`
 * listeners of each push that arrives while the app is open. Call once, at module level, so a tap that launched the
 * app is not missed.
 */
export function createPush({ api, session, projectId, channelName, open }: PushOptions) {
  stopLast();
  const received = listeners();
  // One registration at a time, so two can never both show the prompt; one that never answers (an iPhone that gets
  // no answer from Apple) lets the next go after a minute.
  let running: Promise<unknown> = Promise.resolve();
  const register = (ask: boolean) => {
    const next = running.then(() => Promise.race([
      registerPush(device, projectId, async (token) => (await api.savePushToken({ token })).ok, ask),
      new Promise((resolve) => setTimeout(resolve, REGISTER_LIMIT_MS)),
    ]));
    running = next.catch(() => undefined);
    return next;
  };

  let askedHere = false;
  const { stop: stopTaps, ...taps } = createPushTaps({
    session,
    async read(id): Promise<Owner> {
      const answer = await api.readNotification(id);
      if (answer.ok) return "mine";
      return answer.code === "NOT_FOUND" ? "not-mine" : "unknown";
    },
    open,
  });

  // While the app is open a push shows as a banner, without sound (owner's answer 15 on #55).
  setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
  });
  // Expo's push service sends an ordinary push on the "default" channel; this names it in Android's settings.
  if (Platform.OS === "android") void setNotificationChannelAsync("default", { name: channelName, importance: AndroidImportance.DEFAULT }).catch(() => undefined);

  const take = (response: NotificationResponse | null) => {
    const tap = response && tapOf(response);
    if (tap) taps.tap(tap);
  };
  const subscriptions = [addNotificationResponseReceivedListener(take), addNotificationReceivedListener(() => received.notify())];
  // A cold start: the tap that launched the app. Cleared, so the next launch doesn't open it again.
  take(getLastNotificationResponse());
  clearLastNotificationResponse();

  // After each sign-in, and at each launch once the session check signs the person in.
  let registeredFor: string | null = null;
  const onSession = () => {
    const state = session.get();
    const accountId = state.status === "signed-in" ? state.account.id : null;
    if (accountId && accountId !== registeredFor) void register(false);
    registeredFor = accountId;
  };
  const stopSession = session.subscribe(onSession);
  onSession();
  stopLast = () => {
    for (const subscription of subscriptions) subscription.remove();
    stopSession();
    stopTaps();
  };

  return {
    /**
     * After an order: shows the system prompt the first time only (owner's answer 3 on #506). Later orders do
     * nothing, as the launch and each sign-in already send the token.
     */
    ask() {
      if (askedHere || device.asked.get()) return;
      askedHere = true;
      void register(true);
    },
    /** Called for each push that arrives while the app is open. */
    onReceived: received.add,
  };
}
