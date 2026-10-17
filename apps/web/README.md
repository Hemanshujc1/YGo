# @ygo/web

The public website (ADR-0006): Vite, React and Tailwind over `@ygo/tokens`, built to static files. It has the landing, privacy policy, terms and support pages, routed client-side by React Router; the account-deletion request page comes with #94. The privacy policy and terms show a marked placeholder until the launch checklist supplies the legal text (L-3), and `strings.supportEmail` is a placeholder until the domain is chosen (#27).

```sh
pnpm --filter @ygo/web dev     # local server
pnpm --filter @ygo/web build   # static files in dist/
```

Colours are token roles only, such as `bg-bg` and `text-muted`; `@ygo/tokens/tailwind` replaces Tailwind's palette.
