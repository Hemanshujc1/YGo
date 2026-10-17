# @ygo/web

The public website (ADR-0006): Vite, React and Tailwind over `@ygo/tokens`, built to static files. For now it is one placeholder page; the landing, privacy policy, terms, account-deletion and support pages come with their own tickets.

```sh
pnpm --filter @ygo/web dev     # local server
pnpm --filter @ygo/web build   # static files in dist/
```

Colours are token roles only, such as `bg-bg` and `text-muted`; `@ygo/tokens/tailwind` replaces Tailwind's palette.
