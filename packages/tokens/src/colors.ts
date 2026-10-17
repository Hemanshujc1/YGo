/** One semantic colour role: its value in the light theme and in the dark theme. */
export interface ColorRole {
  light: string;
  dark: string;
}

/**
 * Every colour role in docs/design/design-system.md section 2. Screens name a
 * role, never a value (rule 1 there); change a colour here and nowhere else.
 */
export const colors = {
  bg: { light: "#F6F9F9", dark: "#0D1A20" },
  surface: { light: "#FFFFFF", dark: "#14262D" },
  raised: { light: "#FFFFFF", dark: "#1B313A" },
  sunken: { light: "#EBF1F1", dark: "#0A1418" },
  border: { light: "#D3DDDE", dark: "#29434C" },
  "border-strong": { light: "#7E9195", dark: "#6E8B93" },
  text: { light: "#0D1A20", dark: "#E7EFF1" },
  muted: { light: "#4B5D62", dark: "#9FB2B7" },
  primary: { light: "#0F766E", dark: "#2DD4BF" },
  "primary-pressed": { light: "#0B5D57", dark: "#22B3A1" },
  "on-primary": { light: "#FFFFFF", dark: "#0D1A20" },
  "primary-subtle": { light: "#E1F2EF", dark: "#0E3633" },
  "on-primary-subtle": { light: "#0B5D57", dark: "#7EEADB" },
  accent: { light: "#F59E0B", dark: "#F59E0B" },
  "on-accent": { light: "#0D1A20", dark: "#0D1A20" },
  "accent-stroke": { light: "#B45309", dark: "#F59E0B" },
  "accent-text": { light: "#8A4B05", dark: "#FBBF4D" },
  brand: { light: "#1E3A8A", dark: "#A9BBF5" },
  success: { light: "#166534", dark: "#5FD38D" },
  "success-subtle": { light: "#E3F3E8", dark: "#123224" },
  "on-success-subtle": { light: "#166534", dark: "#7FE0A6" },
  warning: { light: "#9A4A06", dark: "#FBBF4D" },
  "warning-subtle": { light: "#FDF0D5", dark: "#3A2A0C" },
  "on-warning-subtle": { light: "#7A3A05", dark: "#FCD37A" },
  danger: { light: "#B42318", dark: "#FF8A80" },
  "on-danger": { light: "#FFFFFF", dark: "#0D1A20" },
  "danger-subtle": { light: "#FDE9E7", dark: "#3B1A1A" },
  "on-danger-subtle": { light: "#9F1D14", dark: "#FFA49C" },
  info: { light: "#1D4ED8", dark: "#8DB0FF" },
  "info-subtle": { light: "#E5ECFD", dark: "#182B4D" },
  "on-info-subtle": { light: "#1E40AF", dark: "#A9C2FF" },
  pending: { light: "#465A82", dark: "#AEBCDB" },
  "pending-subtle": { light: "#E7ECF5", dark: "#1E2A40" },
  "on-pending-subtle": { light: "#3A4D73", dark: "#C0CCE6" },
  "neutral-subtle": { light: "#EBF1F1", dark: "#1B2E35" },
  "on-neutral-subtle": { light: "#4B5D62", dark: "#A9BBC0" },
  "disabled-bg": { light: "#E4EAEB", dark: "#1B2B31" },
  "disabled-text": { light: "#7D8B8E", dark: "#6B7F84" },
  inverse: { light: "#0D1A20", dark: "#E7EFF1" },
  "on-inverse": { light: "#E7EFF1", dark: "#0D1A20" },
  "inverse-action": { light: "#5EEAD4", dark: "#0F766E" },
  // 48% of #0D1A20 in light, 60% black in dark.
  scrim: { light: "rgb(13 26 32 / 0.48)", dark: "rgb(0 0 0 / 0.6)" },
} as const satisfies Record<string, ColorRole>;

export type ColorRoleName = keyof typeof colors;
