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
| `MIN_CUSTOMER_VERSION` | no | `0.0.0`; an older Customer app gets `426 UPDATE_REQUIRED` |
| `MIN_SHOPKEEPER_VERSION` | no | `0.0.0`; an older Shopkeeper app gets `426 UPDATE_REQUIRED` |

The process refuses to start when one is missing or malformed.

## Tests

`pnpm --filter @ygo/server test` (and `pnpm gate`) needs the database from step 1 running. Each run creates its own database, `ygo_test_<random>`, applies the migrations to it and drops it at the end, so runs never share data and two worktrees can test at once. A run that is killed can leave its database behind; drop it by hand.

The tests connect to `postgres://ygo:ygo@localhost:5432/ygo`, the container above, to create that database. Point them elsewhere with `TEST_DATABASE_URL`. Its role must be able to create databases and the `postgis` extension, which is not a trusted extension: in practice a superuser, as the container's `ygo` is. CI sets it to its own PostGIS service. With no database reachable, the run stops within seconds with an error naming the address and the reason.

The outside services are interfaces in `src/adapters/`, each with a local implementation for the tests: `FileStorage`, `Mailer`, `IdentityVerifier`, `PushSender`, `SmsSender` and `Clock`. The local `Clock` stands still until a test sets or advances it. Only `src/adapters/` may import `@aws-sdk/*` (ADR-0008).

## Migrations

Forward-only SQL in `migrations/`, written by drizzle-kit from `src/schema.ts` (ADR-0004):

```sh
pnpm --filter @ygo/server exec drizzle-kit generate            # from a schema change
pnpm --filter @ygo/server exec drizzle-kit generate --custom   # an empty file for hand-written SQL
```

The server never applies them on boot; the tests apply them to each run's database.

## Build

`pnpm --filter @ygo/server build` writes standalone ESM bundles (`dist/main.js` and `dist/migrate.js`), source maps, migrations and ESM metadata. Dependencies are included; the host needs Node 26 only. `pnpm --filter @ygo/server start` runs the API. Apply migrations explicitly with `DATABASE_URL=… node apps/server/dist/migrate.js` before deployment. See [the provisioning runbook](../../docs/operations/provisioning.md).

## Errors

Every non-2xx response is the `ErrorEnvelope` from `@ygo/contracts`: `{"error":{"code":"…"}}`, a machine code and no display text. Each client maps the code to its own words.
