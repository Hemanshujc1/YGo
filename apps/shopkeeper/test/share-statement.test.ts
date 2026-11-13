import type { Statement } from "@ygo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { disk } from "./fake-file-system";

const io = vi.hoisted(() => ({ shared: [] as Array<{ uri: string; options: unknown }>, html: [] as string[] }));
vi.mock("@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf", () => ({ default: 1 }));
vi.mock("@expo-google-fonts/inter/500Medium/Inter_500Medium.ttf", () => ({ default: 2 }));
vi.mock("@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf", () => ({ default: 3 }));
vi.mock("expo-asset", () => ({ Asset: { loadAsync: async (id: number) => [{ localUri: `file:///font-${id}.ttf` }] } }));
vi.mock("expo-file-system", () => import("./fake-file-system"));
vi.mock("expo-print", async () => {
  const { disk: files } = await import("./fake-file-system");
  return { printToFileAsync: async ({ html }: { html: string }) => { io.html.push(html); const uri = `file:///print-${io.html.length}.pdf`; files.files.set(uri, files.now); return { uri }; } };
});
vi.mock("expo-sharing", () => ({ shareAsync: async (uri: string, options: unknown) => { io.shared.push({ uri, options }); } }));

const id = "7d2e9a4c-6b1f-4c3a-8e5d-0f2a4b6c8d1e";
const statement: Statement = { id, number: 7, shopId: id, shopName: "Sai", periodStart: "2026-11-02", periodEnd: "2026-11-08", issuedAt: "2026-11-09T00:30:00.000Z",
  dueOn: "2026-11-16", orderCount: 0, total: "0.00", shopAddress: null, shopPincode: null, lines: [] };

describe("sharing a statement PDF (#630)", () => {
  beforeEach(() => { disk.reset(); io.shared = []; io.html = []; vi.resetModules(); });

  it("makes the PDF on the phone, names it after the statement, and opens the share sheet", async () => {
    const { shareStatement } = await import("../src/lib/share-statement");
    await shareStatement(statement);
    expect(io.html[0]).toContain("not a tax invoice");
    expect(io.shared).toHaveLength(1);
    expect(io.shared[0]?.uri).toContain("YGo statement 7.pdf");
    expect(io.shared[0]?.options).toMatchObject({ mimeType: "application/pdf" });
  });

  it("leaves no printed copy behind in the cache", async () => {
    const { shareStatement } = await import("../src/lib/share-statement");
    await shareStatement(statement);
    expect(disk.files.has("file:///print-1.pdf")).toBe(false);
  });
});
