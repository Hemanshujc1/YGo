import { buildApp } from "./app";
import { loadConfig } from "./config";
import { connectDatabase } from "./db";

const config = loadConfig();
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
