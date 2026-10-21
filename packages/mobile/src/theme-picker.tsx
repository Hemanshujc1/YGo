import { useState } from "react";
import { Pressable, View } from "react-native";
import { Text } from "./text";
import { chooseTheme, savedTheme, type ThemeChoice } from "./theme";

export type ThemePickerWords = { label: string } & Record<ThemeChoice, string>;

const themes: ThemeChoice[] = ["system", "light", "dark"];

/** "Theme" over System / Light / Dark. A tap changes the app at once and saves the choice on this phone (C23, #193). */
export function ThemePicker({ words }: { words: ThemePickerWords }) {
  const [theme, setTheme] = useState(savedTheme);

  return (
    <View className="gap-1.5">
      <Text className="text-label font-medium text-text">{words.label}</Text>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={words.label}
        className="flex-row overflow-hidden rounded-button border border-border-strong"
      >
        {themes.map((choice, i) => (
          <Pressable
            key={choice}
            accessibilityRole="radio"
            accessibilityState={{ checked: theme === choice }}
            onPress={() => {
              chooseTheme(choice);
              setTheme(choice);
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
    </View>
  );
}
