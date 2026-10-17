import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** The fresh, migrated database this run's tests use. */
    databaseUrl: string;
  }
}

// The README's local container. CI points this at its service container.
const serverUrl = process.env.TEST_DATABASE_URL ?? "postgres://ygo:ygo@localhost:5432/ygo";

/** One database per test run, created with the migrations applied and dropped at the end. */
export default async function setup(project: TestProject) {
  const admin = new pg.Client({ connectionString: serverUrl, connectionTimeoutMillis: 5_000 });
  try {
    await admin.connect();
  } catch (err) {
    const where = new URL(serverUrl).host;
    throw new Error(
      `The server tests need PostgreSQL with PostGIS at ${where}. Start it as ` +
        "apps/server/README.md describes, or set TEST_DATABASE_URL.",
      { cause: err },
    );
  }

  const name = `ygo_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;

  const teardown = async () => {
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  };

  const client = new pg.Client({ connectionString: url.href });
  try {
    await client.connect();
    try {
      await migrate(drizzle({ client }), {
        migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
      });
    } finally {
      await client.end();
    }
  } catch (err) {
    await teardown();
    throw err;
  }

  project.provide("databaseUrl", url.href);
  return teardown;
}
