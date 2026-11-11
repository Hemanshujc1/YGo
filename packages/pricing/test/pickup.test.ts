import { expect, it } from "vitest";
import { PICKUP_EXAMPLES, pickupPrice } from "../src";

it.each(PICKUP_EXAMPLES)("prices the pickup route: $name", ({ rule, productValue, shopDiscount, expected }) => {
  expect(pickupPrice({ productValue, shopDiscount, rule })).toEqual({ ...expected });
});
