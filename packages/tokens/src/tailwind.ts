import { colors, type ColorRoleName } from "./colors";

const roles = Object.keys(colors) as ColorRoleName[];

const variables = (theme: "light" | "dark") =>
  Object.fromEntries(roles.map((role) => [`--ygo-${role}`, colors[role][theme]]));

/**
 * The Tailwind plugin each web app loads with `@plugin "@ygo/tokens/tailwind";`.
 * It replaces Tailwind's palette with the colour roles, so `bg-surface` exists
 * and `bg-red-500` does not, and swaps in the dark values when the system
 * theme is dark. The per-account theme override (CONTEXT.md) adds a selector
 * and Tailwind's `dark` variant here, in the ticket that builds it.
 */
export default {
  handler({ addBase }: { addBase: (css: Record<string, unknown>) => void }) {
    addBase({
      ":root": { "color-scheme": "light dark", ...variables("light") },
      "@media (prefers-color-scheme: dark)": { ":root": variables("dark") },
    });
  },
  config: {
    theme: {
      colors: {
        // CSS keywords, not colours: kept so `bg-transparent` and `border-current` still work.
        transparent: "transparent",
        current: "currentColor",
        inherit: "inherit",
        ...Object.fromEntries(roles.map((role) => [role, `var(--ygo-${role})`])),
      },
    },
  },
};
