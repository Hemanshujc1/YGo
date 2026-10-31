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
    /** The migrated database every test database is copied from; nothing connects to it. */
    templateDatabase: string;
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

/**
 * Migrates one template database per run. Each test then copies it
 * (`createTestDatabase`) in place of running every migration again; the run's
 * own database is a copy too.
 */
export default async function setup(project: TestProject) {
  const id = randomUUID().replaceAll("-", "");
  const template = `ygo_template_${id}`;
  const name = `ygo_test_${id}`;
  const teardown = () =>
    withClient(serverUrl, async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.query(`DROP DATABASE IF EXISTS ${template} WITH (FORCE)`);
    });
  try {
    await withClient(serverUrl, (admin) => admin.query(`CREATE DATABASE ${template}`));
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

  try {
    const templateUrl = new URL(serverUrl);
    templateUrl.pathname = `/${template}`;
    await withClient(templateUrl, (client) =>
      migrate(drizzle({ client }), {
        migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
      }),
    );
    await withClient(serverUrl, (admin) => admin.query(`CREATE DATABASE ${name} TEMPLATE ${template}`));
  } catch (err) {
    await teardown();
    throw err;
  }

  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  project.provide("databaseUrl", url.href);
  project.provide("templateDatabase", template);
  return teardown;
}
