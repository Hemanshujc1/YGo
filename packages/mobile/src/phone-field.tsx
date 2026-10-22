import { type Ref, useState } from "react";
import { TextInput, View } from "react-native";
import { PHONE_PREFIX } from "./profile-flow";
import { edgeClass, FieldMessage } from "./sign-in-parts";
import { Text } from "./text";

type PhoneFieldProps = {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  onSubmitEditing: () => void;
  editable: boolean;
  /** Shown under the box in red, and turns its edge red. */
  message?: string | null;
  ref?: Ref<TextInput>;
};

/** A phone number box with "+91" fixed before it: C02 and C03 (#216, Q8). */
export function PhoneField({ label, value, onChangeText, onSubmitEditing, editable, message, ref }: PhoneFieldProps) {
  const [focused, setFocused] = useState(false);
  return (
    <View>
      <Text className="text-label font-medium text-text">{label}</Text>
      <View
        className={`mt-2 h-[52px] flex-row items-center gap-2 rounded-input bg-surface px-4 ${edgeClass(!!message, focused)}`}
      >
        <Text className="text-body tabular-nums text-muted">{PHONE_PREFIX}</Text>
        <TextInput
          ref={ref}
          value={value}
          onChangeText={onChangeText}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onSubmitEditing={onSubmitEditing}
          editable={editable}
          keyboardType="phone-pad"
          textContentType="telephoneNumber"
          autoComplete="tel"
          returnKeyType="done"
          accessibilityLabel={label}
          className="h-full flex-1 font-sans text-body tabular-nums text-text"
        />
      </View>
      {message && <FieldMessage text={message} />}
    </View>
  );
}
