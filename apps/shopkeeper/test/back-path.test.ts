import { expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ answersOrders: false }));
vi.mock("../src/api", () => ({ access: { answersOrders: () => mock.answersOrders } }));
import { backPath } from "../src/lib/back-path";

it("sends Back from a More screen to More once the shop answers orders, and to Home before (#550)", () => {
  expect(backPath()).toBe("/");
  mock.answersOrders = true;
  expect(backPath()).toBe("/more");
});
