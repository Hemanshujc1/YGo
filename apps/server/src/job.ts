import { loadDatabaseUrl } from "./config";
import { connectDatabase, type Database } from "./db";
import { isJobName, runJob } from "./jobs";

const name = process.argv[2];
if (!name || !isJobName(name) || process.argv.length !== 3) {
  console.error("Unknown job name");
  process.exitCode = 1;
} else {
  let database: Database | undefined;
  try {
    database = connectDatabase(loadDatabaseUrl());
    await runJob(database, name, { now: () => new Date() });
  } catch {
    console.error(`${name} failed`);
    process.exitCode = 1;
  } finally {
    await database?.close();
  }
}
