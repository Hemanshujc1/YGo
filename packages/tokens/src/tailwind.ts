import { colors, type ColorRoleName } from "./colors";

const roles = Object.keys(colors) as ColorRoleName[];

const variables = (theme: "light" | "dark") =>
  Object.fromEntries(roles.map((role) => [`--ygo-${role}`, colors[role][theme]]));

/**
 * The Tailwind plugin each web app loads with `@plugin "@ygo/tokens/tailwind";`.
 * It replaces Tailwind's palette with the colour roles, so `bg-surface` exists
 * and `bg-red-500` does not, and swaps in the dark values when the system
 * theme is dark.
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
      colors: Object.fromEntries(roles.map((role) => [role, `var(--ygo-${role})`])),
    },
  },
};
