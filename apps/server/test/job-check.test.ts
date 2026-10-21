import { afterAll, expect, inject, it } from "vitest";
import { createLocalClock } from "../src/adapters/clock";
import { connectDatabase } from "../src/db";
import { checkJobs } from "../src/job-check";
import type { JobName } from "../src/jobs";
import { jobRuns } from "../src/schema";

const database = connectDatabase(inject("databaseUrl"));
afterAll(() => database.close());

it("publishes per-job health from completed runs, age, and the latest failure", async () => {
  const now = new Date("2040-01-02T01:30:00.000Z");
  const clock = createLocalClock(now);
  const reports: { name: JobName; healthy: boolean }[] = [];
  const publish = async (name: JobName, healthy: boolean) => { reports.push({ name, healthy }); };
  const check = async () => {
    reports.length = 0;
    return checkJobs(database, clock, publish);
  };

  // No success yet, including a running row, is unhealthy.
  await database.db.insert(jobRuns).values({
    jobName: "backup-nightly", startedAt: now, status: "running",
  });
  expect(await check()).toBe(false);
  expect(reports).toEqual([
    { name: "backup-nightly", healthy: false },
    { name: "cleanup-sessions", healthy: false },
    { name: "snapshot-weekly", healthy: false },
  ]);

  const yesterday = new Date(now.getTime() - 25 * 60 * 60 * 1000);
  await database.db.insert(jobRuns).values([
    { jobName: "backup-nightly", startedAt: yesterday, finishedAt: yesterday, status: "ok" },
    { jobName: "cleanup-sessions", startedAt: yesterday, finishedAt: yesterday, status: "ok" },
    { jobName: "snapshot-weekly", startedAt: yesterday, finishedAt: yesterday, status: "ok" },
  ]);
  expect(await check()).toBe(true);
  expect(reports.every((report) => report.healthy)).toBe(true);

  const failed = new Date(now.getTime() - 60 * 60 * 1000);
  await database.db.insert(jobRuns).values({
    jobName: "backup-nightly", startedAt: failed, finishedAt: failed,
    status: "failed", errorText: "backup failed",
  });
  expect(await check()).toBe(false);
  expect(reports).toContainEqual({ name: "backup-nightly", healthy: false });
  expect(reports).toContainEqual({ name: "cleanup-sessions", healthy: true });

  clock.advance(2 * 60 * 60 * 1000);
  expect(await check()).toBe(false);
  expect(reports).toEqual([
    { name: "backup-nightly", healthy: false },
    { name: "cleanup-sessions", healthy: false },
    { name: "snapshot-weekly", healthy: true },
  ]);
});

it("publishes 0 for every job if database reads fail, and rejects failed publishing", async () => {
  const broken = connectDatabase(inject("databaseUrl"));
  await broken.close();
  const reports: { name: JobName; healthy: boolean }[] = [];
  const clock = createLocalClock(new Date("2041-01-01T00:00:00.000Z"));
  expect(await checkJobs(broken, clock, async (name, healthy) => {
    reports.push({ name, healthy });
  })).toBe(false);
  expect(reports).toEqual([
    { name: "backup-nightly", healthy: false },
    { name: "cleanup-sessions", healthy: false },
    { name: "snapshot-weekly", healthy: false },
  ]);
  await expect(checkJobs(broken, clock, async () => { throw new Error("AWS failed"); }))
    .rejects.toThrow("Could not publish every job health metric");
});

it("a newer running row does not hide the latest finished failure", async () => {
  const now = new Date("2050-01-02T01:30:00.000Z");
  const success = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const failed = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  const running = new Date(now.getTime() - 60 * 60 * 1000);
  await database.db.insert(jobRuns).values([
    { jobName: "backup-nightly", startedAt: success, finishedAt: success, status: "ok" },
    { jobName: "backup-nightly", startedAt: failed, finishedAt: failed, status: "failed" },
    { jobName: "backup-nightly", startedAt: running, status: "running" },
  ]);
  const reports: { name: JobName; healthy: boolean }[] = [];
  await checkJobs(database, createLocalClock(now), async (name, healthy) => {
    reports.push({ name, healthy });
  });
  expect(reports).toContainEqual({ name: "backup-nightly", healthy: false });
});

it("reports a weekly snapshot healthy through day eight, then unhealthy", async () => {
  const now = new Date("2051-01-09T00:30:00.000Z");
  const clock = createLocalClock(now);
  const finished = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
  await database.db.insert(jobRuns).values({
    jobName: "snapshot-weekly", startedAt: finished, finishedAt: finished, status: "ok",
  });
  const reports: { name: JobName; healthy: boolean }[] = [];
  const check = async () => {
    reports.length = 0;
    await checkJobs(database, clock, async (name, healthy) => { reports.push({ name, healthy }); });
    return reports.find((report) => report.name === "snapshot-weekly")?.healthy;
  };
  expect(await check()).toBe(true);
  clock.advance(1);
  expect(await check()).toBe(false);

  const fresh = clock.now();
  await database.db.insert(jobRuns).values({
    jobName: "snapshot-weekly", startedAt: fresh, finishedAt: fresh, status: "ok",
  });
  expect(await check()).toBe(true);
  clock.advance(60 * 1000);
  const failed = clock.now();
  await database.db.insert(jobRuns).values([
    { jobName: "snapshot-weekly", startedAt: failed, finishedAt: failed, status: "failed", errorText: "snapshot failed" },
    { jobName: "snapshot-weekly", startedAt: new Date(failed.getTime() + 1), status: "running" },
  ]);
  expect(await check()).toBe(false);
});
