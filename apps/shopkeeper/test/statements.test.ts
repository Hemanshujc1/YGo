import type { ApiResult } from "@ygo/api-client";
import type { OwnerStatementsResponse, Statement, StatementSummary } from "@ygo/contracts";
import { describe, expect, it, vi } from "vitest";
import { createMoney, openTarget } from "../src/lib/statements";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const summary = (number: number): StatementSummary => ({
  id: uuid(number), number, shopId: uuid(900), shopName: "Sai General Stores", periodStart: "2026-11-02", periodEnd: "2026-11-08",
  issuedAt: "2026-11-09T00:30:00.000Z", dueOn: "2026-11-16", orderCount: 2, total: "107.50",
});
const page = (numbers: number[], nextBefore: number | null, balance = { onStatements: "215.00", thisWeek: "7.50", total: "222.50" }): OwnerStatementsResponse =>
  ({ balance, statements: numbers.map(summary), nextBefore });
const ok = <T,>(data: T): ApiResult<T> => ({ ok: true, data });
const fail = (code: "FORBIDDEN" | "INTERNAL"): ApiResult<never> => ({ ok: false, status: 403, code }) as ApiResult<never>;

describe("opening what a push or a notification points at (#630)", () => {
  it("opens the statement of a statement notification, the order of an order one, and the list of neither", () => {
    expect(openTarget({ orderId: null, statementId: uuid(7) })).toEqual({ pathname: "/money/[id]", params: { id: uuid(7) } });
    expect(openTarget({ orderId: uuid(1), statementId: null })).toEqual({ pathname: "/orders/[id]", params: { id: uuid(1) } });
    expect(openTarget({ orderId: null, statementId: null })).toBe("/notifications");
  });

  it("opens the order first when a row has both, as the server's contract says", () => {
    expect(openTarget({ orderId: uuid(1), statementId: uuid(7) })).toEqual({ pathname: "/orders/[id]", params: { id: uuid(1) } });
  });
});

describe("the Money store (#630, S15)", () => {
  it("loads the balance and the first page, and keeps the server's total as the sum of its two parts", async () => {
    const api = { myStatements: vi.fn(async () => ok(page([3, 2], 2))) };
    const money = createMoney(api);
    expect(money.get().state).toBe("loading");
    await money.load();
    const view = money.get();
    expect(view.state).toBe("loaded");
    expect(view.statements.map((s) => s.number)).toEqual([3, 2]);
    expect(view.hasMore).toBe(true);
    expect(view.balance).toEqual({ onStatements: "215.00", thisWeek: "7.50", total: "222.50" });
  });

  it("shows no balance total that is not its two parts added once", async () => {
    const api = { myStatements: vi.fn(async () => ok(page([], null, { onStatements: "100.00", thisWeek: "7.50", total: "200.00" }))) };
    const money = createMoney(api);
    await money.load();
    // 100 + 7.50 is 107.50: a server total that counts a part twice is never shown as the total.
    expect(money.get().balance).toEqual({ onStatements: "100.00", thisWeek: "7.50", total: "107.50" });
  });

  it("loads the next page with `before`, adds it below, and never lists a statement twice", async () => {
    const api = { myStatements: vi.fn()
      .mockResolvedValueOnce(ok(page([3, 2], 2)))
      .mockResolvedValueOnce(ok(page([2, 1], null))) };
    const money = createMoney(api);
    await money.load();
    await money.more();
    expect(api.myStatements).toHaveBeenLastCalledWith({ before: 2, limit: 20 });
    expect(money.get().statements.map((s) => s.number)).toEqual([3, 2, 1]);
    expect(money.get().hasMore).toBe(false);
    await money.more();
    expect(api.myStatements).toHaveBeenCalledTimes(2);
  });

  it("asks for one page at a time", async () => {
    let release: (value: ApiResult<OwnerStatementsResponse>) => void = () => undefined;
    const api = { myStatements: vi.fn().mockResolvedValueOnce(ok(page([3], 3)))
      .mockReturnValueOnce(new Promise((resolve) => { release = resolve; })) };
    const money = createMoney(api);
    await money.load();
    const first = money.more();
    void money.more();
    expect(api.myStatements).toHaveBeenCalledTimes(2);
    release(ok(page([2], null)));
    await first;
  });

  it("starts again from the newest on refresh", async () => {
    const api = { myStatements: vi.fn()
      .mockResolvedValueOnce(ok(page([2, 1], 1)))
      .mockResolvedValueOnce(ok(page([3, 2], 2))) };
    const money = createMoney(api);
    await money.load();
    await money.refresh();
    expect(money.get().statements.map((s) => s.number)).toEqual([3, 2]);
  });

  it("says the reason when the first read fails, and keeps a list already on screen when a later one does", async () => {
    const api = { myStatements: vi.fn().mockResolvedValueOnce(fail("INTERNAL")).mockResolvedValueOnce(ok(page([1], null))).mockRejectedValueOnce(new Error("offline")) };
    const money = createMoney(api);
    await money.load();
    expect(money.get().state).toBe("failed");
    await money.load();
    expect(money.get().state).toBe("loaded");
    await money.refresh();
    expect(money.get().state).toBe("loaded");
    expect(money.get().refreshFailed).toBe(true);
    expect(money.get().statements).toHaveLength(1);
  });

  it("keeps the balance of the first read when a later page arrives", async () => {
    const api = { myStatements: vi.fn().mockResolvedValueOnce(ok(page([3], 3))).mockResolvedValueOnce(ok(page([2], null, { onStatements: "999.00", thisWeek: "0.00", total: "999.00" }))) };
    const money = createMoney(api);
    await money.load();
    await money.more();
    expect(money.get().balance?.total).toBe("222.50");
  });

  it("offers the next page again when a refresh failed after it was dropped", async () => {
    let release: (value: ApiResult<OwnerStatementsResponse>) => void = () => undefined;
    const api = { myStatements: vi.fn().mockResolvedValueOnce(ok(page([3], 3)))
      .mockReturnValueOnce(new Promise((resolve) => { release = resolve; })).mockResolvedValueOnce(fail("INTERNAL")) };
    const money = createMoney(api);
    await money.load();
    const more = money.more();
    await money.refresh();
    release(ok(page([2], null)));
    await more;
    expect(money.get().moreFailed).toBe(true);
    expect(money.get().statements.map((s) => s.number)).toEqual([3]);
  });

  it("a Statement is only a type here: the detail comes straight from the server", () => {
    const detail = { ...summary(1), shopAddress: null, shopPincode: null, lines: [] } satisfies Statement;
    expect(detail.lines).toEqual([]);
  });
});
