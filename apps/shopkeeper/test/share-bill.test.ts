import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BillRow } from "../src/lib/opening-stock-queue";

// A tiny file system: the paths that exist, a folder delete that removes what's inside, and a share sheet that stays open until told.
const fs = vi.hoisted(() => ({ files: new Set<string>(), sheets: [] as Array<{ uri: string; existed: () => boolean; close: (error?: Error) => void }>, prints: 0, moveFails: false }));
vi.mock("@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf", () => ({ default: 1 }));
vi.mock("@expo-google-fonts/inter/500Medium/Inter_500Medium.ttf", () => ({ default: 2 }));
vi.mock("@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf", () => ({ default: 3 }));
vi.mock("expo-asset", () => ({ Asset: { loadAsync: async (id: number) => [{ localUri: `file:///font-${id}.ttf` }] } }));
vi.mock("expo-file-system", () => {
  const path = (parts: Array<string | { uri: string }>) => parts.map((part) => typeof part === "string" ? part : part.uri).join("/");
  class File {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) { this.uri = path(parts); }
    async base64() { return "Rk9OVA=="; }
    get exists() { return fs.files.has(this.uri); }
    delete() { fs.files.delete(this.uri); }
    async move(to: { uri: string }) { if (fs.moveFails) throw new Error("disk full"); fs.files.delete(this.uri); fs.files.add(to.uri); }
  }
  class Directory {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) { this.uri = path(parts); }
    get exists() { return [...fs.files].some((file) => file.startsWith(`${this.uri}/`)); }
    delete() { for (const file of [...fs.files]) if (file.startsWith(`${this.uri}/`)) fs.files.delete(file); }
    create() {}
  }
  return { File, Directory, Paths: { cache: { uri: "file:///cache" } } };
});
vi.mock("expo-print", () => ({ printToFileAsync: async () => { const uri = `file:///print-${++fs.prints}.pdf`; fs.files.add(uri); return { uri }; } }));
vi.mock("expo-sharing", () => ({ shareAsync: (uri: string) => new Promise<void>((resolve, reject) => {
  fs.sheets.push({ uri, existed: () => fs.files.has(uri), close: (error) => error ? reject(error) : resolve() });
}) }));

const bill = (reference: string): BillRow => ({ id: randomish(reference), reference, createdAt: "2026-11-02T06:30:00.000Z", status: "pending", number: null, code: null,
  lines: [], manualLines: [{ name: "Rope", count: 1, unitPrice: "15" }], total: "15.00", payment: "cash" });
function randomish(reference: string) { return `${reference.replace("-", "").toLowerCase()}-0000-4000-8000-000000000001`; }
const input = (reference: string) => ({ bill: bill(reference), shopName: "Sai", label: () => null });
// The open share sheet number n, failing here rather than hanging when it never opened.
async function sheet(n: number) {
  await vi.waitFor(() => expect(fs.sheets).toHaveLength(n + 1));
  const open = fs.sheets[n];
  if (!open) throw new Error(`share sheet ${n} never opened`);
  return open;
}

describe("sharing bill PDFs (#53)", () => {
  // A fresh module each test, so a sheet left open by one test can't hold the next one's queue.
  let shareBill: typeof import("../src/lib/share-bill").shareBill;
  beforeEach(async () => {
    fs.files.clear(); fs.sheets = []; fs.prints = 0; fs.moveFails = false;
    vi.resetModules();
    ({ shareBill } = await import("../src/lib/share-bill"));
  });

  it("waits for an open share sheet before making the next PDF, so emptying the folder never removes the one being shared", async () => {
    const first = shareBill(input("AAAA-0001")), second = shareBill(input("BBBB-0002"));
    const one = await sheet(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fs.sheets).toHaveLength(1);
    expect(fs.prints).toBe(1);
    expect(one.existed()).toBe(true);

    one.close(); await first;
    const two = await sheet(1);
    expect(two.uri).toBe("file:///cache/bills/YGo bill BBBB-0002.pdf");
    // Cleanup still keeps only the latest PDF.
    expect([...fs.files]).toEqual(["file:///cache/bills/YGo bill BBBB-0002.pdf"]);
    two.close(); await second;
  });

  it("goes on to the next share after one fails", async () => {
    const first = shareBill(input("AAAA-0001")), second = shareBill(input("BBBB-0002"));
    (await sheet(0)).close(new Error("sheet failed"));
    await expect(first).rejects.toThrow("sheet failed");
    (await sheet(1)).close(); await expect(second).resolves.toBeUndefined();
  });

  it("removes the printed PDF when it can't be moved into the bills folder", async () => {
    fs.moveFails = true;
    await expect(shareBill(input("AAAA-0001"))).rejects.toThrow("disk full");
    expect([...fs.files]).toEqual([]);
  });
});
