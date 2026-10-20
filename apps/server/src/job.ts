import { loadDatabaseUrl } from "./config";
import { connectDatabase, type Database } from "./db";
import { isJobName, runJob } from "./jobs";
import { runNightlyBackup } from "./adapters/backup";

const name = process.argv[2];
if (!name || !isJobName(name) || process.argv.length !== 3) {
  console.error("Unknown job name");
  process.exitCode = 1;
} else {
  let database: Database | undefined;
  try {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is missing");
    database = connectDatabase(loadDatabaseUrl());
    await runJob(database, name, { now: () => new Date() }, runNightlyBackup);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const databaseUrl = process.env.DATABASE_URL;
    console.error(`${name} failed: ${databaseUrl ? message.replaceAll(databaseUrl, "[redacted]") : message}`);
    process.exitCode = 1;
  } finally {
    await database?.close();
  }
}
