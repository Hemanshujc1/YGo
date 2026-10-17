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
const rawUrl = process.env.TEST_DATABASE_URL ?? "postgres://ygo:ygo@localhost:5432/ygo";
if (!URL.canParse(rawUrl)) throw new Error("TEST_DATABASE_URL is not a postgres:// URL.");
const serverUrl = new URL(rawUrl);

/** Runs `work` on its own connection to `url`, and always closes it. */
async function withClient<T>(url: URL, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    return await work(client);
  } finally {
    await client.end();
  }
}

/** One database per test run, created with the migrations applied and dropped at the end. */
export default async function setup(project: TestProject) {
  const name = `ygo_test_${randomUUID().replaceAll("-", "")}`;
  try {
    await withClient(serverUrl, (admin) => admin.query(`CREATE DATABASE ${name}`));
  } catch (err) {
    const { code, message } = err as { code?: string; message?: string };
    const down = code === "ECONNREFUSED" || code === "ENOTFOUND" || /timeout/i.test(message ?? "");
    const lead = down
      ? `The server tests need PostgreSQL with PostGIS at ${serverUrl.host}, and it did not answer`
      : `The server tests could not create a database on ${serverUrl.host}`;
    throw new Error(
      `${lead} (${message || code}). See apps/server/README.md, or set TEST_DATABASE_URL.`,
      { cause: err },
    );
  }

  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const teardown = () =>
    withClient(serverUrl, (admin) => admin.query(`DROP DATABASE ${name} WITH (FORCE)`));

  try {
    await withClient(url, (client) =>
      migrate(drizzle({ client }), {
        migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
      }),
    );
  } catch (err) {
    await teardown();
    throw err;
  }

  project.provide("databaseUrl", url.href);
  return async () => {
    await teardown();
  };
}
