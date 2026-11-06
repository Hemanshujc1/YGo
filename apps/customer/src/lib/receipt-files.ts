import { Directory, Paths } from "expo-file-system";

/**
 * Where shared receipt PDFs live (#61): a folder of this feature only, in the cache. Each share gets its own
 * subfolder, named by when it was made, so the file inside keeps the name the Customer sees. Cleanup deletes only
 * entries in this folder whose name says they are over an hour old, and never touches anything else.
 */
export const RECEIPT_MAX_AGE_MS = 60 * 60 * 1000;
const receipts = () => new Directory(Paths.cache, "receipts");

let made = 0;
/** A new, empty folder for one share. */
export function receiptFolder(now = Date.now()): Directory {
  let folder: Directory;
  do folder = new Directory(receipts(), `${now}-${++made}`); while (folder.exists);
  folder.create({ intermediates: true });
  return folder;
}

/** Before each share: deletes receipt folders over an hour old. A receiving app may read a younger file after the sheet closes. A failure never stops a share. */
export function removeOldReceipts(now = Date.now()): void {
  try {
    const root = receipts();
    if (!root.exists) return;
    for (const entry of root.list()) {
      try {
        const stamp = /^(\d+)-\d+$/.exec(entry.name)?.[1];
        if (entry instanceof Directory && stamp && now - Number(stamp) > RECEIPT_MAX_AGE_MS) entry.delete();
      } catch { /* try the next one */ }
    }
  } catch { /* sharing goes on */ }
}
