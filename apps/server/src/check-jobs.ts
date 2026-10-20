import { publishJobHealth } from "./adapters/job-metrics";
import { loadDatabaseUrl } from "./config";
import { connectDatabase, type Database } from "./db";
import { checkJobs } from "./job-check";

let database: Database | undefined;
try {
  database = connectDatabase(loadDatabaseUrl());
  const healthy = await checkJobs(database, { now: () => new Date() }, publishJobHealth);
  if (!healthy) {
    console.error("One or more YGo jobs are unhealthy");
    process.exitCode = 1;
  }
} catch {
  // On a database failure, emit 0 for every job; if AWS fails, missing data breaches.
  console.error("Job health check could not load the database or publish every metric");
  process.exitCode = 1;
} finally {
  await database?.close();
}
