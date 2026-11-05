import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, expect, inject, it } from "vitest";
import { connectDatabase } from "../src/db";

const run = promisify(execFile);
const database = connectDatabase(inject("databaseUrl"));
afterAll(() => database.close());

// The job host gives the timers only DATABASE_URL and the order timing (docs/operations/timed-jobs.md).
const entry = (name: string, env: Record<string, string>) =>
  run("pnpm", ["exec", "tsx", "src/job.ts", name], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATABASE_URL: inject("databaseUrl"), ...env } })
    .then(() => 0, (error: { code?: number }) => error.code ?? 1);

async function okRuns(name: string) {
  const { rows } = await database.pool.query<{ count: number }>("SELECT count(*)::int AS count FROM job_runs WHERE job_name = $1 AND status = 'ok'", [name]);
  return rows[0]?.count ?? 0;
}

it("runs expire-orders and cleanup-sessions with only DATABASE_URL set", async () => {
  const expireBefore = await okRuns("expire-orders");
  const cleanupBefore = await okRuns("cleanup-sessions");
  expect(await entry("expire-orders", {})).toBe(0);
  expect(await entry("cleanup-sessions", {})).toBe(0);
  expect([await okRuns("expire-orders"), await okRuns("cleanup-sessions")]).toEqual([expireBefore + 1, cleanupBefore + 1]);
}, 60_000);

it("fails cleanup-sessions when the private photo bucket is the public image bucket", async () => {
  expect(await entry("cleanup-sessions", { VISIT_PHOTO_BUCKET: "same-bucket", PRODUCT_IMAGE_BUCKET: "same-bucket" })).toBe(1);
}, 60_000);

it("fails only cleanup-sessions when the photo bucket settings are invalid", async () => {
  const bad = { VISIT_PHOTO_BUCKET: "private-photos", S3_ENDPOINT: "not a url" };
  expect(await entry("cleanup-sessions", bad)).toBe(1);
  expect(await entry("expire-orders", bad)).toBe(0);
}, 60_000);
