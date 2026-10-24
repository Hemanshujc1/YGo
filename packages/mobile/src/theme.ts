import type { ThemeChoice } from "@ygo/contracts";
import { Appearance } from "react-native";
import { createMMKV } from "react-native-mmkv";

// MMKV holds display preferences only (ADR-0001).
const display = createMMKV({ id: "display" });
const key = "theme";

function savedTheme(): ThemeChoice {
  const value = display.getString(key);
  return value === "light" || value === "dark" ? value : "system";
}

/** The whole app follows the choice, keyboard and system dialogs included, and the token colours with it. */
function applyTheme(choice: ThemeChoice) {
  Appearance.setColorScheme(choice === "system" ? "unspecified" : choice);
}

/** Call once at the top of each app's root layout, after its stylesheet, so a saved Light or Dark never flashes the system theme. */
export function applySavedTheme() {
  applyTheme(savedTheme());
}

/**
 * This phone's copy of the account's theme (#195), for `createSession`. It
 * opens the app in the right theme before the server answers, and keeps the
 * last one while signed out.
 */
export const phoneTheme = {
  saved: savedTheme,
  keep(choice: ThemeChoice) {
    display.set(key, choice);
    applyTheme(choice);
  },
};
