import type { ComponentType } from "react";
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

/**
 * The support email as a link that opens a new email to it; `className` sets
 * its size. A phone with no email app can't open it, so the address can also
 * be pressed and held to copy (#155, Q9).
 */
export function SupportEmail({ address, className }: { address: string; className: string }) {
  return (
    <Text
      selectable
      accessibilityRole="link"
      onPress={() => void Linking.openURL(`mailto:${address}`).catch(() => {})}
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
  variant?: "primary" | "secondary" | "text";
  /** A 20 px icon before the label, coloured like it: a Lucide icon the app has given `className` (C15, C03). */
  icon?: ComponentType<{ size?: number; className?: string }>;
  /** Puts the icon and label at the start, as on "Use my current location" (C15). */
  alignStart?: boolean;
};

const boxClass = {
  primary: "h-[52px] bg-primary active:bg-primary-pressed",
  secondary: "h-[52px] border border-border-strong bg-surface active:bg-primary-subtle",
  text: "min-h-12 active:bg-primary-subtle",
};

/** The primary and secondary buttons (52 high) and the text button (48 high) of the design system. */
export function Button({
  label,
  onPress,
  disabled = false,
  busy = false,
  variant = "primary",
  icon: Icon,
  alignStart = false,
}: ButtonProps) {
  const off = disabled || busy;
  const primary = variant === "primary";
  const colour = off ? "text-disabled-text" : primary ? "text-on-primary" : "text-primary";
  const box = off && !busy && variant !== "text" ? "h-[52px] bg-disabled-bg" : boxClass[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: off, busy }}
      disabled={off}
      onPress={onPress}
      className={`flex-row items-center gap-2 rounded-button px-4 ${alignStart ? "justify-start" : "justify-center"} ${box}`}
    >
      {busy ? (
        <ActivityIndicator className={primary ? "text-on-primary" : "text-primary"} />
      ) : (
        <>
          {Icon && <Icon size={20} className={colour} />}
          <Text className={`text-label font-medium tabular-nums ${colour}`}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}
