import { afterAll, beforeEach, expect, inject, it } from "vitest";
import { createLocalClock } from "../src/adapters/clock";
import { connectDatabase } from "../src/db";
import { checkJobs } from "../src/job-check";
import { JOB_RUN_FAILED_KEEP_DAYS, JOB_RUN_OK_KEEP_DAYS, deleteOldJobRuns, runJob } from "../src/jobs";
import { jobRuns } from "../src/schema";

const database = connectDatabase(inject("databaseUrl"));
// The database is shared with the other job tests, which assume the rows they wrote: start and
// leave with an empty table.
beforeEach(async () => { await database.db.delete(jobRuns); });
afterAll(async () => {
  await database.db.delete(jobRuns);
  await database.close();
});

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2050-06-01T00:00:00.000Z");
const ago = (days: number, extraMs = 0) => new Date(now.getTime() - days * DAY - extraMs);

async function remaining(jobName: string) {
  const rows = await database.db.select().from(jobRuns);
  return rows.filter((row) => row.jobName === jobName).map((row) => row.errorText).sort();
}

function run(jobName: string, status: "ok" | "failed" | "running", at: Date, label: string) {
  return {
    jobName, status, startedAt: at, finishedAt: status === "running" ? null : at, errorText: label,
  };
}

it("keeps ok rows 30 days, failed rows 180 days, and running rows 30 days", async () => {
  const ok = JOB_RUN_OK_KEEP_DAYS;
  const failed = JOB_RUN_FAILED_KEEP_DAYS;
  await database.db.insert(jobRuns).values([
    // A newer ok and a newer finished row, so none of the old rows below is a protected latest row.
    run("expire-orders", "ok", ago(0, 60_000), "latest"),
    run("expire-orders", "ok", ago(ok), "ok at 30 days"),
    run("expire-orders", "ok", ago(ok, 1), "ok past 30 days"),
    run("expire-orders", "failed", ago(ok, 1), "failed past 30 days"),
    run("expire-orders", "failed", ago(failed), "failed at 180 days"),
    run("expire-orders", "failed", ago(failed, 1), "failed past 180 days"),
    run("expire-orders", "running", ago(1), "running 1 day"),
    run("expire-orders", "running", ago(ok), "running at 30 days"),
    run("expire-orders", "running", ago(ok, 1), "running past 30 days"),
  ]);

  await deleteOldJobRuns(database, now);

  expect(await remaining("expire-orders")).toEqual([
    "failed at 180 days", "failed past 30 days", "latest", "ok at 30 days", "running 1 day", "running at 30 days",
  ]);
});

it("keeps the latest finished and latest ok row of a job whatever their age, and only that job's", async () => {
  await database.db.insert(jobRuns).values([
    run("snapshot-weekly", "ok", ago(400), "old ok"),
    run("snapshot-weekly", "ok", ago(300), "latest ok"),
    run("snapshot-weekly", "failed", ago(250), "old failed"),
    run("snapshot-weekly", "failed", ago(200), "latest finished"),
    run("backup-nightly", "ok", ago(500), "backup latest ok"),
    run("backup-nightly", "ok", ago(600), "backup old ok"),
  ]);

  await deleteOldJobRuns(database, now);

  expect(await remaining("snapshot-weekly")).toEqual(["latest finished", "latest ok"]);
  expect(await remaining("backup-nightly")).toEqual(["backup latest ok"]);
  // The checker reads the same rows after cleanup, so it reports the same health.
  const reports: boolean[] = [];
  await checkJobs(database, createLocalClock(now), async (name, healthy) => {
    if (name === "snapshot-weekly") reports.push(healthy);
  }, ["snapshot-weekly"]);
  expect(reports).toEqual([false]); // latest finished is a failure, as before cleanup
});

it("runs after the session cleanup in cleanup-sessions and records the run", async () => {
  const at = new Date("2060-01-01T00:00:00.000Z");
  await database.db.insert(jobRuns).values([
    run("cleanup-sessions", "ok", new Date(at.getTime() - 40 * DAY), "previous ok"),
    run("cleanup-sessions", "ok", new Date(at.getTime() - 41 * DAY), "older ok"),
  ]);

  await runJob(database, "cleanup-sessions", createLocalClock(at));

  // The previous ok is the latest finished row when the cleanup runs, so it stays; the older one goes.
  expect(await remaining("cleanup-sessions")).toEqual([null, "previous ok"]);
});
