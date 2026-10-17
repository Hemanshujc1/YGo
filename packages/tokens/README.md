# @ygo/tokens

The semantic colour, type, spacing and shape roles from `docs/design/design-system.md`. Screens name a token, never a literal value (ADR-0001, ADR-0006).

- `colors` (`.`): the roles as data, for any consumer.
- `fontFamily`, `fontWeights`, `fontSizes`, `spacing` and `radii` (`.`): the design-system values as data.
- `@ygo/tokens/tailwind`: the Tailwind plugin for the web apps. It writes each role as a `--ygo-<role>` CSS variable, switching to the dark values under `prefers-color-scheme: dark`, and replaces Tailwind's palette with the roles:

  ```css
  @import "tailwindcss";
  @plugin "@ygo/tokens/tailwind";
  ```

  Then `bg-surface`, `text-muted` and `border-border-strong` work, and `bg-white` or `text-red-500` do not exist.
