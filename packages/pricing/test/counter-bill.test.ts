import { expect, it } from "vitest";
import { COUNTER_BILL_EXAMPLES, counterBillTotal } from "../src";

it.each(COUNTER_BILL_EXAMPLES)("works out the total for $name", ({ lines, total }) => {
  expect(counterBillTotal(lines)).toBe(total);
});
