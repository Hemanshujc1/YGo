import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A pack size such as "1.000" arrives as text from the server; it shows through trimDecimal (#413, #451).
describe("quantities", () => {
  it("never shows a pack size or quantity untrimmed", () => {
    const root = join(__dirname, ".");
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"));
    const raw = files.filter((name) => /(?<!=)\{(?:item|pack|option|line|listing|deactivating)\.(?:packQuantity|quantity)\}/.test(readFileSync(join(root, name), "utf8")));
    expect(raw).toEqual([]);
  });
});
