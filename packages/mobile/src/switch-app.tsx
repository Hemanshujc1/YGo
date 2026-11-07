import { useState } from "react";
import { Linking, Pressable, View } from "react-native";
import { openApp } from "./switch-app-flow";
import { Text } from "./text";

/**
 * The "Switch to …" row on C23 and S36 (#551, ACC-4). It opens the other app by its link and works offline. When the
 * other app is not installed, the row says so; there is no store link until the apps are in the stores.
 */
export function SwitchApp({ title, body, url, notInstalled }: { title: string; body?: string | null; url: string; notInstalled: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <View className="overflow-hidden rounded-card border border-border bg-surface">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        onPress={() => { void openApp((target) => Linking.openURL(target), url).then((opened) => setFailed(!opened)); }}
        className="min-h-14 justify-center gap-1 px-4 py-3 active:bg-primary-subtle"
      >
        <Text className="text-body font-semibold text-primary">{title}</Text>
        {body ? <Text className="text-secondary text-muted">{body}</Text> : null}
        {failed ? <Text accessibilityLiveRegion="polite" className="text-secondary text-danger">{notInstalled}</Text> : null}
      </Pressable>
    </View>
  );
}
