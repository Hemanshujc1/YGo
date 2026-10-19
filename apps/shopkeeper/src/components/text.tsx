import { Text as NativeText, type TextProps } from "react-native";

/** React Native's Text set in Inter. Text in React Native inherits no font, so every screen uses this one. */
export function Text({ className, ...props }: TextProps) {
  return <NativeText className={`font-sans ${className ?? ""}`} {...props} />;
}
