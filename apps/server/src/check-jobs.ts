import { publishJobHealth } from "./adapters/job-metrics";
import { loadDatabaseUrl } from "./config";
import { connectDatabase, type Database } from "./db";
import { checkJobs } from "./job-check";
import { isJobName, jobMaxAgeHours, type JobName } from "./jobs";

// `check-jobs.js <job>` checks that one job (the every-5-minute expire-orders
// timer). With no argument it checks the daily jobs; expire-orders is left to its own timer.
const only = process.argv[2];
if (only !== undefined && !isJobName(only)) {
  console.error("Unknown job name");
  process.exit(2);
}
const names = only !== undefined ? [only as JobName]
  : (Object.keys(jobMaxAgeHours) as JobName[]).filter((name) => name !== "expire-orders");

let database: Database | undefined;
try {
  database = connectDatabase(loadDatabaseUrl());
  const healthy = await checkJobs(database, { now: () => new Date() }, publishJobHealth, names);
  if (!healthy) {
    console.error("One or more YGo jobs are unhealthy");
    process.exitCode = 1;
  }
} catch {
  // A missing/invalid URL publishes nothing; missing data breaches. Query failures publish 0.
  console.error("Job health check could not load the database or publish every metric");
  process.exitCode = 1;
} finally {
  await database?.close();
}
