import { router } from "expo-router";

/**
 * Back to Home alone on the stack, so Back never returns to an old location.
 * Home asks about the new place and shows it, or C03. Takes the screen's
 * navigation, whose first screen is read before anything is dismissed.
 */
export function goHome(navigation: { getState(): { routes: { name: string }[] } | undefined }) {
  const firstScreen = navigation.getState()?.routes[0]?.name;
  if (router.canDismiss()) router.dismissAll();
  if (firstScreen !== "index") router.replace("/");
}
