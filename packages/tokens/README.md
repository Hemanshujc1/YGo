# @ygo/tokens

The semantic colour roles from section 2 of `docs/design/design-system.md`, each with a light and a dark value. Screens name a role, never a colour (ADR-0001, ADR-0006).

- `colors` (`.`): the roles as data, for any consumer.
- `@ygo/tokens/tailwind`: the Tailwind plugin for the web apps. It writes each role as a `--ygo-<role>` CSS variable, switching to the dark values under `prefers-color-scheme: dark`, and replaces Tailwind's palette with the roles:

  ```css
  @import "tailwindcss";
  @plugin "@ygo/tokens/tailwind";
  ```

  Then `bg-surface`, `text-muted` and `border-border-strong` work, and `bg-white` or `text-red-500` do not exist.
