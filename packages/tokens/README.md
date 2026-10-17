# @ygo/tokens

The semantic colour, type and shape roles from `docs/design/design-system.md`. Screens name a token, never a literal value (ADR-0001, ADR-0006).

- `colors` (`.`): the roles as data, for any consumer.
- `fontFamily`, `fontWeights`, `fontSizes` and `radii` (`.`): the design-system values as data. Spacing is Tailwind's own scale (`p-1` is 4 px, `p-4` is 16 px), which is already the design system's 4-point scale.
- `@ygo/tokens/tailwind`: the Tailwind plugin for the web apps. It writes each role as a `--ygo-<role>` CSS variable, switching to the dark values under `prefers-color-scheme: dark`, and replaces Tailwind's palette with the roles:

  ```css
  @import "tailwindcss";
  @plugin "@ygo/tokens/tailwind";
  ```

  Then `bg-surface`, `text-muted` and `border-border-strong` work, and `bg-white` or `text-red-500` do not exist.
