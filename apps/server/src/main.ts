import { createIdentityVerifier } from "./adapters/identity-verifier";
import { createS3FileStorage } from "./adapters/file-storage";
import { createVisitPhotoStorage } from "./adapters/visit-photos";
import { buildApp } from "./app";
import { createMailpitMailer, createSesMailer } from "./adapters/mailer";
import { createGooglePlaceFinder } from "./adapters/place-finder";
import { createProductImageStorage, createS3ProductImageClient } from "./adapters/product-images";
import { createExpoPushSender, type PushSender } from "./adapters/push-sender";
import { loadConfig } from "./config";
import { connectDatabase } from "./db";
import { sendDuePushes } from "./notifications";

const config = loadConfig();
const mailer = config.MAILER === "ses"
  ? createSesMailer(config.MAIL_FROM, config.AWS_REGION)
  : createMailpitMailer(config.MAIL_FROM, config.MAILPIT_URL);
const database = connectDatabase(config.DATABASE_URL);
const imageBaseUrl = config.PRODUCT_IMAGE_LOCAL_BASE_URL ?? (config.PRODUCT_IMAGE_CLOUDFRONT_DOMAIN
  ? `https://${config.PRODUCT_IMAGE_CLOUDFRONT_DOMAIN}`
  : undefined);
const productImages = config.PRODUCT_IMAGE_BUCKET && imageBaseUrl
  ? createProductImageStorage({
    client: createS3ProductImageClient({ region: config.S3_REGION, endpoint: config.S3_ENDPOINT }),
    bucket: config.PRODUCT_IMAGE_BUCKET,
    imageBaseUrl,
  })
  : undefined;
const clock = { now: () => new Date() };
const app = buildApp({
  checkDatabase: database.ping,
  database,
  mailer,
  identityVerifier: createIdentityVerifier({
    google: config.GOOGLE_CLIENT_IDS.split(",").map((id) => id.trim()).filter(Boolean),
    apple: config.APPLE_CLIENT_IDS.split(",").map((id) => id.trim()).filter(Boolean),
  }, clock),
  clock,
  authTokenSecret: config.AUTH_TOKEN_SECRET,
  adminCookieDomain: config.ADMIN_COOKIE_DOMAIN,
  productImages,
  visitPhotos: config.VISIT_PHOTO_BUCKET ? createVisitPhotoStorage(createS3FileStorage({
    bucket: config.VISIT_PHOTO_BUCKET, region: config.S3_REGION, endpoint: config.S3_ENDPOINT,
  })) : undefined,
  places: config.GOOGLE_PLACES_API_KEY ? createGooglePlaceFinder(config.GOOGLE_PLACES_API_KEY) : undefined,
  minAppVersions: { customer: config.MIN_CUSTOMER_VERSION, shopkeeper: config.MIN_SHOPKEEPER_VERSION },
  syncMaxAgeSeconds: config.SYNC_MAX_AGE_SECONDS,
  syncClockSkewSeconds: config.SYNC_CLOCK_SKEW_SECONDS,
  counterBillVoidSeconds: config.COUNTER_BILL_VOID_SECONDS,
  logger: { level: config.LOG_LEVEL },
});

// An idle client losing its connection must not crash the process.
database.pool.on("error", (err) => app.log.error({ err }, "idle database client failed"));
app.addHook("onClose", () => database.close());

// The push queue is worked every few seconds; a run still sending when the next starts skips the rows it holds (#505).
const pushSender: PushSender = config.PUSH_SENDER === "expo" ? createExpoPushSender() : {
  async send(pushes) {
    app.log.info({ pushes }, "push not sent: PUSH_SENDER is local");
    return pushes.map(() => "sent" as const);
  },
};
const pushLoop = setInterval(() => {
  sendDuePushes(database.pool, pushSender, clock.now()).catch((err: unknown) => app.log.error({ err }, "push sending failed"));
}, 5_000);
app.addHook("onClose", () => clearInterval(pushLoop));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void app.close());
}

await app.listen({ host: config.HOST, port: config.PORT });
