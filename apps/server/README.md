# @ygo/server

The one Fastify service on Node 26 (ADR-0004). It reads its configuration from environment variables only (ADR-0008) and runs no migration on boot.

## Run it locally

You need Docker (Docker Desktop or OrbStack) for the database and local email inbox.

1. Start PostgreSQL 17 with PostGIS (ADR-0005):

   ```sh
   docker run -d --name ygo-postgres --platform linux/amd64 \
     -e POSTGRES_USER=ygo -e POSTGRES_PASSWORD=ygo -e POSTGRES_DB=ygo \
     -p 5432:5432 -v ygo-postgres:/var/lib/postgresql/data \
     postgis/postgis:17-3.5
   ```

   The official PostGIS image is built for Intel only, so on an Apple Silicon Mac it runs under emulation. That is slower to start and fine for development. The `ygo-postgres` volume keeps the data when the container is removed.

2. Start Mailpit. Its HTTP API and inbox are available only on your machine:

   ```sh
   docker run -d --name ygo-mailpit -p 127.0.0.1:8025:8025 axllent/mailpit
   ```

   Open http://localhost:8025 to see messages. The server sends to Mailpit's HTTP API; no SMTP port is needed.

3. Copy the example configuration. `.env` is git-ignored; never commit it.

   ```sh
   cp apps/server/.env.example apps/server/.env
   ```

4. Start the server with reload on save:

   ```sh
   pnpm --filter @ygo/server dev
   ```

5. Check it:

   ```sh
   curl http://127.0.0.1:3000/v1/healthz
   # {"status":"ok"}
   ```

   With the database stopped (`docker stop ygo-postgres`) the same request answers `503` with `{"error":{"code":"UNAVAILABLE"}}`.

6. Smoke-test delivery from a small script in another terminal, then open the Mailpit inbox:

   ```sh
   pnpm --filter @ygo/server exec tsx -e 'import { createMailpitMailer } from "./src/adapters/mailer.ts"; createMailpitMailer("ygo@example.invalid", "http://localhost:8025").send({ to: "test@example.invalid", subject: "YGo Mailpit smoke test", text: "Local delivery works." }).catch((error) => { console.error(error); process.exitCode = 1; })'
   ```

## Configuration

| Variable | Required | Default |
| --- | --- | --- |
| `DATABASE_URL` | yes | none; a `postgres://` URL |
| `AUTH_TOKEN_SECRET` | yes | none; at least 32 bytes, used to sign access tokens and hash codes/tokens |
| `MAILER` | yes | `ses` or `mailpit`; no console sender |
| `MAIL_FROM` | yes | sender email address for both providers |
| `MAILPIT_URL` | with `MAILER=mailpit` | Mailpit HTTP base URL, e.g. `http://localhost:8025` |
| `AWS_REGION` | with `MAILER=ses` | `ap-south-1` for the YGo deployment |
| `HOST` | no | `127.0.0.1` |
| `PORT` | no | `3000` |
| `LOG_LEVEL` | no | `info` |
| `MIN_CUSTOMER_VERSION` | no | `0.0.0`; an older Customer app gets `426 UPDATE_REQUIRED` |
| `MIN_SHOPKEEPER_VERSION` | no | `0.0.0`; an older Shopkeeper app gets `426 UPDATE_REQUIRED` |

The process refuses to start when one is missing or malformed.

Generate a local secret with `openssl rand -hex 32` and put it in the ignored `.env` file. Use a different random value in each deployment environment; Parameter Store holds it as part of the SecureString environment document.

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

`pnpm --filter @ygo/server build` writes standalone ESM bundles (`dist/main.js`, `dist/migrate.js` and `dist/job.js`), source maps, migrations and ESM metadata. Dependencies are included; the host needs Node 26 only. `pnpm --filter @ygo/server start` runs the API. Apply migrations explicitly with `DATABASE_URL=… node apps/server/dist/migrate.js` before deployment. See [the provisioning runbook](../../docs/operations/provisioning.md).

After migration, the one-shot command `node apps/server/dist/job.js cleanup-sessions` runs cleanup; `backup-nightly` and `snapshot-weekly` invoke the #130 backup script and need `BACKUP_BUCKET` and `RDS_INSTANCE_ID`, respectively, in their host environment. Each run records `ok` or `failed` in `job_runs` and exits non-zero on failure. An unknown name exits non-zero without writing a row. `node apps/server/dist/check-jobs.js` checks all three jobs and publishes their health metrics. See [timed jobs](../../docs/operations/timed-jobs.md) for production environment files, timers and alarms.

## Errors

Every non-2xx response is the `ErrorEnvelope` from `@ygo/contracts`: `{"error":{"code":"…"}}`, a machine code and no display text. Each client maps the code to its own words.
