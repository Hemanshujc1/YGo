import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, expect, inject, it } from "vitest";
import { createLocalClock } from "../src/adapters/clock";
import { connectDatabase } from "../src/db";
import { checkJobs } from "../src/job-check";
import { JOB_RUN_FAILED_KEEP_DAYS, JOB_RUN_OK_KEEP_DAYS, deleteOldJobRuns, runJob } from "../src/jobs";
import { accounts, jobRuns, sessions } from "../src/schema";

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

it("keeps the session cleanup and records a failed run when the retention step fails", async () => {
  const at = new Date("2061-01-01T00:00:00.000Z");
  const [account] = await database.db.insert(accounts)
    .values({ email: `${randomUUID()}@example.invalid` }).returning({ id: accounts.id });
  if (!account) throw new Error("Account insert failed");
  const [session] = await database.db.insert(sessions)
    .values({ accountId: account.id, expiresAt: at }).returning({ id: sessions.id });
  if (!session) throw new Error("Session insert failed");
  // Two jobs each have a protected latest ok row and an older deletable one. The failure is tied
  // to the second job's deletable row and fires at commit (a deferred constraint trigger), after
  // every row of the retention delete, so the first job's row is already deleted inside the
  // transaction when it fails.
  const firstLabel = randomUUID();
  const label = randomUUID();
  await database.db.insert(jobRuns).values([
    run("backup-nightly", "ok", new Date(at.getTime() - 40 * DAY), "backup previous ok"),
    run("backup-nightly", "ok", new Date(at.getTime() - 41 * DAY), firstLabel),
    run("cleanup-sessions", "ok", new Date(at.getTime() - 40 * DAY), "previous ok"),
    run("cleanup-sessions", "ok", new Date(at.getTime() - 41 * DAY), label),
  ]);
  const trigger = `fail_retention_${label.replaceAll("-", "")}`;
  await database.pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'retention test failure ${label}'; END $$`);
  await database.pool.query(`CREATE CONSTRAINT TRIGGER ${trigger} AFTER DELETE ON job_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.error_text = '${label}') EXECUTE FUNCTION ${trigger}()`);
  try {
    // drizzle wraps the driver error in "Failed query"; the trigger's own message is its cause.
    const failure = await runJob(database, "cleanup-sessions", createLocalClock(at)).then(
      () => { throw new Error("runJob should have rejected"); },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).cause).toMatchObject({ message: `retention test failure ${label}` });

    // The session cleanup committed before the retention step ran.
    expect(await database.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, session.id)))
      .toEqual([]);
    // The retention delete rolled back as a whole, the first job's row included, and this run is
    // recorded as failed.
    expect(await remaining("backup-nightly")).toEqual(["backup previous ok", firstLabel].sort());
    expect(await remaining("cleanup-sessions")).toEqual(["cleanup failed", label, "previous ok"].sort());
    expect(await database.db.select().from(jobRuns).where(eq(jobRuns.startedAt, at)))
      .toMatchObject([{ jobName: "cleanup-sessions", status: "failed", finishedAt: at, errorText: "cleanup failed" }]);
  } finally {
    await database.pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON job_runs`);
    await database.pool.query(`DROP FUNCTION IF EXISTS ${trigger}()`);
  }
});
