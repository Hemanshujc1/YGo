import { colors, type ColorRoleName } from "./colors";
import { radii } from "./layout";
import { fontFamily, fontSizes, fontWeights } from "./typography";

const roles = Object.keys(colors) as ColorRoleName[];

const variables = (theme: "light" | "dark") =>
  Object.fromEntries(roles.map((role) => [`--ygo-${role}`, colors[role][theme]]));
const pixels = (values: Record<string, number>) =>
  Object.fromEntries(Object.entries(values).map(([name, value]) => [name, `${value}px`]));

/**
 * The Tailwind plugin each web app loads with `@plugin "@ygo/tokens/tailwind";`.
 * It replaces Tailwind's palette with the colour roles, so `bg-surface` exists
 * and `bg-red-500` does not, and swaps in the dark values when the system
 * theme is dark. `data-theme="light"` or `"dark"` on `<html>` overrides the
 * system theme (Admin's picker, #263); without it the system decides.
 */
export default {
  handler({ addBase }: { addBase: (css: Record<string, unknown>) => void }) {
    addBase({
      ":root": { "color-scheme": "light dark", ...variables("light") },
      "@media (prefers-color-scheme: dark)": { ":root": variables("dark") },
      // The attribute selector outranks the plain `:root` above, inside the media query too.
      ':root[data-theme="light"]': { "color-scheme": "light", ...variables("light") },
      ':root[data-theme="dark"]': { "color-scheme": "dark", ...variables("dark") },
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
      extend: {
        fontFamily: { sans: [fontFamily, "ui-sans-serif", "system-ui", "sans-serif"] },
        fontWeight: fontWeights,
        fontSize: fontSizes,
        borderRadius: pixels(radii),
      },
    },
  },
};
