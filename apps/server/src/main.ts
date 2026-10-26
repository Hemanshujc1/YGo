import { createIdentityVerifier } from "./adapters/identity-verifier";
import { buildApp } from "./app";
import { createMailpitMailer, createSesMailer } from "./adapters/mailer";
import { createGooglePlaceFinder } from "./adapters/place-finder";
import { createProductImageStorage, createS3ProductImageClient } from "./adapters/product-images";
import { loadConfig } from "./config";
import { connectDatabase } from "./db";

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
  places: config.GOOGLE_PLACES_API_KEY ? createGooglePlaceFinder(config.GOOGLE_PLACES_API_KEY) : undefined,
  minAppVersions: { customer: config.MIN_CUSTOMER_VERSION, shopkeeper: config.MIN_SHOPKEEPER_VERSION },
  logger: { level: config.LOG_LEVEL },
});

// An idle client losing its connection must not crash the process.
database.pool.on("error", (err) => app.log.error({ err }, "idle database client failed"));
app.addHook("onClose", () => database.close());

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void app.close());
}

await app.listen({ host: config.HOST, port: config.PORT });
