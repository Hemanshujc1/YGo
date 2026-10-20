import { and, desc, eq, ne } from "drizzle-orm";
import type { Clock } from "./adapters/clock";
import type { Database } from "./db";
import { jobMaxAgeHours, type JobName } from "./jobs";
import { jobRuns } from "./schema";

export async function checkJobs(
  database: Database,
  clock: Clock,
  publish: (name: JobName, healthy: boolean) => Promise<void>,
): Promise<boolean> {
  let allHealthy = true;
  let publishFailed = false;
  for (const name of Object.keys(jobMaxAgeHours) as JobName[]) {
    let healthy = false;
    try {
      const [latest] = await database.db.select().from(jobRuns)
        .where(and(eq(jobRuns.jobName, name), ne(jobRuns.status, "running")))
        .orderBy(desc(jobRuns.finishedAt)).limit(1);
      const [success] = await database.db.select().from(jobRuns)
        .where(and(eq(jobRuns.jobName, name), eq(jobRuns.status, "ok")))
        .orderBy(desc(jobRuns.finishedAt)).limit(1);
      const age = success?.finishedAt && clock.now().getTime() - success.finishedAt.getTime();
      healthy = latest?.status !== "failed" && age !== null && age !== undefined &&
        age >= 0 && age <= jobMaxAgeHours[name] * 60 * 60 * 1000;
    } catch {
      // An unreadable database must publish unhealthy for this and every other job.
    }
    if (!healthy) allHealthy = false;
    try {
      await publish(name, healthy);
    } catch {
      publishFailed = true;
    }
  }
  if (publishFailed) throw new Error("Could not publish every job health metric");
  return allHealthy;
}
