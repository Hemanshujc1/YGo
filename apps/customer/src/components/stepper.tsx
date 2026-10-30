import { Text } from "@ygo/mobile";
import type { ComponentType } from "react";
import { Pressable, View } from "react-native";
import { strings } from "../strings";
import { Minus, Plus, Trash2 } from "./icons";

const words = strings.cart;

function Step({ icon: Icon, label, disabled = false, onPress }: { icon: ComponentType<{ size?: number; className?: string }>; label: string; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className="size-12 items-center justify-center rounded-full active:bg-primary-subtle"
    >
      <Icon size={20} className={disabled ? "text-disabled-text" : "text-primary"} />
    </Pressable>
  );
}

/**
 * The quantity stepper (design system, "Selection and quantity"): "Add" when not in the cart, then − n +.
 * At 1 the minus removes the pack; + stops where the server says stock ends (owner's answer 9 on #50).
 */
export function Stepper({ count, max, onChange }: { count: number; max: number | null; onChange: (count: number) => void }) {
  if (count === 0) {
    return (
      <Pressable
        accessibilityRole="button"
        onPress={() => onChange(1)}
        className="h-12 min-w-20 items-center justify-center rounded-button border border-primary px-4 active:bg-primary-subtle"
      >
        <Text className="text-label font-medium text-primary">{words.add}</Text>
      </Pressable>
    );
  }
  const full = max !== null && count >= max;
  return (
    <View className="items-end">
      <View className="flex-row items-center rounded-button border border-primary">
        <Step icon={count === 1 ? Trash2 : Minus} label={count === 1 ? words.remove : words.removeOne} onPress={() => onChange(count - 1)} />
        <Text accessibilityLabel={words.countLabel(count)} className="min-w-8 text-center text-label font-semibold tabular-nums text-text">{count}</Text>
        <Step icon={Plus} label={words.addOne} disabled={full} onPress={() => onChange(count + 1)} />
      </View>
      {full && <Text className="mt-1 text-small-label tabular-nums text-muted">{words.atStock(max)}</Text>}
    </View>
  );
}
