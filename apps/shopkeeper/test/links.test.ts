import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// A bare expo-router Link ignores NativeWind classes, so its text shows black on the dark background (#449).
it("styles every Link through asChild", () => {
  const root = join(__dirname, "../src");
  const files = (readdirSync(root, { recursive: true }) as string[]).filter((name) => name.endsWith(".tsx"));
  const bare = files.filter((name) => /<Link\b(?![^>]*\basChild\b)[^>]*\bclassName=/.test(readFileSync(join(root, name), "utf8")));
  expect(bare).toEqual([]);
});
