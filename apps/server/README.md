# @ygo/server

The one Fastify service on Node 26 (ADR-0004). It reads its configuration from environment variables only (ADR-0008) and runs no migration on boot.

## Run it locally

You need Docker (Docker Desktop or OrbStack) for the database.

1. Start PostgreSQL 17 with PostGIS (ADR-0005):

   ```sh
   docker run -d --name ygo-postgres --platform linux/amd64 \
     -e POSTGRES_USER=ygo -e POSTGRES_PASSWORD=ygo -e POSTGRES_DB=ygo \
     -p 5432:5432 -v ygo-postgres:/var/lib/postgresql/data \
     postgis/postgis:17-3.5
   ```

   The official PostGIS image is built for Intel only, so on an Apple Silicon Mac it runs under emulation. That is slower to start and fine for development. The `ygo-postgres` volume keeps the data when the container is removed.

2. Copy the example configuration. `.env` is git-ignored; never commit it.

   ```sh
   cp apps/server/.env.example apps/server/.env
   ```

3. Start the server with reload on save:

   ```sh
   pnpm --filter @ygo/server dev
   ```

4. Check it:

   ```sh
   curl http://127.0.0.1:3000/v1/healthz
   # {"status":"ok"}
   ```

   With the database stopped (`docker stop ygo-postgres`) the same request answers `503` with `{"error":{"code":"UNAVAILABLE"}}`.

## Configuration

| Variable | Required | Default |
| --- | --- | --- |
| `DATABASE_URL` | yes | none; a `postgres://` URL |
| `HOST` | no | `127.0.0.1` |
| `PORT` | no | `3000` |
| `LOG_LEVEL` | no | `info` |

The process refuses to start when one is missing or malformed.

## Build

`pnpm --filter @ygo/server build` writes one bundled file, `dist/main.js`, with workspace packages and npm dependencies inside it. `pnpm --filter @ygo/server start` runs it.

## Errors

Every non-2xx response is the `ErrorEnvelope` from `@ygo/contracts`: `{"error":{"code":"…"}}`, a machine code and no display text. Each client maps the code to its own words.
