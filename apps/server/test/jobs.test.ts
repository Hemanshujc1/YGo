import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, expect, inject, it } from "vitest";
import { createLocalClock } from "../src/adapters/clock";
import { connectDatabase } from "../src/db";
import { runJob } from "../src/jobs";
import { accounts, jobRuns, refreshTokens, sessions } from "../src/schema";
import { REFRESH_TTL_MS } from "../src/tokens";

const database = connectDatabase(inject("databaseUrl"));
afterAll(() => database.close());

async function createSession(expiresAt: Date) {
  const [account] = await database.db.insert(accounts)
    .values({ email: `${randomUUID()}@example.invalid` }).returning({ id: accounts.id });
  if (!account) throw new Error("Account insert failed");
  const [session] = await database.db.insert(sessions)
    .values({ accountId: account.id, expiresAt }).returning({ id: sessions.id });
  if (!session) throw new Error("Session insert failed");
  return session.id;
}

it("records success and removes only expired sessions and old replaced tokens", async () => {
  const now = new Date("2027-01-01T00:00:00.000Z");
  const clock = createLocalClock(now);
  const expired = await createSession(now);
  const live = await createSession(new Date(now.getTime() + 1));
  const old = new Date(now.getTime() - REFRESH_TTL_MS - 1);
  const boundary = new Date(old.getTime() + 1);
  const tokens = [
    { tokenHash: randomUUID(), sessionId: expired, generation: 0 },
    { tokenHash: randomUUID(), sessionId: live, generation: 0, replacedAt: old },
    { tokenHash: randomUUID(), sessionId: live, generation: 1, replacedAt: boundary },
    { tokenHash: randomUUID(), sessionId: live, generation: 2, replacedAt: now },
    { tokenHash: randomUUID(), sessionId: live, generation: 3 },
  ];
  await database.db.insert(refreshTokens).values(tokens);

  await runJob(database, "cleanup-sessions", clock);

  expect(await database.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, expired)))
    .toEqual([]);
  expect(await database.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, live)))
    .toEqual([{ id: live }]);
  expect((await database.db.select({ tokenHash: refreshTokens.tokenHash }).from(refreshTokens)
    .where(eq(refreshTokens.sessionId, live))).map((row) => row.tokenHash).sort())
    .toEqual(tokens.slice(2).map((token) => token.tokenHash).sort());
  expect(await database.db.select().from(refreshTokens)
    .where(eq(refreshTokens.sessionId, expired))).toEqual([]);
  expect(await database.db.select().from(jobRuns).where(eq(jobRuns.startedAt, now)))
    .toMatchObject([{ jobName: "cleanup-sessions", status: "ok", finishedAt: now, errorText: null }]);
});

it("records failure and rolls back cleanup", async () => {
  const now = new Date("2028-01-01T00:00:00.000Z");
  const expired = await createSession(now);
  const live = await createSession(new Date(now.getTime() + 1));
  const tokenHash = randomUUID();
  await database.db.insert(refreshTokens).values({
    tokenHash, sessionId: live, generation: 0,
    replacedAt: new Date(now.getTime() - REFRESH_TTL_MS - 24 * 60 * 60 * 1000),
  });
  const suffix = randomUUID().replaceAll("-", "");
  const triggerName = `fail_cleanup_${suffix}`;
  await database.pool.query(`CREATE FUNCTION ${triggerName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$`);
  await database.pool.query(`CREATE TRIGGER ${triggerName} BEFORE DELETE ON refresh_tokens FOR EACH ROW WHEN (OLD.token_hash = '${tokenHash}') EXECUTE FUNCTION ${triggerName}()`);
  try {
    await expect(runJob(database, "cleanup-sessions", createLocalClock(now)))
      .rejects.toThrow("Failed query");
    expect(await database.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, expired)))
      .toEqual([{ id: expired }]);
    expect(await database.db.select({ tokenHash: refreshTokens.tokenHash }).from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))).toEqual([{ tokenHash }]);
    expect(await database.db.select().from(jobRuns).where(eq(jobRuns.startedAt, now)))
      .toMatchObject([{ jobName: "cleanup-sessions", status: "failed", finishedAt: now, errorText: "cleanup failed" }]);
  } finally {
    await database.pool.query(`DROP TRIGGER ${triggerName} ON refresh_tokens`);
    await database.pool.query(`DROP FUNCTION ${triggerName}()`);
  }
});

it("rejects an unknown job without writing a run", async () => {
  const now = new Date("2029-01-01T00:00:00.000Z");
  for (const name of ["nope", "toString"]) {
    await expect(runJob(database, name, createLocalClock(now)))
      .rejects.toThrow("Unknown job name");
  }
  expect(await database.db.select().from(jobRuns).where(eq(jobRuns.startedAt, now)))
    .toEqual([]);
});

it("records a verified backup and a failed backup without retaining an error detail", async () => {
  const success = new Date("2031-01-01T00:00:00.000Z");
  let calls = 0;
  await runJob(database, "backup-nightly", createLocalClock(success), async () => { calls++; });
  expect(calls).toBe(1);
  expect(await database.db.select().from(jobRuns).where(eq(jobRuns.startedAt, success)))
    .toMatchObject([{ jobName: "backup-nightly", status: "ok", finishedAt: success, errorText: null }]);

  const failure = new Date("2032-01-01T00:00:00.000Z");
  await expect(runJob(database, "backup-nightly", createLocalClock(failure), async () => {
    throw new Error("private backup failure detail");
  })).rejects.toThrow("private backup failure detail");
  expect(await database.db.select().from(jobRuns).where(eq(jobRuns.startedAt, failure)))
    .toMatchObject([{ jobName: "backup-nightly", status: "failed", finishedAt: failure, errorText: "backup failed" }]);
});

it("a stuck running row does not block the next backup run", async () => {
  const stuck = new Date("2033-01-01T00:00:00.000Z");
  await database.db.insert(jobRuns).values({ jobName: "backup-nightly", startedAt: stuck, status: "running" });
  const next = new Date("2034-01-01T00:00:00.000Z");
  await runJob(database, "backup-nightly", createLocalClock(next), async () => {});
  expect(await database.db.select().from(jobRuns).where(eq(jobRuns.startedAt, stuck)))
    .toMatchObject([{ status: "running", finishedAt: null }]);
  expect(await database.db.select().from(jobRuns).where(eq(jobRuns.startedAt, next)))
    .toMatchObject([{ status: "ok", finishedAt: next }]);
});
