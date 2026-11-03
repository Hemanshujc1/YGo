import { createPush } from "@ygo/mobile/push";
import { router } from "expo-router";
import { api, session } from "../api";
import { strings } from "../strings";

/** The Customer app's pushes (#506): a tap opens its order on C19, or C22 when it has none (owner's answer 14 on #55). */
export const push = createPush({
  api,
  session,
  projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID,
  channelName: strings.notifications.channel,
  // navigate, not push: a tap for the screen already in front doesn't open it twice.
  open: ({ orderId }) => router.navigate(orderId ? { pathname: "/order/[id]", params: { id: orderId } } : "/notifications"),
});
