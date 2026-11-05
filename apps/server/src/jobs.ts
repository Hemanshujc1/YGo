import { and, desc, eq, isNotNull, lt, lte, ne, notInArray, or } from "drizzle-orm";
import type { Clock } from "./adapters/clock";
import type { Database } from "./db";
import { expireUnansweredOrders } from "./order-expiry";
import { jobRuns, refreshTokens, sessions } from "./schema";
import { REFRESH_TTL_MS } from "./tokens";

export const jobMaxAgeHours = { "backup-nightly": 26, "cleanup-sessions": 26, "expire-orders": 0.25, "snapshot-weekly": 8 * 24 } as const;
// Run history kept by cleanup-sessions (#520): the every-minute expire-orders job writes ~1,440 rows a day.
export const JOB_RUN_OK_KEEP_DAYS = 30;
export const JOB_RUN_FAILED_KEEP_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;
export type JobName = keyof typeof jobMaxAgeHours;

export function isJobName(name: string): name is JobName {
  return Object.hasOwn(jobMaxAgeHours, name);
}

// Deletes old job_runs rows. Per job it always keeps the latest finished row and the latest ok row,
// whatever their age: job-check.ts reads exactly those two. A running row only goes once it is
// older than the ok limit (a crashed run); a recent one may still be running.
export async function deleteOldJobRuns(database: Database, now: Date): Promise<void> {
  const okBefore = new Date(now.getTime() - JOB_RUN_OK_KEEP_DAYS * DAY_MS);
  const failedBefore = new Date(now.getTime() - JOB_RUN_FAILED_KEEP_DAYS * DAY_MS);
  await database.db.transaction(async (tx) => {
    for (const name of Object.keys(jobMaxAgeHours)) {
      const [latest] = await tx.select({ id: jobRuns.id }).from(jobRuns)
        .where(and(eq(jobRuns.jobName, name), ne(jobRuns.status, "running")))
        .orderBy(desc(jobRuns.finishedAt)).limit(1);
      const [success] = await tx.select({ id: jobRuns.id }).from(jobRuns)
        .where(and(eq(jobRuns.jobName, name), eq(jobRuns.status, "ok")))
        .orderBy(desc(jobRuns.finishedAt)).limit(1);
      const keep = [latest?.id, success?.id].filter((id): id is string => id !== undefined);
      await tx.delete(jobRuns).where(and(
        eq(jobRuns.jobName, name),
        keep.length > 0 ? notInArray(jobRuns.id, keep) : undefined,
        or(
          and(eq(jobRuns.status, "ok"), lt(jobRuns.finishedAt, okBefore)),
          and(eq(jobRuns.status, "failed"), lt(jobRuns.finishedAt, failedBefore)),
          and(eq(jobRuns.status, "running"), lt(jobRuns.startedAt, okBefore)),
        ),
      ));
    }
  });
}

export async function runJob(
  database: Database, name: string, clock: Clock,
  backupNightly?: () => Promise<void>,
  snapshotWeekly?: () => Promise<void>,
): Promise<void> {
  if (!isJobName(name)) throw new Error("Unknown job name");
  const now = clock.now();
  const [run] = await database.db.insert(jobRuns).values({
    jobName: name,
    startedAt: now,
    status: "running",
  }).returning({ id: jobRuns.id });
  if (!run) throw new Error("Could not record job start");

  try {
    if (name === "backup-nightly") {
      if (!backupNightly) throw new Error("Backup runner is missing");
      await backupNightly();
    } else if (name === "snapshot-weekly") {
      if (!snapshotWeekly) throw new Error("Snapshot runner is missing");
      await snapshotWeekly();
    } else if (name === "expire-orders") {
      await expireUnansweredOrders(database.pool, clock);
    } else {
      await database.db.transaction(async (tx) => {
        // ON DELETE CASCADE removes every refresh token of an expired session.
        await tx.delete(sessions).where(lte(sessions.expiresAt, now));
        await tx.delete(refreshTokens).where(and(
          isNotNull(refreshTokens.replacedAt),
          lt(refreshTokens.replacedAt, new Date(now.getTime() - REFRESH_TTL_MS)),
        ));
      });
      // Its own transaction after the session cleanup, so a failure here cannot undo that work.
      await deleteOldJobRuns(database, now);
    }
    await database.db.update(jobRuns).set({ status: "ok", finishedAt: clock.now() })
      .where(eq(jobRuns.id, run.id));
  } catch (error) {
    await database.db.update(jobRuns).set({
      status: "failed",
      finishedAt: clock.now(),
      errorText: name === "backup-nightly" ? "backup failed" : name === "snapshot-weekly" ? "snapshot failed" :
        name === "expire-orders" ? "expiry failed" : "cleanup failed",
    }).where(eq(jobRuns.id, run.id));
    throw error;
  }
}
