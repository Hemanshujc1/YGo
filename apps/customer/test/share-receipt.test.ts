import type { ReceiptResponse } from "@ygo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { disk, receipts } from "./fake-file-system";

const io = vi.hoisted(() => ({ prints: 0, failPrint: false, failShare: false, shared: [] as string[], html: [] as string[] }));
vi.mock("@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf", () => ({ default: 1 }));
vi.mock("@expo-google-fonts/inter/500Medium/Inter_500Medium.ttf", () => ({ default: 2 }));
vi.mock("@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf", () => ({ default: 3 }));
vi.mock("expo-asset", () => ({ Asset: { loadAsync: async (id: number) => [{ localUri: `file:///font-${id}.ttf` }] } }));
vi.mock("expo-file-system", () => import("./fake-file-system"));
vi.mock("expo-print", async () => {
  const { disk: files } = await import("./fake-file-system");
  return { printToFileAsync: async ({ html }: { html: string }) => {
    if (io.failPrint) throw new Error("print failed");
    io.html.push(html);
    const uri = `file:///cache/Print/print-${++io.prints}.pdf`; files.files.set(uri, files.now); return { uri };
  } };
});
vi.mock("expo-sharing", () => ({ shareAsync: async (uri: string) => { if (io.failShare) throw new Error("no share"); io.shared.push(uri); } }));

const start = 1_800_000_000_000, hour = 60 * 60 * 1000;
const receipt = { number: 1042, status: "delivered", placedAt: "2030-01-01T04:30:00.000Z", shop: { name: "Sai", address: "Paud Road", pincode: "411038", gstin: null },
  address: { label: "home", areaLine: null }, lines: [], productValue: "10", shopDiscount: null, deliveryFee: "0", smallCartFee: null, pickupFee: null, total: "10", payment: null } as ReceiptResponse;
const stray = "file:///cache/Print/other-app-file.pdf";

describe("sharing receipt PDFs (#61)", () => {
  let shareReceipt: typeof import("../src/lib/share-receipt").shareReceipt;
  beforeEach(async () => {
    disk.reset(); io.prints = 0; io.failPrint = false; io.failShare = false; io.shared = []; io.html = [];
    vi.restoreAllMocks(); vi.spyOn(Date, "now").mockReturnValue(start); disk.now = start;
    vi.resetModules();
    ({ shareReceipt } = await import("../src/lib/share-receipt"));
  });

  it("prints the receipt, names it for the order in its own folder, shares it and leaves no temp file", async () => {
    await shareReceipt(receipt);
    expect(io.html[0]).toContain("Order #1042");
    expect(io.shared).toHaveLength(1);
    expect(io.shared[0]).toMatch(new RegExp(`^${receipts}/\\d+-\\d+/YGo receipt #1042\\.pdf$`));
    expect(disk.files.has("file:///cache/Print/print-1.pdf")).toBe(false);
  });

  it("deletes the temp file and its folder when the PDF can't be moved, and reports the failure", async () => {
    disk.failMove = true;
    await expect(shareReceipt(receipt)).rejects.toThrow("disk full");
    expect([...disk.files.keys()].filter((uri) => uri.includes("print-"))).toEqual([]);
    expect([...disk.folders].filter((uri) => uri.startsWith(`${receipts}/`))).toEqual([]);
  });

  it("reports a failed print and a failed share sheet, and the next share still works", async () => {
    io.failPrint = true;
    await expect(shareReceipt(receipt)).rejects.toThrow("print failed");
    io.failPrint = false; io.failShare = true;
    await expect(shareReceipt(receipt)).rejects.toThrow("no share");
    expect(disk.files.has("file:///cache/Print/print-1.pdf")).toBe(false);
    io.failShare = false;
    await shareReceipt(receipt);
    expect(io.shared).toHaveLength(1);
  });

  it("before a share, deletes only receipt folders over an hour old and touches nothing outside its folder", async () => {
    const old = `${receipts}/${start - hour - 1}-1`, young = `${receipts}/${start - 60_000}-2`;
    disk.folders.add(receipts);
    for (const folder of [old, young]) { disk.folders.add(folder); disk.files.set(`${folder}/YGo receipt #1.pdf`, start); }
    disk.files.set(stray, start - 10 * hour);
    disk.files.set("file:///cache/bills/YGo bill A.pdf", start - 10 * hour);
    await shareReceipt(receipt);
    expect(disk.files.has(`${old}/YGo receipt #1.pdf`)).toBe(false);
    expect(disk.files.has(`${young}/YGo receipt #1.pdf`)).toBe(true);
    expect(disk.files.has(stray)).toBe(true);
    expect(disk.files.has("file:///cache/bills/YGo bill A.pdf")).toBe(true);
  });

  it("goes on sharing when cleanup can't read or delete", async () => {
    disk.folders.add(receipts); disk.folders.add(`${receipts}/${start - 2 * hour}-1`);
    disk.failList = true;
    await shareReceipt(receipt);
    expect(io.shared).toHaveLength(1);
  });
});
