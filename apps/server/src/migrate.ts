// Explicit deployment command; the API never imports or invokes it.
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { loadDatabaseUrl } from "./config";
import { connectDatabase } from "./db";

const database = connectDatabase(loadDatabaseUrl());
try {
  await migrate(database.db, {
    migrationsFolder: fileURLToPath(new URL("./migrations", import.meta.url)),
  });
} finally {
  await database.close();
}
