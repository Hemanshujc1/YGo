import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg, { type Pool, type PoolClient } from "pg";

/** The one pool for the process (ADR-0004). No tables yet, and no migration runs here. */
export function connectDatabase(url: string) {
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    // Fail a health check quickly instead of hanging when the database is unreachable.
    connectionTimeoutMillis: 5_000,
  });
  const db = drizzle({ client: pool });
  // pool.end() resolves once each connection is asked to close, not once it
  // has; a database dropped in that gap fails the connection (#287).
  const closing = new Set<Promise<void>>();
  pool.on("connect", (client) => {
    const closed: Promise<void> = new Promise((resolve) => client.once("end", () => {
      closing.delete(closed);
      resolve();
    }));
    closing.add(closed);
  });
  // A connection the database drops while idle fails on the pool, and an
  // unheard failure crashes the process. The server logs its own (main.ts);
  // jobs and scripts fall back to this one.
  pool.on("error", (err) => {
    if (pool.listenerCount("error") === 1) console.error(`idle database client failed: ${err.message}`);
  });

  return {
    db,
    pool,
    async ping(): Promise<void> {
      await db.execute(sql`select 1`);
    },
    /** Resolves once every connection has closed, or after `waitMs` so one that never does can't hang shutdown. */
    async close(waitMs = 5_000): Promise<void> {
      await pool.end();
      let giveUp: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all(closing),
        new Promise((resolve) => { giveUp = setTimeout(resolve, waitMs); }),
      ]);
      clearTimeout(giveUp);
    },
  };
}

export type Database = ReturnType<typeof connectDatabase>;

/**
 * Runs `work` inside `BEGIN` on one pooled connection. Nothing commits on its
 * own: `work` sends `COMMIT` itself before answering a success. Returning
 * without it, as a refusal does, or throwing discards the work, and a throw
 * still reaches the caller. A `ROLLBACK` is always sent afterwards; after a
 * `COMMIT` it changes nothing (Postgres only warns that no transaction is in
 * progress). The connection goes back to the pool, unless that `ROLLBACK`
 * fails: then it may still hold an open transaction, so it is closed instead.
 */
export async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    return await work(client);
  } finally {
    const rollbackFailure = await client.query("ROLLBACK").then(() => undefined, (error: Error) => error);
    client.release(rollbackFailure);
  }
}
