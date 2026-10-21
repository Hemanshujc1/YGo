import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createLocalClock } from "../src/adapters/clock";
import { adminSignedIn } from "../src/admin";
import { buildApp } from "../src/app";
import { BOOTSTRAP_REASON, bootstrapAdmin } from "../src/bootstrap";
import { connectDatabase } from "../src/db";
import { accessToken, deriveKeys } from "../src/tokens";

const run = promisify(execFile);
const databaseUrl = inject("databaseUrl");
const database = connectDatabase(databaseUrl);
const secret = "01234567890123456789012345678901";
const clock = createLocalClock(new Date("2030-01-01T00:00:00.000Z"));
let packageDir: string;

beforeAll(async () => {
  packageDir = await mkdtemp(join(tmpdir(), "ygo-admin-"));
  await run(process.execPath, ["scripts/build.js", packageDir], { cwd: new URL("..", import.meta.url).pathname });
});
afterAll(async () => {
  await database.close();
  if (packageDir) await rm(packageDir, { recursive: true, force: true });
});

const fields = (suffix: string) => ({
  email: `admin-${suffix}@example.com`,
  name: "Asha Kulkarni",
  phone: `+919${suffix.padStart(9, "0")}`,
});

function command(args: string[]) {
  return run(process.execPath, [join(packageDir, "bootstrap-admin.js"), ...args], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

function args(data: ReturnType<typeof fields>) {
  return ["--email", data.email, "--name", data.name, "--phone", data.phone];
}

describe("Admin database and bootstrap", () => {
  it("enforces action shape, UUIDs and append-only writes in PostgreSQL", async () => {
    const target = randomUUID();
    const actor = randomUUID();
    await expect(database.pool.query(
      "INSERT INTO admin_actions (actor_id, action, target_account_id, reason) VALUES (NULL, 'admin.create', $1, 'reason')",
      [target],
    )).rejects.toMatchObject({ code: "23514" });
    await expect(database.pool.query(
      "INSERT INTO admin_actions (actor_id, action, target_account_id, reason) VALUES (NULL, 'admin.bootstrap', $1, 'wrong')",
      [target],
    )).rejects.toMatchObject({ code: "23514" });
    await expect(database.pool.query(
      "INSERT INTO admin_actions (actor_id, action, target_account_id, reason) VALUES ($1, 'admin.bootstrap', $2, $3)",
      [actor, target, BOOTSTRAP_REASON],
    )).rejects.toMatchObject({ code: "23514" });
    for (const reason of ["", "  ", "x".repeat(501)]) {
      await expect(database.pool.query(
        "INSERT INTO admin_actions (actor_id, action, target_account_id, reason) VALUES ($1, 'admin.create', $2, $3)",
        [actor, target, reason],
      )).rejects.toMatchObject({ code: "23514" });
    }
    await expect(database.pool.query(
      "INSERT INTO admin_actions (actor_id, action, target_account_id, reason) VALUES ($1, '', $2, 'reason')",
      [actor, target],
    )).rejects.toMatchObject({ code: "23514" });
    await expect(database.pool.query(
      "INSERT INTO admin_actions (actor_id, action, target_account_id, reason) VALUES ($1, 'admin.create', $2, NULL)",
      [actor, target],
    )).rejects.toMatchObject({ code: "23502" });
    await expect(database.pool.query(
      "INSERT INTO admin_actions (actor_id, action, target_account_id, reason) VALUES ('bad-uuid', 'admin.create', $1, 'reason')",
      [target],
    )).rejects.toMatchObject({ code: "22P02" });
    await expect(database.pool.query(
      "INSERT INTO admin_actions (actor_id, action, target_account_id, reason) VALUES ($1, 'admin.create', 'bad-uuid', 'reason')",
      [actor],
    )).rejects.toMatchObject({ code: "22P02" });
    const inserted = await database.pool.query<{ id: string }>(
      "INSERT INTO admin_actions (actor_id, action, target_account_id, reason) VALUES ($1, 'admin.create', $2, 'reason') RETURNING id",
      [actor, target],
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error("Action insert returned no ID.");
    await expect(database.pool.query("UPDATE admin_actions SET reason = 'changed' WHERE id = $1", [id])).rejects.toThrow();
    await expect(database.pool.query("DELETE FROM admin_actions WHERE id = $1", [id])).rejects.toThrow();
    await expect(database.pool.query("TRUNCATE admin_actions")).rejects.toThrow();
    expect((await database.pool.query("SELECT actor_id, target_account_id, reason FROM admin_actions WHERE id = $1", [id])).rows[0])
      .toMatchObject({ actor_id: actor, target_account_id: target, reason: "reason" });
    const foreignKeys = await database.pool.query(
      "SELECT 1 FROM pg_constraint WHERE conrelid = 'admin_actions'::regclass AND contype = 'f'",
    );
    expect(foreignKeys.rowCount).toBe(0);
    const columns = await database.pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'admin_actions'",
    );
    expect(columns.rows.map((column) => column.column_name).sort()).toEqual(
      ["id", "actor_id", "action", "target_account_id", "reason", "created_at"].sort(),
    );
  });

  it("validates shared fields and refuses an account with a matching email or phone", async () => {
    await expect(bootstrapAdmin(database.pool, { ...fields("101"), name: "123" })).rejects.toThrow();
    const existing = fields("102");
    const account = await database.pool.query<{ id: string }>("INSERT INTO accounts (email, name, phone) VALUES ($1, $2, $3) RETURNING id",
      [existing.email, existing.name, existing.phone]);
    await expect(bootstrapAdmin(database.pool, { ...fields("103"), email: existing.email })).rejects.toThrow("already in use");
    await expect(bootstrapAdmin(database.pool, { ...fields("104"), phone: existing.phone })).rejects.toThrow("already in use");
    await expect(command(["--email", existing.email, "--name", "123", "--phone", existing.phone]))
      .rejects.toMatchObject({ stderr: expect.stringContaining("Invalid email, name or phone.") });
    await expect(command(["--email", existing.email])).rejects.toMatchObject({
      stderr: expect.stringContaining("Invalid email, name or phone."),
    });
    const id = account.rows[0]?.id;
    if (!id) throw new Error("Account insert returned no ID.");
    await database.pool.query("INSERT INTO admin_memberships (account_id) VALUES ($1)", [id]);
    await expect(command(args(fields("108")))).rejects.toMatchObject({
      stderr: expect.stringContaining("An Admin already exists; use Admin web."),
    });
    await database.pool.query("DELETE FROM accounts WHERE id = $1", [id]);
    expect((await database.pool.query("SELECT 1 FROM admin_memberships WHERE account_id = $1", [id])).rowCount).toBe(0);
  });

  it("allows exactly one competing packaged bootstrap command and leaves one complete record", async () => {
    const first = fields("105");
    const second = fields("106");
    const results = await Promise.allSettled([command(args(first)), command(args(second))]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const failed = results.find((result) => result.status === "rejected");
    expect(String((failed as PromiseRejectedResult).reason.stderr)).toContain("An Admin already exists; use Admin web.");
    for (const result of results) {
      const output = result.status === "fulfilled" ? result.value.stdout + result.value.stderr :
        String(result.reason.stdout) + String(result.reason.stderr);
      expect(output).not.toContain(first.email);
      expect(output).not.toContain(second.email);
      expect(output).not.toContain(first.phone);
      expect(output).not.toContain(second.phone);
    }
    const rows = await database.pool.query(
      "SELECT a.id, a.role, m.account_id, x.actor_id, x.action, x.target_account_id, x.reason, x.created_at FROM admin_memberships m JOIN accounts a ON a.id = m.account_id JOIN admin_actions x ON x.target_account_id = a.id WHERE x.action = 'admin.bootstrap'",
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]).toMatchObject({ role: "customer", actor_id: null, action: "admin.bootstrap", reason: BOOTSTRAP_REASON });
    expect(rows.rows[0].target_account_id).toBe(rows.rows[0].id);
    expect(rows.rows[0].created_at).toBeInstanceOf(Date);
    await expect(database.pool.query(
      "INSERT INTO admin_actions (actor_id, action, target_account_id, reason) VALUES (NULL, 'admin.bootstrap', $1, $2)",
      [randomUUID(), BOOTSTRAP_REASON],
    )).rejects.toMatchObject({ code: "23505" });
  });

  it("checks separate membership on each protected request and denies a revoked existing session", async () => {
    const row = (await database.pool.query("SELECT account_id FROM admin_memberships LIMIT 1")).rows[0];
    const id = row.account_id as string;
    const sessionId = randomUUID();
    await database.pool.query("INSERT INTO sessions (id, account_id, expires_at) VALUES ($1, $2, $3)",
      [sessionId, id, new Date("2030-02-01")]);
    const app = buildApp({ checkDatabase: database.ping });
    const auth = { pool: database.pool, clock, keys: deriveKeys(secret) };
    // This route exists only in this test file and is absent from production bundles.
    app.get("/__test/admin", async (request, reply) => {
      if (!await adminSignedIn(request, reply, auth)) return reply;
      return reply.code(204).send();
    });
    const token = accessToken(auth.keys, id, sessionId, clock.now());
    const call = () => app.inject({ method: "GET", url: "/__test/admin", headers: { authorization: `Bearer ${token}` } });
    expect((await app.inject({ method: "GET", url: "/__test/admin" })).statusCode).toBe(401);
    expect((await call()).statusCode).toBe(204);
    await database.pool.query("DELETE FROM admin_memberships WHERE account_id = $1", [id]);
    expect((await call()).statusCode).toBe(403);
    await app.close();
    await expect(command(args(fields("107")))).rejects.toMatchObject({
      stderr: expect.stringContaining("Bootstrap was already used"),
    });
    expect((await database.pool.query("SELECT count(*)::int AS count FROM admin_actions WHERE action = 'admin.bootstrap'")).rows[0].count).toBe(1);
  });
});
