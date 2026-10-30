import { Pressable, View } from "react-native";
import Animated, { useAnimatedStyle, withTiming } from "react-native-reanimated";

/** The design system's toggle: 52 by 32 inside a 48-high tap area, the thumb sliding in 150 ms. */
export function Toggle({ on, busy, label, onPress }: { on: boolean; busy: boolean; label: string; onPress: () => void }) {
  const thumb = useAnimatedStyle(() => ({ transform: [{ translateX: withTiming(on ? 20 : 0, { duration: 150 }) }] }), [on]);
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: on, busy }}
      disabled={busy}
      onPress={onPress}
      className="h-12 justify-center"
    >
      <View className={`h-8 w-[52px] justify-center rounded-full px-1 ${on ? "bg-primary" : "bg-border-strong"}`}>
        <Animated.View className="h-6 w-6 rounded-full bg-surface" style={thumb} />
      </View>
    </Pressable>
  );
}
