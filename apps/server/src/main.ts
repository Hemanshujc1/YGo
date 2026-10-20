import { buildApp } from "./app";
import { createMailpitMailer, createSesMailer } from "./adapters/mailer";
import { loadConfig } from "./config";
import { connectDatabase } from "./db";

const config = loadConfig();
// Construct the configured adapter now; routes start using it in #34.
const mailer = config.MAILER === "ses"
  ? createSesMailer(config.MAIL_FROM, config.AWS_REGION)
  : createMailpitMailer(config.MAIL_FROM, config.MAILPIT_URL);
void mailer;
const database = connectDatabase(config.DATABASE_URL);
const app = buildApp({
  checkDatabase: database.ping,
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
