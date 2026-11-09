import { Text } from "@ygo/mobile";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { strings } from "../strings";
import { ChevronLeft } from "./icons";

/** A screen's title, after a Back button when there is a screen to go back to (C23, C15), and an action at the end (C19's Call the shop). */
export function TopBar({ title, action, onBack }: { title: string; action?: ReactNode; onBack?: () => void }) {
  const canBack = router.canGoBack();
  const showBack = Boolean(canBack || onBack);
  return (
    <View className="min-h-14 flex-row items-center gap-1 p-1">
      {showBack && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={strings.back}
          onPress={() => (onBack ? onBack() : router.back())}
          className="size-12 items-center justify-center rounded-full active:bg-primary-subtle"
        >
          <ChevronLeft className="text-text" />
        </Pressable>
      )}
      <Text
        accessibilityRole="header"
        className={`flex-1 text-headline font-semibold text-text ${showBack ? "px-1" : "pl-3 pr-1"}`}
      >
        {title}
      </Text>
      {action}
    </View>
  );
}
