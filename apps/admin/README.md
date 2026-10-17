# @ygo/admin

Admin web (ADR-0006): Vite, React, React Router and Tailwind over `@ygo/tokens`, built to static files. For now it shows the server's health answer.

## Run it locally

1. Start the server: see `apps/server/README.md`. It listens on `127.0.0.1:3000`.
2. Start admin:

   ```sh
   pnpm --filter @ygo/admin dev
   ```

3. Open the URL Vite prints. The page shows "ok", or the status and machine code the server answered, or "The server cannot be reached."

## How it reaches the API

The client calls `${VITE_API_BASE_URL}/v1/…` through `@ygo/api-client`.

- **Development:** leave `VITE_API_BASE_URL` unset. The page calls its own origin, and the Vite dev server proxies `/v1` to `http://127.0.0.1:3000` (`vite.config.ts`). One origin means no CORS setup on the server.
- **Production build:** set `VITE_API_BASE_URL` to the API's origin when running `pnpm --filter @ygo/admin build`. Vite writes it into the bundle at build time, so it is public: never put a secret in a `VITE_` variable.

## Colours

Only token roles, such as `bg-surface` and `text-muted`. `@ygo/tokens/tailwind` replaces Tailwind's palette, so a literal colour class does not exist.
