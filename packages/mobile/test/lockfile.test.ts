/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Two installed copies of NativeWind leave every screen unstyled on the phone
// while the gate still passes (#198). pnpm installs one copy per entry under a
// `snapshots:` heading; the lockfile holds two YAML documents, each with one.
const lockfile = readFileSync(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8");

function installedCopies(name: string): number {
  let inSnapshots = false;
  let copies = 0;
  for (const line of lockfile.split(/\r?\n/)) {
    if (/^\S/.test(line)) inSnapshots = line === "snapshots:";
    else if (inSnapshots && line.startsWith(`  ${name}@`)) copies += 1;
  }
  return copies;
}

describe("pnpm-lock.yaml", () => {
  it.each(["nativewind", "react-native-css-interop"])("installs %s once", (name) => {
    const copies = installedCopies(name);
    expect(copies, `${name} is missing from pnpm-lock.yaml`).toBeGreaterThan(0);
    expect(
      copies,
      "NativeWind is installed twice. Make `@ygo/mobile`'s dev dependencies match the apps' versions of `tailwindcss`, `react-native-svg` and `react-native-safe-area-context`.",
    ).toBe(1);
  });
});
