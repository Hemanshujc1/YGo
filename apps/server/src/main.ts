import { buildApp } from "./app";
import { createMailpitMailer, createSesMailer } from "./adapters/mailer";
import { createAwsProductImageStorage } from "./adapters/product-images";
import { loadConfig } from "./config";
import { connectDatabase } from "./db";

const config = loadConfig();
const mailer = config.MAILER === "ses"
  ? createSesMailer(config.MAIL_FROM, config.AWS_REGION)
  : createMailpitMailer(config.MAIL_FROM, config.MAILPIT_URL);
const database = connectDatabase(config.DATABASE_URL);
const productImages = config.PRODUCT_IMAGE_BUCKET && config.PRODUCT_IMAGE_CLOUDFRONT_DOMAIN
  ? createAwsProductImageStorage({
    bucket: config.PRODUCT_IMAGE_BUCKET,
    cloudFrontDomain: config.PRODUCT_IMAGE_CLOUDFRONT_DOMAIN,
    region: config.S3_REGION,
    endpoint: config.S3_ENDPOINT,
  })
  : undefined;
const app = buildApp({
  checkDatabase: database.ping,
  database,
  mailer,
  clock: { now: () => new Date() },
  authTokenSecret: config.AUTH_TOKEN_SECRET,
  adminCookieDomain: config.ADMIN_COOKIE_DOMAIN,
  productImages,
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
