import { inject } from "vitest";
import pg from "pg";

/**
 * Creates database `name` as a copy of the migrated template that
 * `global-setup.ts` prepared, and answers its URL. The caller drops it with
 * `DROP DATABASE … WITH (FORCE)`.
 */
export async function createTestDatabase(name: string): Promise<URL> {
  const serverUrl = inject("databaseUrl");
  const root = new pg.Client({ connectionString: serverUrl, connectionTimeoutMillis: 5_000 });
  await root.connect();
  try {
    await root.query(`CREATE DATABASE ${name} TEMPLATE ${inject("templateDatabase")}`);
  } finally {
    await root.end();
  }
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return url;
}
