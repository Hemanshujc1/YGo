import { Appearance } from "react-native";
import { createMMKV } from "react-native-mmkv";

/** The person's theme. Saved on this phone until sign-in moves it to the account (#34). */
export type ThemeChoice = "system" | "light" | "dark";

// MMKV holds display preferences only (ADR-0001).
const display = createMMKV({ id: "display" });
const key = "theme";

export function savedTheme(): ThemeChoice {
  const value = display.getString(key);
  return value === "light" || value === "dark" ? value : "system";
}

/** The whole app follows the choice, keyboard and system dialogs included, and the token colours with it. */
export function applyTheme(choice: ThemeChoice) {
  Appearance.setColorScheme(choice === "system" ? "unspecified" : choice);
}

export function chooseTheme(choice: ThemeChoice) {
  display.set(key, choice);
  applyTheme(choice);
}
