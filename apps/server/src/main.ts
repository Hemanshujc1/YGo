import { createIdentityVerifier } from "./adapters/identity-verifier";
import { createS3FileStorage } from "./adapters/file-storage";
import { createVisitPhotoStorage } from "./adapters/visit-photos";
import { createDeliveryPhotoStorage } from "./adapters/delivery-photos";
import { buildApp } from "./app";
import { createMailpitMailer, createSesMailer } from "./adapters/mailer";
import { createGooglePlaceFinder } from "./adapters/place-finder";
import { createProductImageStorage, createS3ProductImageClient } from "./adapters/product-images";
import { createExpoPushSender, createLoggingPushSender } from "./adapters/push-sender";
import { loadConfig } from "./config";
import { connectDatabase } from "./db";
import { setOrderTiming } from "./order-timing";
import { checkPushReceipts, sendDuePushes } from "./notifications";

const config = loadConfig();
setOrderTiming({
  reRingSeconds: config.ORDER_REALERT_SECONDS,
  expireSeconds: config.ORDER_EXPIRE_SECONDS,
  confirmSeconds: config.ORDER_CONFIRM_SECONDS,
});
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
  deliveryPhotos: config.VISIT_PHOTO_BUCKET ? createDeliveryPhotoStorage(createS3FileStorage({
    bucket: config.VISIT_PHOTO_BUCKET, region: config.S3_REGION, endpoint: config.S3_ENDPOINT,
  })) : undefined,
  places: config.GOOGLE_PLACES_API_KEY ? createGooglePlaceFinder(config.GOOGLE_PLACES_API_KEY) : undefined,
  minAppVersions: { customer: config.MIN_CUSTOMER_VERSION, shopkeeper: config.MIN_SHOPKEEPER_VERSION },
  syncMaxAgeSeconds: config.SYNC_MAX_AGE_SECONDS,
  syncClockSkewSeconds: config.SYNC_CLOCK_SKEW_SECONDS,
  counterBillVoidSeconds: config.COUNTER_BILL_VOID_SECONDS,
  deliveryFailureWaitSeconds: config.DELIVERY_FAILURE_WAIT_SECONDS,
  logger: { level: config.LOG_LEVEL },
});

// An idle client losing its connection must not crash the process.
database.pool.on("error", (err) => app.log.error({ err }, "idle database client failed"));

// The push queue is worked every few seconds, one run at a time, and stops before the database closes (#505).
const pushSender = config.PUSH_SENDER === "expo"
  ? createExpoPushSender()
  : createLoggingPushSender((pushes) => app.log.info({ pushes }, "push not sent: PUSH_SENDER is local"));
let pushRun: Promise<void> = Promise.resolve();
let pushTimer: NodeJS.Timeout | undefined;
const workPushQueue = () => {
  pushRun = sendDuePushes(database.pool, pushSender, clock.now())
    .catch((err: unknown) => app.log.error({ err }, "push sending failed"))
    .then(() => checkPushReceipts(database.pool, pushSender, clock.now()))
    .catch((err: unknown) => app.log.error({ err }, "push receipts failed"))
    .finally(() => { if (pushTimer) pushTimer = setTimeout(workPushQueue, 5_000); });
};
pushTimer = setTimeout(workPushQueue, 5_000);
app.addHook("onClose", async () => {
  clearTimeout(pushTimer);
  pushTimer = undefined;
  await pushRun;
  await database.close();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void app.close());
}

await app.listen({ host: config.HOST, port: config.PORT });
