import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { withTransaction } from "../src/db";

// One connection, so the temporary table is visible to every step and a
// connection that isn't handed back would hang the next query.
const pool = new pg.Pool({ connectionString: inject("databaseUrl"), max: 1 });
const rows = async () => (await pool.query<{ n: number }>("SELECT n FROM tx_probe ORDER BY n")).rows.map((row) => row.n);

beforeAll(() => pool.query("CREATE TEMP TABLE tx_probe (n int)"));
afterAll(() => pool.end());

describe("withTransaction", () => {
  it("keeps what the work commits, and hands the connection back", async () => {
    const answer = await withTransaction(pool, async (client) => {
      await client.query("INSERT INTO tx_probe VALUES (1)");
      await client.query("COMMIT");
      return "saved";
    });
    expect(answer).toBe("saved");
    expect(await rows()).toEqual([1]);
    expect(pool.idleCount).toBe(1);
  });

  it("discards work that returns without committing", async () => {
    const answer = await withTransaction(pool, async (client) => {
      await client.query("INSERT INTO tx_probe VALUES (2)");
      return "refused";
    });
    expect(answer).toBe("refused");
    expect(await rows()).toEqual([1]);
  });

  it("discards work that throws, and passes the error on", async () => {
    await expect(withTransaction(pool, async (client) => {
      await client.query("INSERT INTO tx_probe VALUES (3)");
      throw new Error("failed save");
    })).rejects.toThrow("failed save");
    expect(await rows()).toEqual([1]);
    expect(pool.idleCount).toBe(1);
  });

  it("closes the connection when the rollback fails, instead of pooling it", async () => {
    // A pool of its own, so closing its connection keeps the temporary table.
    const lonePool = new pg.Pool({ connectionString: inject("databaseUrl"), max: 1 });
    const pid = async (client: pg.PoolClient) => (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
    try {
      const firstPid = await withTransaction(lonePool, async (client) => {
        // The socket stays open; only the rollback is refused.
        const query = client.query.bind(client);
        client.query = ((text: unknown, ...rest: never[]) =>
          text === "ROLLBACK" ? Promise.reject(new Error("rollback lost")) : query(text as string, ...rest)) as typeof client.query;
        return pid(client);
      });
      expect(lonePool.totalCount).toBe(0);
      expect(await withTransaction(lonePool, pid)).not.toBe(firstPid);
    } finally {
      await lonePool.end();
    }
  });
});
