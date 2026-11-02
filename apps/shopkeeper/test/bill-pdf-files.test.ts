import { beforeEach, describe, expect, it, vi } from "vitest";
import { bills, disk } from "./fake-file-system";

vi.mock("expo-file-system", () => import("./fake-file-system"));
type Files = typeof import("../src/lib/bill-pdf-files");

const hour = 60 * 60 * 1000, now = 1_800_000_000_000;
const print = "file:///cache/Print", recordFolder = "file:///documents/bill-pdf-clears";
// One shared PDF in its own folder, made `ago` ms before now.
function shared(ago: number, n = 1) {
  const folder = `${bills}/${now - ago}-${n}`;
  disk.folders.add(bills); disk.folders.add(folder);
  disk.files.set(`${folder}/YGo bill A1B2-C3D4.pdf`, now - ago);
  return folder;
}
const pdf = (folder: string) => `${folder}/YGo bill A1B2-C3D4.pdf`;
const pdfFiles = () => [...disk.files.keys()].filter((uri) => uri.startsWith(`${bills}/`) || uri.startsWith(`${print}/`)).sort();
const records = () => [...disk.files.keys()].filter((uri) => uri.startsWith(`${recordFolder}/`)).map((uri) => uri.slice(recordFolder.length + 1)).sort();
const left = () => [...disk.folders].filter((uri) => uri.startsWith(`${bills}/`)).sort();
// A restart: the module, and what it remembers, starts again.
async function restart(): Promise<Files> { vi.resetModules(); return import("../src/lib/bill-pdf-files"); }

describe("shared bill PDF files (#488)", () => {
  let files: Files;
  beforeEach(async () => {
    disk.reset();
    files = await restart();
  });

  describe("routine cleanup", () => {
    it("deletes only PDFs over an hour old, and keeps younger ones, ones of unknown age and ones dated ahead", () => {
      const old = shared(hour + 1), edge = shared(hour, 2), young = shared(60_000, 3), ahead = shared(-60_000, 4);
      disk.folders.add(`${bills}/notes`);
      // A loose PDF from #486's layout goes by its modification time.
      disk.files.set(`${bills}/YGo bill OLD0-0001.pdf`, now - hour - 1);
      disk.files.set(`${bills}/YGo bill NEW0-0002.pdf`, now - 1);
      files.removeOldBillPdfs(now);
      expect(left()).toEqual([edge, young, ahead, `${bills}/notes`].sort());
      expect(disk.folders.has(old)).toBe(false);
      expect(disk.files.has(`${bills}/YGo bill OLD0-0001.pdf`)).toBe(false);
      expect(disk.files.has(`${bills}/YGo bill NEW0-0002.pdf`)).toBe(true);
    });

    it("goes on past a folder it can't delete, and never throws", () => {
      const stuck = shared(hour * 2), old = shared(hour * 3, 2);
      disk.failDelete.add(stuck);
      expect(() => files.removeOldBillPdfs(now)).not.toThrow();
      expect(left()).toEqual([stuck]);
      expect(disk.folders.has(old)).toBe(false);
      disk.failList = true;
      expect(() => files.removeOldBillPdfs(now)).not.toThrow();
    });

    it("treats expo-print's Print folder the same way: old files go routinely, all go on sign-out", () => {
      disk.folders.add(print);
      disk.files.set(`${print}/old.pdf`, now - hour - 1); disk.files.set(`${print}/new.pdf`, now - 1);
      files.removeOldBillPdfs(now);
      expect(pdfFiles()).toEqual([`${print}/new.pdf`]);
      files.removeAllBillPdfs(now);
      expect(pdfFiles()).toEqual([]);
    });

    it("does nothing before any bill was shared", () => {
      expect(() => files.removeOldBillPdfs(now)).not.toThrow();
      expect(files.removeAllBillPdfs(now)).toBe(true);
      expect(files.retryBillPdfClear()).toBe(true);
    });

    it("never throws when the cache folder itself can't be reached", async () => {
      vi.resetModules();
      vi.doMock("expo-file-system", async () => ({ ...await import("./fake-file-system"), Paths: { document: { uri: "file:///documents" }, get cache(): never { throw new Error("no cache"); } } }));
      const broken = await import("../src/lib/bill-pdf-files");
      expect(() => broken.removeOldBillPdfs(now)).not.toThrow();
      expect(() => broken.removeAllBillPdfs(now)).not.toThrow();
      vi.doMock("expo-file-system", () => import("./fake-file-system"));
    });
  });

  describe("share folders", () => {
    it("gives each share its own new folder, even in the same millisecond", () => {
      const a = files.shareFolder(now), b = files.shareFolder(now);
      expect(a.uri).not.toBe(b.uri);
      expect(disk.folders.has(a.uri) && disk.folders.has(b.uri)).toBe(true);
      expect(a.name).toMatch(new RegExp(`^${now}-\\d+$`));
    });

    it("skips a folder name already taken, as after the clock goes back", () => {
      disk.folders.add(bills); disk.folders.add(`${bills}/${now}-1`);
      expect(files.shareFolder(now).name).toBe(`${now}-2`);
    });
  });

  describe("full clear on sign-out, account switch and erase", () => {
    it("removes every PDF, young ones too, and records nothing", () => {
      shared(1); shared(hour * 2, 2);
      expect(files.removeAllBillPdfs(now)).toBe(true);
      expect(disk.folders.has(bills)).toBe(false);
      expect(pdfFiles()).toEqual([]);
      expect(records()).toEqual([]);
    });

    it("empties a folder file by file when the folder itself won't delete", () => {
      const a = shared(1), b = shared(hour * 2, 2);
      disk.failDelete.add(bills); disk.failDelete.add(a);
      expect(files.removeAllBillPdfs(now)).toBe(true);
      expect(pdfFiles()).toEqual([]);
      expect(disk.folders.has(b)).toBe(false);
      // Empty folders hold no customer data, so nothing is left to retry.
      expect(records()).toEqual([]);
    });

    it("records a PDF that won't delete, and finishes the clear at the next launch", async () => {
      const a = shared(1), b = shared(hour * 2, 2);
      disk.failDelete.add(pdf(a));
      expect(files.removeAllBillPdfs(now)).toBe(false);
      expect(pdfFiles()).toEqual([pdf(a)]);
      expect(disk.folders.has(b)).toBe(false);
      expect(records()).toEqual([String(now)]);

      // Still stuck at the next launch: the record stays.
      files = await restart();
      expect(files.retryBillPdfClear()).toBe(false);
      expect(records()).toEqual([String(now)]);

      // Later it can go. A PDF the next account shared after the clear stays.
      disk.failDelete.clear();
      const next = `${bills}/${now + 60_000}-9`;
      disk.folders.add(next); disk.files.set(pdf(next), now + 60_000);
      expect(files.retryBillPdfClear()).toBe(true);
      expect(pdfFiles()).toEqual([pdf(next)]);
      expect(records()).toEqual([]);
    });

    it("retries a loose printer file that wouldn't delete, by its age", () => {
      disk.folders.add(print); disk.files.set(`${print}/old.pdf`, now - 1);
      disk.failDelete.add(`${print}/old.pdf`);
      expect(files.removeAllBillPdfs(now)).toBe(false);
      disk.failDelete.clear();
      disk.files.set(`${print}/later.pdf`, now + 1);
      expect(files.retryBillPdfClear()).toBe(true);
      expect(pdfFiles()).toEqual([`${print}/later.pdf`]);
    });

    it("drops every earlier record once a later clear removes every PDF", () => {
      const a = shared(1);
      disk.failDelete.add(pdf(a));
      files.removeAllBillPdfs(now);
      expect(records()).toEqual([String(now)]);
      disk.failDelete.clear();
      expect(files.removeAllBillPdfs(now + 1)).toBe(true);
      expect(records()).toEqual([]);
    });

    it("never throws when listing fails during a fallback, and keeps the record", () => {
      shared(1); disk.failDelete.add(bills); disk.failList = true;
      expect(() => files.removeAllBillPdfs(now)).not.toThrow();
      disk.failList = false;
      expect(records()).toEqual([String(now)]);
    });
  });

  describe("the record of unfinished clears", () => {
    // Account A's clear at `now` fails on a stuck PDF; account B then shares a PDF that also gets stuck.
    function twoAccounts() {
      const a = shared(1);
      disk.failDelete.add(pdf(a));
      files.removeAllBillPdfs(now);
      const b = `${bills}/${now + 60_000}-7`;
      disk.folders.add(b); disk.files.set(pdf(b), now + 60_000);
      disk.failDelete.add(pdf(b));
      return { a, b, later: now + 120_000 };
    }

    it("covers a newer failed clear: each clear adds its own record, and the retry uses the latest", () => {
      const { a, b, later } = twoAccounts();
      expect(files.removeAllBillPdfs(later)).toBe(false);
      expect(records()).toEqual([String(now), String(later)].sort());
      disk.failDelete.clear();
      expect(files.retryBillPdfClear()).toBe(true);
      expect(pdfFiles()).not.toContain(pdf(a));
      expect(pdfFiles()).not.toContain(pdf(b));
      expect(records()).toEqual([]);
    });

    it("records 'unknown' when the newer clear's time can't be recorded, so the retry deletes everything", async () => {
      const { a, b, later } = twoAccounts();
      disk.failCreate.add(`${recordFolder}/${later}`);
      expect(files.removeAllBillPdfs(later)).toBe(false);
      // The older record is never discarded.
      expect(records()).toEqual([String(now), "unknown"].sort());

      // After a restart, B's PDF is still covered: nothing is called done while it is stuck.
      files = await restart();
      disk.failDelete.delete(pdf(a));
      expect(files.retryBillPdfClear()).toBe(false);
      expect(records()).toEqual([String(now), "unknown"].sort());
      disk.failDelete.clear();
      expect(files.retryBillPdfClear()).toBe(true);
      expect(pdfFiles()).not.toContain(pdf(b));
      expect(records()).toEqual([]);
    });

    it("turns the older record into 'unknown' when no new record can be made, as on a full disk, so a restart still covers B", async () => {
      const { a, b, later } = twoAccounts();
      disk.failCreate.add(`${recordFolder}/${later}`); disk.failCreate.add(`${recordFolder}/unknown`);
      expect(files.removeAllBillPdfs(later)).toBe(false);
      expect(records()).toEqual(["unknown"]);

      files = await restart();
      disk.failDelete.delete(pdf(a));
      expect(files.retryBillPdfClear()).toBe(false);
      expect(records()).toEqual(["unknown"]);
      disk.failDelete.clear();
      expect(files.retryBillPdfClear()).toBe(true);
      expect(pdfFiles()).not.toContain(pdf(b));
      expect(records()).toEqual([]);
    });

    it("keeps the older record and covers everything this session when no record can be made or renamed", () => {
      const { a, b, later } = twoAccounts();
      disk.failCreate.add(`${recordFolder}/${later}`); disk.failCreate.add(`${recordFolder}/unknown`); disk.failRename = true;
      expect(files.removeAllBillPdfs(later)).toBe(false);
      expect(records()).toEqual([String(now)]);

      // The older record's time doesn't reach B's PDF, but the session still covers it.
      disk.failDelete.delete(pdf(a));
      expect(files.retryBillPdfClear()).toBe(false);
      expect(records()).toEqual([String(now)]);
      disk.failDelete.clear();
      expect(files.retryBillPdfClear()).toBe(true);
      expect(pdfFiles()).not.toContain(pdf(b));
      expect(records()).toEqual([]);
    });

    it("covers everything this session when the record folder can't be made", () => {
      const a = shared(1);
      disk.failDelete.add(pdf(a)); disk.failCreate.add(recordFolder);
      expect(files.removeAllBillPdfs(now)).toBe(false);
      expect(records()).toEqual([]);
      const b = `${bills}/${now + 60_000}-7`;
      disk.folders.add(b); disk.files.set(pdf(b), now + 60_000);
      disk.failDelete.clear();
      // Without a time, the clear can't tell A's PDFs from B's, so all go.
      expect(files.retryBillPdfClear()).toBe(true);
      expect(pdfFiles()).toEqual([]);
    });

    it("treats a record it can't read as a time as unknown, and deletes every PDF", () => {
      for (const name of ["unknown", "0", "garbage", "1e15", "0x10"]) {
        shared(1);
        disk.folders.add(recordFolder); disk.files.set(`${recordFolder}/${name}`, now);
        expect(files.retryBillPdfClear()).toBe(true);
        expect(pdfFiles()).toEqual([]);
        expect(records()).toEqual([]);
      }
    });

    it("keeps the records and deletes nothing when they can't be listed", () => {
      shared(1);
      disk.folders.add(recordFolder); disk.files.set(`${recordFolder}/${now}`, now);
      disk.failList = true;
      expect(files.retryBillPdfClear()).toBe(false);
      disk.failList = false;
      expect(pdfFiles()).toEqual([pdf(`${bills}/${now - 1}-1`)]);
      expect(records()).toEqual([String(now)]);
    });

    it("keeps the record when the cache can't be reached at the retry", async () => {
      disk.folders.add(recordFolder); disk.files.set(`${recordFolder}/${now}`, now);
      vi.resetModules();
      vi.doMock("expo-file-system", async () => ({ ...await import("./fake-file-system"), Paths: { document: { uri: "file:///documents" }, get cache(): never { throw new Error("no cache"); } } }));
      const broken = await import("../src/lib/bill-pdf-files");
      expect(broken.retryBillPdfClear()).toBe(false);
      expect(records()).toEqual([String(now)]);
      vi.doMock("expo-file-system", () => import("./fake-file-system"));
    });
  });
});
