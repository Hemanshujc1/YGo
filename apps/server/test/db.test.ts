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
});
