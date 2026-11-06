import type { ComponentType } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Text } from "./text";

export type TabItem = { key: string; label: string; icon: ComponentType<{ className?: string }> };

/**
 * The bottom tab bar (design system, Navigation; #550). It only draws the tabs it is given and says which one was
 * tapped: the app chooses the tabs by role and does the navigating. 56 high, the label in the Small label style.
 */
export function TabBar({ tabs, active, onSelect }: { tabs: TabItem[]; active: string | null; onSelect: (key: string) => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View accessibilityRole="tablist" className="flex-row border-t border-border bg-surface" style={{ paddingBottom: insets.bottom }}>
      {tabs.map(({ key, label, icon: Icon }) => {
        const selected = key === active;
        return (
          <Pressable
            key={key}
            accessibilityRole="tab"
            accessibilityLabel={label}
            accessibilityState={{ selected }}
            onPress={() => onSelect(key)}
            className="min-h-14 flex-1 items-center justify-center gap-0.5 active:bg-primary-subtle"
          >
            <Icon className={selected ? "text-primary" : "text-muted"} />
            <Text className={`text-small-label font-medium ${selected ? "text-primary" : "text-muted"}`}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
