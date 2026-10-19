import { Linking, Platform, Pressable, View } from "react-native";
import { Text } from "./text";

/** The app's own words and store links: the package holds neither (ADR-0009). */
export type UpdateRequiredProps = {
  title: string;
  message: string;
  button: string;
  // Unset until the store listings exist; the button stays hidden until then.
  iosStoreUrl?: string;
  androidStoreUrl?: string;
};

/** Shown in place of the whole app when the server refuses this version (Q-7). */
export function UpdateRequired({ title, message, button, iosStoreUrl, androidStoreUrl }: UpdateRequiredProps) {
  const storeUrl = Platform.OS === "ios" ? iosStoreUrl : androidStoreUrl;
  return (
    <View className="flex-1 justify-center bg-bg px-4">
      <Text className="text-title-large font-semibold text-text">{title}</Text>
      <Text className="mt-2 text-body text-muted">{message}</Text>
      {storeUrl && (
        <Pressable
          accessibilityRole="button"
          onPress={() => void Linking.openURL(storeUrl)}
          className="mt-8 items-center rounded-button bg-primary py-3.5 active:bg-primary-pressed"
        >
          <Text className="text-label font-medium text-on-primary">{button}</Text>
        </Pressable>
      )}
    </View>
  );
}
