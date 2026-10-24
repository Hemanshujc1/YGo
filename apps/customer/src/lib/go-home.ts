import { router } from "expo-router";

/**
 * Back to Home alone on the stack, so Back never returns to an old location.
 * Home asks about the new place and shows it, or C03. Takes the name of the
 * stack's first screen, read before anything is dismissed.
 */
export function goHome(firstScreen: string | undefined) {
  if (router.canDismiss()) router.dismissAll();
  if (firstScreen !== "index") router.replace("/");
}
