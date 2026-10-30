import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { openingStockQueue } from "../src/lib/opening-stock-queue";

/** Real SQLite, with only the platform calling convention adapted for Node. */
export function adapter(db: DatabaseSync): Parameters<typeof openingStockQueue>[0] {
  return {
    execSync: (sql: string) => db.exec(sql),
    runSync: (sql: string, ...args: SQLInputValue[]) => db.prepare(sql).run(...args),
    getFirstSync: (sql: string, ...args: SQLInputValue[]) => db.prepare(sql).get(...args) ?? null,
    withTransactionSync: (work: () => void) => {
      db.exec("BEGIN");
      try { work(); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  } as unknown as Parameters<typeof openingStockQueue>[0];
}

export function legacy(values: Map<string, string>) {
  return {
    getAllKeys: () => [...values.keys()],
    getString: (key: string) => values.get(key),
    remove: (key: string) => values.delete(key),
  };
}
