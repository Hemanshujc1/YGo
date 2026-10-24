import type { ThemeChoice } from "@ygo/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { type AppSession, useTheme } from "./session";
import { FieldMessage } from "./sign-in-parts";
import { Text } from "./text";

export type ThemePickerWords = { label: string; notSaved: string } & Record<ThemeChoice, string>;

const themes: ThemeChoice[] = ["system", "light", "dark"];

/**
 * "Theme" over System / Light / Dark (C23, #193). A tap changes the app at
 * once and saves the choice to the account; the session holds both (#195).
 * If the save fails, the old theme comes back with `notSaved`. Taps wait
 * while a save is under way.
 */
export function ThemePicker({ session, words }: { session: AppSession; words: ThemePickerWords }) {
  const { choice: theme, saving } = useTheme(session);
  const [failed, setFailed] = useState(false);

  async function choose(choice: ThemeChoice) {
    setFailed(false);
    setFailed(!(await session.chooseTheme(choice)));
  }

  return (
    <View className="gap-1.5">
      <Text className="text-label font-medium text-text">{words.label}</Text>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={words.label}
        accessibilityState={{ busy: saving }}
        className="flex-row overflow-hidden rounded-button border border-border-strong"
      >
        {themes.map((choice, i) => (
          <Pressable
            key={choice}
            accessibilityRole="radio"
            accessibilityState={{ checked: theme === choice, disabled: saving }}
            disabled={saving}
            onPress={() => {
              if (choice !== theme) void choose(choice);
            }}
            className={`min-h-12 flex-1 items-center justify-center ${i > 0 ? "border-l border-border" : ""} ${
              theme === choice ? "bg-primary-subtle" : "bg-surface"
            }`}
          >
            <Text className={`text-label font-medium ${theme === choice ? "text-on-primary-subtle" : "text-text"}`}>
              {words[choice]}
            </Text>
          </Pressable>
        ))}
      </View>
      {failed && <FieldMessage text={words.notSaved} />}
    </View>
  );
}
