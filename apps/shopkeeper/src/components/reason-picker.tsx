import { Text } from "@ygo/mobile";
import { Pressable, View } from "react-native";

/** The reasons in a sheet before a destructive action, one chosen at a time (design system, reason picker): S05 Reject, S37 Void. */
export function ReasonPicker<Reason extends string>({ reasons, chosen, words, label, disabled = false, onChoose }: {
  reasons: readonly Reason[];
  chosen: Reason | null;
  words: Record<Reason, string>;
  label?: string;
  disabled?: boolean;
  onChoose: (reason: Reason) => void;
}) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label}>
      {reasons.map((reason) => (
        <Pressable
          key={reason}
          accessibilityRole="radio"
          accessibilityState={{ checked: reason === chosen, disabled }}
          disabled={disabled}
          onPress={() => onChoose(reason)}
          className="min-h-12 flex-row items-center gap-3 rounded-input px-3 active:bg-primary-subtle"
        >
          <View className={`size-5 items-center justify-center rounded-full border-2 ${reason === chosen ? "border-primary" : "border-border-strong"}`}>
            {reason === chosen && <View className="size-2.5 rounded-full bg-primary" />}
          </View>
          <Text className="text-body text-text">{words[reason]}</Text>
        </Pressable>
      ))}
    </View>
  );
}
