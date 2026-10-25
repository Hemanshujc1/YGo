import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { connectDatabase, withTransaction } from "../src/db";

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

describe("connectDatabase", () => {
  it("closes only once every connection and its socket have closed (#287)", async () => {
    const database = connectDatabase(inject("databaseUrl"));
    const clients: pg.PoolClient[] = [];
    const ended: boolean[] = [];
    database.pool.on("connect", (client) => {
      const index = clients.push(client) - 1;
      ended.push(false);
      client.once("end", () => { ended[index] = true; });
    });
    try {
      await Promise.all(Array.from({ length: 5 }, () => database.pool.query("SELECT pg_sleep(0.05)")));
    } finally {
      await database.close();
    }
    expect(ended).toEqual([true, true, true, true, true]);
    expect(clients.map((client) => client.connection.stream.destroyed)).toEqual([true, true, true, true, true]);
  });

  it("stops waiting for a connection that never reports closing", async () => {
    const database = connectDatabase(inject("databaseUrl"));
    // Runs before connectDatabase's own listener, so its wait never ends.
    database.pool.prependListener("connect", (client) => {
      const once = client.once.bind(client);
      client.once = ((event: string, listener: () => void) => event === "end" ? client : once(event, listener)) as typeof client.once;
    });
    await database.pool.query("SELECT 1");
    const started = Date.now();
    await database.close(50);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("logs an idle connection the database drops, instead of crashing", async () => {
    const database = connectDatabase(inject("databaseUrl"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const pid = (await database.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      await pool.query("SELECT pg_terminate_backend($1)", [pid]);
      await vi.waitFor(() => expect(logged).toHaveBeenCalledWith(expect.stringMatching(/^idle database client failed: /)));
    } finally {
      logged.mockRestore();
      await database.close();
    }
  });
});
