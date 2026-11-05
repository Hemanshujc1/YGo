import { expect, it } from "vitest";
import { spokenDuration } from "../src/notifications";

it("words any expiry time exactly", () => {
  expect(spokenDuration(600)).toBe("10 minutes");
  expect(spokenDuration(60)).toBe("1 minute");
  expect(spokenDuration(45)).toBe("45 seconds");
  expect(spokenDuration(1)).toBe("1 second");
  expect(spokenDuration(90)).toBe("1 minute 30 seconds");
  expect(spokenDuration(125)).toBe("2 minutes 5 seconds");
});
