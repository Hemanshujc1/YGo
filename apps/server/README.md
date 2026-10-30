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

## Local product images

For Admin product image testing without AWS, start SeaweedFS as a local S3-compatible store:

```sh
docker run -d --name ygo-s3 -p 127.0.0.1:8333:8333 -v ygo-s3:/data \
  chrislusf/seaweedfs:4.48 server -dir=/data -s3 -s3.port=8333 -ip.bind=0.0.0.0
```

With AWS CLI installed, create the bucket once. SeaweedFS starts in its development allow-all mode when no S3 credentials are configured on the SeaweedFS process; the application can use the placeholder credentials below, and browser image requests are anonymous. See the [SeaweedFS S3 credentials documentation](https://github.com/seaweedfs/seaweedfs/wiki/S3-Credentials#anonymous-access).

```sh
AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local-secret \
  aws --endpoint-url http://127.0.0.1:8333 s3 mb s3://ygo-product-images
```

In `apps/server/.env`, set `PRODUCT_IMAGE_BUCKET=ygo-product-images`, `S3_ENDPOINT=http://127.0.0.1:8333`, `AWS_ACCESS_KEY_ID=local`, and `AWS_SECRET_ACCESS_KEY=local-secret`. Set `PRODUCT_IMAGE_LOCAL_BASE_URL=http://127.0.0.1:8333/ygo-product-images`; it includes the bucket path so the 256, 512 and 1024 WebP URLs load directly from SeaweedFS. Leave `PRODUCT_IMAGE_CLOUDFRONT_DOMAIN` unset. The local URL setting requires `S3_ENDPOINT`; deployments without it continue to use the CloudFront hostname.

## Configuration

| Variable | Required | Default |
| --- | --- | --- |
| `DATABASE_URL` | yes | none; a `postgres://` URL |
| `AUTH_TOKEN_SECRET` | yes | none; at least 32 bytes, used to sign access tokens and hash codes/tokens |
| `GOOGLE_CLIENT_IDS` | no | empty; comma-separated permitted Google Web OAuth client IDs |
| `APPLE_CLIENT_IDS` | no | empty; comma-separated permitted native Apple bundle identifiers |
| `ADMIN_COOKIE_DOMAIN` | no | host-only locally; set to the registrable domain for Admin web deployment |
| `MAILER` | yes | `ses` or `mailpit`; no console sender |
| `MAIL_FROM` | yes | sender email address for both providers |
| `MAILPIT_URL` | with `MAILER=mailpit` | Mailpit HTTP base URL, e.g. `http://localhost:8025` |
| `AWS_REGION` | with `MAILER=ses` | `ap-south-1` for the YGo deployment |
| `PRODUCT_IMAGE_BUCKET` | with product image storage | bucket name; set with a CloudFront domain or local image base URL |
| `PRODUCT_IMAGE_CLOUDFRONT_DOMAIN` | with product image storage | CloudFront distribution hostname, without a scheme |
| `PRODUCT_IMAGE_LOCAL_BASE_URL` | with local S3-compatible storage | HTTP(S) image base URL including the bucket path; requires `S3_ENDPOINT` and replaces CloudFront for local image URLs |
| `S3_REGION` | no | `ap-south-1` |
| `S3_ENDPOINT` | no | unset for AWS; set for an S3-compatible endpoint |
| `HOST` | no | `127.0.0.1` |
| `PORT` | no | `3000` |
| `LOG_LEVEL` | no | `info` |
| `MIN_CUSTOMER_VERSION` | no | `0.0.0`; an older Customer app gets `426 UPDATE_REQUIRED` |
| `SYNC_MAX_AGE_SECONDS` | no | `604800` (7 days); oldest new sync action accepted |
| `SYNC_CLOCK_SKEW_SECONDS` | no | `300` (5 minutes); clock differences beyond this are flagged |
| `MIN_SHOPKEEPER_VERSION` | no | `0.0.0`; an older Shopkeeper app gets `426 UPDATE_REQUIRED` |

The process refuses to start when one is missing or malformed.

Admin web calls `/v1` through the same-origin proxy. Its refresh cookie is `HttpOnly`, `Secure`, `SameSite=Strict` and limited to `/v1/admin/auth`; the browser sends `x-ygo-admin-refresh: 1` on refresh and sign-out. The server keeps Admin web sessions separate from mobile sessions and expires them after 30 minutes without refresh.

Generate a local secret with `openssl rand -hex 32` and put it in the ignored `.env` file. Use a different random value in each deployment environment; Parameter Store holds it as part of the SecureString environment document.

## Tests

`pnpm --filter @ygo/server test` (and `pnpm gate`) needs the database from step 1 running. Each run creates its own database, `ygo_test_<random>`, applies the migrations to it and drops it at the end, so runs never share data and two worktrees can test at once. A run that is killed can leave its database behind; drop it by hand.

The tests connect to `postgres://ygo:ygo@localhost:5432/ygo`, the container above, to create that database. Point them elsewhere with `TEST_DATABASE_URL`. Its role must be able to create databases and the `postgis` extension, which is not a trusted extension: in practice a superuser, as the container's `ygo` is. CI sets it to its own PostGIS service. With no database reachable, the run stops within seconds with an error naming the address and the reason.

The outside services are interfaces in `src/adapters/`, each with a local implementation for the tests: `FileStorage`, `Mailer`, `IdentityVerifier`, `PushSender`, `SmsSender` and `Clock`. Product image storage accepts an injected write interface so tests use a recording fake. The local `Clock` stands still until a test sets or advances it. Only `src/adapters/` may import `@aws-sdk/*` (ADR-0008).

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

## First Admin

After applying migrations, run `DATABASE_URL=… node apps/server/dist/bootstrap-admin.js --email admin@example.com --name "Asha Kulkarni" --phone +919876543210` once. Supply the connection URL through the environment, not an argument. The command checks the shared email, name and phone rules, refuses duplicate account details, and writes the account, separate Admin membership and `admin.bootstrap` action in one serialized transaction. It prints no personal details. If an Admin already exists, use Admin web to add another. Once a bootstrap action exists, this command can never be reused, even after all memberships are removed; recovery requires a separate, deliberate procedure.

Admin action records are append-only. PostgreSQL rejects update, delete and truncate, requires a non-empty reason, and reserves the null actor and fixed reason for `admin.bootstrap`. Actor and target UUIDs intentionally have no account foreign keys so their identifiers survive account deletion or anonymization. PostgreSQL validates their UUID format but does not enforce their referential integrity.

## Errors

Every non-2xx response is the `ErrorEnvelope` from `@ygo/contracts`: `{"error":{"code":"…"}}`, a machine code and no display text. Each client maps the code to its own words.

## Google and Apple sign-in

Follow the [step-by-step provider setup guide](../../docs/operations/social-sign-in.md), including local migration, app configuration and device checks.

### Private visit photos (#320)

Set `VISIT_PHOTO_BUCKET` to a dedicated **private** bucket. It reuses
`S3_REGION` and optional `S3_ENDPOINT`; it must differ from
`PRODUCT_IMAGE_BUCKET` and has no public URL base. AWS credentials use the
SDK's normal credential chain. The route integration is tracked in #322:
create `createS3FileStorage({ bucket, region, endpoint })` with these settings,
pass it to `createVisitPhotoStorage(files)`, authorize the Admin, and resolve the
upload ID or evidence key from the application's own records before calling it.
Record the declared byte length when creating the upload and pass that trusted
value to `validate(uploadId, declaredByteLength)`; never take a new size from
the validation request.
Neither URLs nor storage keys come from request input.

`createUpload` signs a JPEG PUT for the exact declared size for 15 minutes.
`validate` downloads at most 10 MB, rejects bytes that differ from the recorded
declared size, decodes the JPEG and reads EXIF GPS from the
original. Missing/invalid GPS raises `VisitPhotoLocationMissingError`; invalid
image bytes raise `InvalidVisitPhotoError`. Capture time is preserved as the
camera's original text, or null. Validation writes the exact original to a
separate content-addressed evidence key. Persist that returned key; never save
the temporary upload key as evidence. Reusing an upload link cannot overwrite
previously recorded evidence. `downloadUrl` signs a GET for 5 minutes with
`private, no-store` caching. Upload and access URLs must be presigned HTTP(S);
the unsigned local `file:` adapter is rejected in every environment. Use
authenticated local S3 for development. Application authorization belongs in #322.

Privacy also requires storage configuration. For AWS, enable all S3 Block
Public Access settings, bucket-owner-enforced ownership, encryption and
versioning (see `docs/operations/provisioning.md`). Grant the server role
GetObject/PutObject only in this bucket; no public bucket policy, ACL or CDN.
Configure a lifecycle rule to expire `visit-uploads/` staging objects after one
day. Keep `visit-photos/` originals for the retention policy in CONTEXT.md;
do not apply the staging expiry to evidence. The storage adapter never sets a
public ACL.

The anonymous SeaweedFS command above is for public product images. Before
using visit photos with a local S3 service, configure its authentication and
bucket permissions. For SeaweedFS, write a local `s3.json` (keep it out of Git):

```json
{"identities":[{"name":"local-server","credentials":[{"accessKey":"local","secretKey":"local-secret"}],"actions":["Admin","Read","Write","List"]}]}
```

Mount it into the container with `-v "$PWD/s3.json:/etc/seaweedfs/s3.json:ro"`
and add `-s3.config=/etc/seaweedfs/s3.json` to the `server` arguments above.
This enables credential checks; do not add an anonymous identity. Create the
private bucket using the authenticated S3 API and set `VISIT_PHOTO_BUCKET`.
The example identity is for local development only.

Confirm a signed PUT and signed GET succeed, then remove
the signature and confirm both are denied. Also confirm an upload URL cannot
GET an object or PUT to an evidence key. Repeat these checks against the
provisioned bucket: URL parsing and adapter tests do not verify deployed bucket
permissions. Unit tests use a private S3 protocol fixture that independently
verifies the SigV4 signature, method, destination, size and content type.

ExifReader parses GPS and capture metadata because the installed Sharp exposes
raw EXIF rather than these fields. The AWS presigner signs the configured S3
endpoint; no installed dependency provided this operation. ExifReader's shipped
bundle needs no install script, so its optional custom-build script stays off.

## Ordered stock sync (#391)

`POST /v1/sync/actions` accepts up to 500 actions with a device ID and consecutive sequence numbers. Each result is applied, permanently rejected, or awaiting retry (a sequence gap or a reused ID). The authenticated Owner must still belong to each action's shop. A rejected action advances the sequence so independent work can continue. Shop writes and replay results commit together; acknowledged replays return their original result for 30 days. After replay expiry, the durable device sequence still prevents an old action from applying again. The older opening-stock endpoint remains supported and its original IDs are recognized by batch sync.

Clock-suspect actions remain accepted and have `clock_suspect` recorded in `sync_actions` for support/Admin inspection. Their age is measured relative to the batch's phone timestamp; other actions use server time. No client clock orders writes. Replay records expire on the account's next push; the device sequence is retained.
