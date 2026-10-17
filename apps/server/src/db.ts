import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

/** The one pool for the process (ADR-0004). No tables yet, and no migration runs here. */
export function connectDatabase(url: string) {
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    // Fail a health check quickly instead of hanging when the database is unreachable.
    connectionTimeoutMillis: 5_000,
  });
  const db = drizzle({ client: pool });

  return {
    db,
    pool,
    async ping(): Promise<void> {
      await db.execute(sql`select 1`);
    },
    close: () => pool.end(),
  };
}

export type Database = ReturnType<typeof connectDatabase>;
