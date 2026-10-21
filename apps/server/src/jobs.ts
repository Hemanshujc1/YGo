import { and, eq, isNotNull, lt, lte } from "drizzle-orm";
import type { Clock } from "./adapters/clock";
import type { Database } from "./db";
import { jobRuns, refreshTokens, sessions } from "./schema";
import { REFRESH_TTL_MS } from "./tokens";

export const jobMaxAgeHours = { "backup-nightly": 26, "cleanup-sessions": 26, "snapshot-weekly": 8 * 24 } as const;
export type JobName = keyof typeof jobMaxAgeHours;

export function isJobName(name: string): name is JobName {
  return Object.hasOwn(jobMaxAgeHours, name);
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
    } else {
      await database.db.transaction(async (tx) => {
        // ON DELETE CASCADE removes every refresh token of an expired session.
        await tx.delete(sessions).where(lte(sessions.expiresAt, now));
        await tx.delete(refreshTokens).where(and(
          isNotNull(refreshTokens.replacedAt),
          lt(refreshTokens.replacedAt, new Date(now.getTime() - REFRESH_TTL_MS)),
        ));
      });
    }
    await database.db.update(jobRuns).set({ status: "ok", finishedAt: clock.now() })
      .where(eq(jobRuns.id, run.id));
  } catch (error) {
    await database.db.update(jobRuns).set({
      status: "failed",
      finishedAt: clock.now(),
      errorText: name === "backup-nightly" ? "backup failed" :
        name === "snapshot-weekly" ? "snapshot failed" : "cleanup failed",
    }).where(eq(jobRuns.id, run.id));
    throw error;
  }
}
