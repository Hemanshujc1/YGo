import { and, eq, isNotNull, lt, lte } from "drizzle-orm";
import type { Clock } from "./adapters/clock";
import type { Database } from "./db";
import { jobRuns, refreshTokens, sessions } from "./schema";

export function isJobName(name: string): name is "cleanup-sessions" {
  return name === "cleanup-sessions";
}

export async function runJob(database: Database, name: string, clock: Clock): Promise<void> {
  if (!isJobName(name)) throw new Error("Unknown job name");
  const now = clock.now();
  const [run] = await database.db.insert(jobRuns).values({
    jobName: name,
    startedAt: now,
    status: "running",
  }).returning({ id: jobRuns.id });
  if (!run) throw new Error("Could not record job start");

  try {
    await database.db.transaction(async (tx) => {
      // ON DELETE CASCADE removes every refresh token of an expired session.
      await tx.delete(sessions).where(lte(sessions.expiresAt, now));
      await tx.delete(refreshTokens).where(and(
        isNotNull(refreshTokens.replacedAt),
        lt(refreshTokens.replacedAt, new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)),
      ));
    });
    await database.db.update(jobRuns).set({ status: "ok", finishedAt: clock.now() })
      .where(eq(jobRuns.id, run.id));
  } catch (error) {
    await database.db.update(jobRuns).set({
      status: "failed",
      finishedAt: clock.now(),
      errorText: "cleanup failed",
    }).where(eq(jobRuns.id, run.id));
    throw error;
  }
}
