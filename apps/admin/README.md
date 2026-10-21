# @ygo/admin

Admin web (ADR-0006): a static Vite and React app. Admin access tokens stay in memory. The server rotates the refresh cookie, and the client refreshes only when a protected request needs an access token. The server enforces the 30-minute idle limit.

## Run locally

Start the API and Mailpit as described in `apps/server/README.md`, then run `pnpm --filter @ygo/admin dev`. The app calls `/v1` on its own origin; Vite proxies those calls to the local API at `127.0.0.1:3000`. Set `YGO_ADMIN_DEV_API_TARGET=http://127.0.0.1:3184` when using a separate local API port. In production, Nginx must serve `/v1` under the Admin hostname and proxy it to the API. The server has no CORS setup, so a separate API hostname will not work for browser cookie requests.

Only an existing Admin can request a usable Admin sign-in code. A code request shows the same answer for Admin and non-Admin email addresses. The first Admin is made by the deployment bootstrap command; see `apps/server/README.md`.

## Font

`src/fonts/InterVariable.woff2` is Inter v4.1 from [the Inter project](https://github.com/rsms/inter/tree/v4.1/docs/font-files), bundled with its SIL Open Font License in `src/fonts/LICENSE.txt`. It includes U+20B9 (₹) and OpenType tabular figures. Admin web uses only weights 400, 500 and 600.
