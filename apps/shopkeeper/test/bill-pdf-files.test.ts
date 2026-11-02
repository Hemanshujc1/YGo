import { beforeEach, describe, expect, it, vi } from "vitest";
import { bills, disk } from "./fake-file-system";

vi.mock("expo-file-system", () => import("./fake-file-system"));
import { BILL_PDF_MAX_AGE_MS, removeAllBillPdfs, removeOldBillPdfs, shareFolder } from "../src/lib/bill-pdf-files";

const hour = BILL_PDF_MAX_AGE_MS, now = 1_800_000_000_000;
// One shared PDF in its own folder, made `ago` ms before now.
function shared(ago: number, n = 1) {
  const folder = `${bills}/${now - ago}-${n}`;
  disk.folders.add(bills); disk.folders.add(folder);
  disk.files.set(`${folder}/YGo bill A1B2-C3D4.pdf`, now - ago);
  return folder;
}
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

  it("removes every PDF, young ones too, on sign-out or erase, and never throws", () => {
    shared(1); shared(hour * 2, 2);
    removeAllBillPdfs();
    expect(disk.folders.has(bills)).toBe(false);
    expect(disk.files.size).toBe(0);
    shared(1); disk.failDelete.add(bills);
    expect(() => removeAllBillPdfs()).not.toThrow();
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
