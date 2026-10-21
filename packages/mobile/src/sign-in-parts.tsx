import { ActivityIndicator, Linking, Pressable } from "react-native";
import { Text } from "./text";

/** C01 and C14's last line: "Help:" and the support email, which opens a new email. */
export function HelpLine({ before, help, supportEmail }: { before?: string; help: string; supportEmail: string }) {
  return (
    <Text className="mt-8 text-secondary text-muted">
      {before ? `${before} ` : ""}
      {`${help} `}
      <SupportEmail address={supportEmail} className="text-secondary" />
    </Text>
  );
}

/** A text box's edge: red when its value was refused, else blue while focused. */
export function edgeClass(wrong: boolean, focused: boolean): string {
  return wrong ? "border-2 border-danger" : focused ? "border-2 border-primary" : "border border-border-strong";
}

/** The message under a field, read out when it appears. */
export function FieldMessage({ text }: { text: string }) {
  return (
    <Text accessibilityLiveRegion="polite" className="mt-2 text-secondary text-danger">
      {text}
    </Text>
  );
}

/** The support email as a link that opens a new email to it; `className` sets its size. */
export function SupportEmail({ address, className }: { address: string; className: string }) {
  return (
    <Text
      accessibilityRole="link"
      onPress={() => void Linking.openURL(`mailto:${address}`)}
      className={`${className} font-medium text-primary underline`}
    >
      {address}
    </Text>
  );
}

type ButtonProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** Shows a spinner in place of the label, and takes no taps. */
  busy?: boolean;
  variant?: "primary" | "text";
};

/** The primary button (52 high) and the text button (48 high) of the design system. */
export function Button({ label, onPress, disabled = false, busy = false, variant = "primary" }: ButtonProps) {
  const off = disabled || busy;
  const primary = variant === "primary";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: off, busy }}
      disabled={off}
      onPress={onPress}
      className={
        primary
          ? `h-[52px] items-center justify-center rounded-button px-4 ${off && !busy ? "bg-disabled-bg" : "bg-primary active:bg-primary-pressed"}`
          : "min-h-12 items-center justify-center rounded-button px-4 active:bg-primary-subtle"
      }
    >
      {busy ? (
        <ActivityIndicator className={primary ? "text-on-primary" : "text-primary"} />
      ) : (
        <Text
          className={`text-label font-medium tabular-nums ${off ? "text-disabled-text" : primary ? "text-on-primary" : "text-primary"}`}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}
