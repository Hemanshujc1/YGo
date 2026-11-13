import { createPush } from "@ygo/mobile/push";
import { router } from "expo-router";
import { api, session } from "../api";
import { strings } from "../strings";
import { openTarget } from "./statements";

/** The Shopkeeper app's pushes (#507): a tap opens its order on S05, its statement on S15 (#630), or S41 when it has neither. */
export const push = createPush({
  api,
  session,
  projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID,
  channelName: strings.notifications.channel,
  newOrdersName: strings.notifications.newOrdersChannel,
  // navigate, not push: a tap for the screen already in front doesn't open it twice.
  open: (tap) => router.navigate(openTarget(tap)),
});
