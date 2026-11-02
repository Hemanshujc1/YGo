import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BillRow } from "../src/lib/opening-stock-queue";
import { bills, disk } from "./fake-file-system";

// Share sheets stay open until a test closes them, like a sheet the shopkeeper is still using.
const io = vi.hoisted(() => ({ sheets: [] as Array<{ uri: string; existed: () => boolean; close: (error?: Error) => void }>, prints: 0, printing: null as Promise<void> | null }));
vi.mock("@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf", () => ({ default: 1 }));
vi.mock("@expo-google-fonts/inter/500Medium/Inter_500Medium.ttf", () => ({ default: 2 }));
vi.mock("@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf", () => ({ default: 3 }));
vi.mock("expo-asset", () => ({ Asset: { loadAsync: async (id: number) => [{ localUri: `file:///font-${id}.ttf` }] } }));
vi.mock("expo-file-system", () => import("./fake-file-system"));
vi.mock("expo-print", async () => {
  const { disk: files } = await import("./fake-file-system");
  return { printToFileAsync: async () => { await io.printing; const uri = `file:///print-${++io.prints}.pdf`; files.files.set(uri, files.now); return { uri }; } };
});
vi.mock("expo-sharing", async () => {
  const { disk: files } = await import("./fake-file-system");
  return { shareAsync: (uri: string) => new Promise<void>((resolve, reject) => {
    io.sheets.push({ uri, existed: () => files.files.has(uri), close: (error) => error ? reject(error) : resolve() });
  }) };
});

const hour = 60 * 60 * 1000, start = 1_800_000_000_000;
const bill = (reference: string): BillRow => ({ id: `${reference.replace("-", "").toLowerCase()}-0000-4000-8000-000000000001`, reference,
  createdAt: "2026-11-02T06:30:00.000Z", status: "pending", number: null, code: null,
  lines: [], manualLines: [{ name: "Rope", count: 1, unitPrice: "15" }], total: "15.00", payment: "cash" });
const input = (reference: string) => ({ bill: bill(reference), shopName: "Sai", label: () => null });
// The share sheet number n, failing here rather than hanging when it never opened.
async function sheet(n: number) {
  await vi.waitFor(() => expect(io.sheets).toHaveLength(n + 1));
  const open = io.sheets[n];
  if (!open) throw new Error(`share sheet ${n} never opened`);
  return open;
}
function at(time: number) { disk.now = time; vi.spyOn(Date, "now").mockReturnValue(time); }
const pdfs = () => [...disk.files.keys()].filter((uri) => uri.startsWith(`${bills}/`));

describe("sharing bill PDFs (#53, #488)", () => {
  // A fresh module each test, so a sheet left open by one test can't hold the next one's queue.
  let shareBill: typeof import("../src/lib/share-bill").shareBill;
  let removeAllBillPdfs: typeof import("../src/lib/bill-pdf-files").removeAllBillPdfs;
  beforeEach(async () => {
    disk.reset(); io.sheets = []; io.prints = 0; io.printing = null; vi.restoreAllMocks(); at(start);
    vi.resetModules();
    ({ shareBill } = await import("../src/lib/share-bill"));
    ({ removeAllBillPdfs } = await import("../src/lib/bill-pdf-files"));
  });

  it("keeps a finished share's PDF when the next bill is shared, since the receiving app may not have read it yet", async () => {
    const first = shareBill(input("AAAA-0001"));
    const one = await sheet(0);
    expect(one.uri).toMatch(new RegExp(`^${bills}/\\d+-\\d+/YGo bill AAAA-0001\\.pdf$`));
    one.close(); await first;

    at(start + 5 * 60_000);
    const second = shareBill(input("BBBB-0002"));
    const two = await sheet(1);
    expect(one.existed()).toBe(true);
    expect(two.existed()).toBe(true);
    two.close(); await second;
  });

  it("shares the same bill twice into two folders with the same file name, neither touching the other", async () => {
    const first = shareBill(input("AAAA-0001"));
    const one = await sheet(0);
    one.close(); await first;
    const second = shareBill(input("AAAA-0001"));
    const two = await sheet(1);
    expect(two.uri).not.toBe(one.uri);
    expect(two.uri.endsWith("/YGo bill AAAA-0001.pdf")).toBe(true);
    expect(one.existed() && two.existed()).toBe(true);
    two.close(); await second;
  });

  it("deletes PDFs over an hour old before each share, and none younger", async () => {
    for (const [ago, n] of [[hour + 1, 1], [hour - 1, 2]] as const) {
      disk.folders.add(bills); disk.folders.add(`${bills}/${start - ago}-${n}`);
      disk.files.set(`${bills}/${start - ago}-${n}/YGo bill OLD0-000${n}.pdf`, start - ago);
    }
    const sharing = shareBill(input("AAAA-0001"));
    const one = await sheet(0);
    expect(pdfs().sort()).toEqual([`${bills}/${start - hour + 1}-2/YGo bill OLD0-0002.pdf`, one.uri].sort());
    one.close(); await sharing;
  });

  it("finishes an unfinished sign-out clear before sharing, without restarting the app", async () => {
    const old = `${bills}/${start - 60_000}-1`;
    disk.folders.add(bills); disk.folders.add(old); disk.files.set(`${old}/YGo bill OLD0-0001.pdf`, start - 60_000);
    disk.folders.add("file:///documents/bill-pdf-clears"); disk.files.set(`file:///documents/bill-pdf-clears/${start - 1}`, start - 1);
    const sharing = shareBill(input("AAAA-0001"));
    const one = await sheet(0);
    expect(pdfs()).toEqual([one.uri]);
    one.close(); await sharing;
  });

  it("still shares when cleanup fails", async () => {
    disk.folders.add(bills); disk.failList = true;
    const sharing = shareBill(input("AAAA-0001"));
    const one = await sheet(0);
    expect(one.existed()).toBe(true);
    one.close(); await expect(sharing).resolves.toBeUndefined();
  });

  it("runs overlapping shares one at a time, and the open sheet's PDF stays", async () => {
    const first = shareBill(input("AAAA-0001")), second = shareBill(input("BBBB-0002"));
    const one = await sheet(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(io.sheets).toHaveLength(1);
    expect(io.prints).toBe(1);
    one.close(); await first;
    const two = await sheet(1);
    expect(one.existed() && two.existed()).toBe(true);
    two.close(); await second;
  });

  it("goes on to the next share after one fails", async () => {
    const first = shareBill(input("AAAA-0001")), second = shareBill(input("BBBB-0002"));
    (await sheet(0)).close(new Error("sheet failed"));
    await expect(first).rejects.toThrow("sheet failed");
    (await sheet(1)).close(); await expect(second).resolves.toBeUndefined();
  });

  it("removes the printed PDF and its empty folder when it can't be moved", async () => {
    disk.failMove = true;
    await expect(shareBill(input("AAAA-0001"))).rejects.toThrow("disk full");
    expect([...disk.files.keys()]).toEqual([]);
    expect([...disk.folders].filter((uri) => uri.startsWith(`${bills}/`))).toEqual([]);
  });

  it("keeps no PDF from a share still printing or waiting when the shopkeeper signs out", async () => {
    let printed!: () => void;
    io.printing = new Promise((resolve) => { printed = resolve; });
    const printing = shareBill(input("AAAA-0001")), waiting = shareBill(input("BBBB-0002"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    removeAllBillPdfs();
    printed();
    await expect(printing).rejects.toThrow("Signed out");
    await expect(waiting).rejects.toThrow("Signed out");
    // The waiting share stops before printing.
    expect(io.prints).toBe(1);
    expect(io.sheets).toHaveLength(0);
    expect([...disk.files.keys()]).toEqual([]);
  });
});
