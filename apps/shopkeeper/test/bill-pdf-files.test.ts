import { beforeEach, describe, expect, it, vi } from "vitest";
import { bills, disk } from "./fake-file-system";

vi.mock("expo-file-system", () => import("./fake-file-system"));
import { BILL_PDF_MAX_AGE_MS, removeAllBillPdfs, removeOldBillPdfs, retryBillPdfClear, shareFolder } from "../src/lib/bill-pdf-files";

const hour = BILL_PDF_MAX_AGE_MS, now = 1_800_000_000_000;
// One shared PDF in its own folder, made `ago` ms before now.
function shared(ago: number, n = 1) {
  const folder = `${bills}/${now - ago}-${n}`;
  disk.folders.add(bills); disk.folders.add(folder);
  disk.files.set(`${folder}/YGo bill A1B2-C3D4.pdf`, now - ago);
  return folder;
}
const marker = "file:///documents/bill-pdfs-clear-pending";
const pdfFiles = () => [...disk.files.keys()].filter((uri) => uri.startsWith(`${bills}/`) || uri.startsWith("file:///cache/Print/"));
const left = () => [...disk.folders].filter((uri) => uri.startsWith(`${bills}/`)).sort();

describe("shared bill PDF files (#488)", () => {
  beforeEach(() => disk.reset());

  it("deletes only PDFs over an hour old, and keeps younger ones, ones of unknown age and ones dated ahead", () => {
    const old = shared(hour + 1), edge = shared(hour, 2), young = shared(60_000, 3), ahead = shared(-60_000, 4);
    disk.folders.add(`${bills}/notes`);
    // A loose PDF from #486's layout goes by its modification time.
    disk.files.set(`${bills}/YGo bill OLD0-0001.pdf`, now - hour - 1);
    disk.files.set(`${bills}/YGo bill NEW0-0002.pdf`, now - 1);
    removeOldBillPdfs(now);
    expect(left()).toEqual([edge, young, ahead, `${bills}/notes`].sort());
    expect(disk.folders.has(old)).toBe(false);
    expect(disk.files.has(`${bills}/YGo bill OLD0-0001.pdf`)).toBe(false);
    expect(disk.files.has(`${bills}/YGo bill NEW0-0002.pdf`)).toBe(true);
  });

  it("goes on past a folder it can't delete, and never throws", () => {
    const stuck = shared(hour * 2), old = shared(hour * 3, 2);
    disk.failDelete.add(stuck);
    expect(() => removeOldBillPdfs(now)).not.toThrow();
    expect(left()).toEqual([stuck]);
    expect(disk.folders.has(old)).toBe(false);
    disk.failList = true;
    expect(() => removeOldBillPdfs(now)).not.toThrow();
    expect(() => removeOldBillPdfs(now)).not.toThrow();
  });

  it("never throws when the cache folder itself can't be reached", async () => {
    vi.resetModules();
    vi.doMock("expo-file-system", async () => ({ ...await import("./fake-file-system"), Paths: { get cache(): never { throw new Error("no cache"); } } }));
    const broken = await import("../src/lib/bill-pdf-files");
    expect(() => broken.removeOldBillPdfs(now)).not.toThrow();
    expect(() => broken.removeAllBillPdfs()).not.toThrow();
    vi.doMock("expo-file-system", () => import("./fake-file-system"));
  });

  it("does nothing before any bill was shared", () => {
    expect(() => removeOldBillPdfs(now)).not.toThrow();
    expect(() => removeAllBillPdfs()).not.toThrow();
  });

  it("removes every PDF, young ones too, on sign-out or erase", () => {
    shared(1); shared(hour * 2, 2);
    expect(removeAllBillPdfs(now)).toBe(true);
    expect(disk.folders.has(bills)).toBe(false);
    expect(disk.files.size).toBe(0);
    expect(disk.files.has(marker)).toBe(false);
  });

  it("empties a folder file by file when the folder itself won't delete", () => {
    const a = shared(1), b = shared(hour * 2, 2);
    // The bills folder and one share folder refuse to go; their files don't.
    disk.failDelete.add(bills); disk.failDelete.add(a);
    expect(removeAllBillPdfs(now)).toBe(true);
    expect(pdfFiles()).toEqual([]);
    expect(disk.folders.has(b)).toBe(false);
    // Empty folders hold no customer data, so nothing is left to retry.
    expect(disk.files.has(marker)).toBe(false);
  });

  it("records a PDF that won't delete, and finishes the clear at the next launch", () => {
    const a = shared(1), b = shared(hour * 2, 2);
    const stuck = `${a}/YGo bill A1B2-C3D4.pdf`;
    disk.failDelete.add(stuck);
    expect(() => removeAllBillPdfs(now)).not.toThrow();
    expect(pdfFiles()).toEqual([stuck]);
    expect(disk.folders.has(b)).toBe(false);
    expect(disk.texts.get(marker)).toBe(String(now));

    // Still stuck at the next launch: the record stays.
    expect(retryBillPdfClear()).toBe(false);
    expect(disk.files.has(marker)).toBe(true);

    // Later it can go. A PDF the next account shared after the clear stays.
    disk.failDelete.clear();
    const next = `${bills}/${now + 60_000}-9`;
    disk.folders.add(next); disk.files.set(`${next}/YGo bill NEXT-0001.pdf`, now + 60_000);
    expect(retryBillPdfClear()).toBe(true);
    expect(pdfFiles()).toEqual([`${next}/YGo bill NEXT-0001.pdf`]);
    expect(disk.files.has(marker)).toBe(false);
  });

  it("retries a loose printer file that wouldn't delete, by its age", () => {
    const print = "file:///cache/Print";
    disk.folders.add(print); disk.files.set(`${print}/old.pdf`, now - 1);
    disk.failDelete.add(`${print}/old.pdf`);
    expect(removeAllBillPdfs(now)).toBe(false);
    disk.failDelete.clear();
    disk.files.set(`${print}/later.pdf`, now + 1);
    expect(retryBillPdfClear()).toBe(true);
    expect([...disk.files.keys()].filter((uri) => uri.startsWith(print))).toEqual([`${print}/later.pdf`]);
  });

  it("does nothing at launch when no clear is waiting, and a clean clear drops an old record", () => {
    expect(retryBillPdfClear()).toBe(true);
    shared(1); disk.failDelete.add(`${bills}/${now - 1}-1/YGo bill A1B2-C3D4.pdf`);
    removeAllBillPdfs(now);
    expect(disk.files.has(marker)).toBe(true);
    disk.failDelete.clear();
    expect(removeAllBillPdfs(now + 1)).toBe(true);
    expect(disk.files.has(marker)).toBe(false);
  });

  it("treats a blank or broken record as unknown and deletes every PDF at the retry", () => {
    for (const text of ["", "0", "garbage"]) {
      shared(1); disk.files.set(marker, now); disk.texts.set(marker, text);
      expect(retryBillPdfClear()).toBe(true);
      expect(pdfFiles()).toEqual([]);
      expect(disk.files.has(marker)).toBe(false);
    }
  });

  it("keeps the later clear time when a second clear also fails, as after the clock went back", () => {
    const a = shared(1);
    disk.failDelete.add(`${a}/YGo bill A1B2-C3D4.pdf`);
    removeAllBillPdfs(now);
    removeAllBillPdfs(now - hour);
    expect(disk.texts.get(marker)).toBe(String(now));
  });

  it("keeps the record when the cache can't be reached at the retry", async () => {
    disk.files.set(marker, now); disk.texts.set(marker, String(now));
    vi.resetModules();
    vi.doMock("expo-file-system", async () => ({ ...await import("./fake-file-system"), Paths: { document: { uri: "file:///documents" }, get cache(): never { throw new Error("no cache"); } } }));
    const broken = await import("../src/lib/bill-pdf-files");
    expect(broken.retryBillPdfClear()).toBe(false);
    expect(disk.files.has(marker)).toBe(true);
    vi.doMock("expo-file-system", () => import("./fake-file-system"));
  });

  it("never throws when listing fails during a fallback, and keeps the record", () => {
    shared(1); disk.failDelete.add(bills); disk.failList = true;
    expect(() => removeAllBillPdfs(now)).not.toThrow();
    expect(disk.files.has(marker)).toBe(true);
    expect(() => retryBillPdfClear()).not.toThrow();
  });

  it("treats expo-print's Print folder the same way: old files go routinely, all go on sign-out", () => {
    const print = "file:///cache/Print";
    disk.folders.add(print);
    disk.files.set(`${print}/old.pdf`, now - hour - 1); disk.files.set(`${print}/new.pdf`, now - 1);
    removeOldBillPdfs(now);
    expect([...disk.files.keys()]).toEqual([`${print}/new.pdf`]);
    removeAllBillPdfs();
    expect(disk.files.size).toBe(0);
  });

  it("gives each share its own new folder, even in the same millisecond", () => {
    const a = shareFolder(now), b = shareFolder(now);
    expect(a.uri).not.toBe(b.uri);
    expect(disk.folders.has(a.uri) && disk.folders.has(b.uri)).toBe(true);
    expect(a.name).toMatch(new RegExp(`^${now}-\\d+$`));
  });

  it("skips a folder name already taken, as after the clock goes back", async () => {
    vi.resetModules();
    const fresh = await import("../src/lib/bill-pdf-files");
    disk.folders.add(bills); disk.folders.add(`${bills}/${now}-1`);
    expect(fresh.shareFolder(now).name).toBe(`${now}-2`);
  });
});
