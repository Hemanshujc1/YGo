import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { expect, inject, it } from "vitest";

const run = promisify(execFile);

it("ADR-0004: a standalone release migrates with its runtime config and serves database health", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ygo-release-"));
  const admin = new pg.Client({ connectionString: inject("databaseUrl") });
  const name = `ygo_release_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(inject("databaseUrl"));
  url.pathname = `/${name}`;
  let server: ReturnType<typeof execFile> | undefined;
  let client: pg.Client | undefined;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    await run(process.execPath, ["scripts/build.js", directory], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
    });
    const env = {
      ...process.env, DATABASE_URL: url.href, AUTH_TOKEN_SECRET: "01234567890123456789012345678901", HOST: "127.0.0.1", PORT: "3000",
      MAILER: "mailpit", MAIL_FROM: "ygo@example.invalid", MAILPIT_URL: "http://localhost:8025",
    };
    const migrateEnv = { DATABASE_URL: url.href };
    const missingSender = await run(process.execPath, [join(directory, "main.js")], {
      cwd: tmpdir(), env: { ...env, MAILER: "ses", MAIL_FROM: "", AWS_REGION: "ap-south-1" },
      timeout: 5_000,
    }).then(() => null, (error: unknown) => error);
    expect(missingSender).toBeInstanceOf(Error);
    expect((missingSender as { stderr: string }).stderr).toContain("MAIL_FROM");
    await run(process.execPath, [join(directory, "migrate.js")], { cwd: tmpdir(), env: migrateEnv });
    client = new pg.Client({ connectionString: url.href });
    await client.connect();
    const first = await client.query("SELECT * FROM drizzle.__drizzle_migrations");
    expect(first.rowCount).toBeGreaterThan(0);
    await run(process.execPath, [join(directory, "migrate.js")], { cwd: tmpdir(), env: migrateEnv });
    expect((await client.query("SELECT * FROM drizzle.__drizzle_migrations")).rows).toEqual(first.rows);
    expect((await client.query("SELECT PostGIS_Version() AS version")).rows[0].version).toBeTruthy();
    const socket = createServer();
    await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
    const port = (socket.address() as { port: number }).port;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    server = execFile(process.execPath, [join(directory, "main.js")], {
      cwd: tmpdir(), env: { ...env, PORT: String(port) },
    });
    const address = `http://127.0.0.1:${port}/v1/healthz`;
    await expect.poll(async () => (await fetch(address)).status, { timeout: 10_000 }).toBe(200);
    expect(await (await fetch(address)).json()).toEqual({ status: "ok" });
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      const running = server;
      await new Promise<void>((resolve) => {
        running.once("exit", () => resolve());
        running.kill("SIGTERM");
      });
    }
    await client?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
