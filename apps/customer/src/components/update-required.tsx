import { Linking, Platform, Pressable, View } from "react-native";
import { strings } from "../strings";
import { Text } from "./text";

// Unset until the store listings exist; the button stays hidden until then.
const storeUrl =
  Platform.OS === "ios"
    ? process.env.EXPO_PUBLIC_IOS_STORE_URL
    : process.env.EXPO_PUBLIC_ANDROID_STORE_URL;

/** Shown in place of the whole app when the server refuses this version (Q-7). */
export function UpdateRequired() {
  return (
    <View className="flex-1 justify-center bg-bg px-4">
      <Text className="text-title-large font-semibold text-text">{strings.update.title}</Text>
      <Text className="mt-2 text-body text-muted">{strings.errors.UPDATE_REQUIRED}</Text>
      {storeUrl && (
        <Pressable
          accessibilityRole="button"
          onPress={() => void Linking.openURL(storeUrl)}
          className="mt-8 items-center rounded-button bg-primary py-3.5 active:bg-primary-pressed"
        >
          <Text className="text-label font-medium text-on-primary">{strings.update.button}</Text>
        </Pressable>
      )}
    </View>
  );
}
