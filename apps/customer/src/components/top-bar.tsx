import { Text } from "@ygo/mobile";
import { router } from "expo-router";
import { Pressable, View } from "react-native";
import { strings } from "../strings";
import { ChevronLeft } from "./icons";

/** A screen's title, after a Back button when there is a screen to go back to (C23, C15). */
export function TopBar({ title }: { title: string }) {
  const back = router.canGoBack();
  return (
    <View className="min-h-14 flex-row items-center gap-1 p-1">
      {back && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={strings.account.back}
          onPress={() => router.back()}
          className="size-12 items-center justify-center rounded-full active:bg-primary-subtle"
        >
          <ChevronLeft className="text-text" />
        </Pressable>
      )}
      <Text
        accessibilityRole="header"
        className={`flex-1 text-headline font-semibold text-text ${back ? "px-1" : "pl-3 pr-1"}`}
      >
        {title}
      </Text>
    </View>
  );
}
