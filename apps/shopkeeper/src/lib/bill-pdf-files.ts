import { Directory, File, Paths } from "expo-file-system";

/**
 * Where shared bill PDFs live (#488). Each share gets its own folder, named by when it was made, so the file inside
 * keeps the name the customer sees and two shares never touch each other's file. expo-print first writes each PDF
 * to the cache's Print folder; YGo prints nothing else, so cleanup covers that folder too.
 */
export const BILL_PDF_MAX_AGE_MS = 60 * 60 * 1000;
const bills = () => new Directory(Paths.cache, "bills");
// Empty when the cache can't be reached, so cleanup never throws.
function folders(): Directory[] {
  try { return [bills(), new Directory(Paths.cache, "Print")]; } catch { return []; }
}

let made = 0;
/** A new, empty folder for one share. A name already taken (the clock went back) is skipped. */
export function shareFolder(now = Date.now()): Directory {
  let folder: Directory;
  do folder = new Directory(bills(), `${now}-${++made}`); while (folder.exists);
  folder.create({ intermediates: true });
  return folder;
}

// When an entry was made: from a share folder's name, or a loose file's modification time. Null when unknown.
function madeAt(entry: Directory | File): number | null {
  const stamp = /^(\d+)-\d+$/.exec(entry.name)?.[1];
  if (stamp) return Number(stamp);
  return entry instanceof File ? entry.modificationTime ?? null : null;
}

/**
 * Routine cleanup, at app start and before each share: deletes only PDFs made over an hour ago. Android may hand a
 * shared file to WhatsApp or Gmail long after the share sheet closes, even after YGo restarts, so younger files,
 * and files of unknown age, stay. A failure never stops a share.
 */
export function removeOldBillPdfs(now = Date.now()): void {
  for (const folder of folders()) {
    try {
      if (!folder.exists) continue;
      for (const entry of folder.list()) {
        try {
          const at = madeAt(entry);
          if (at !== null && now - at > BILL_PDF_MAX_AGE_MS) entry.delete();
        } catch { /* try the next one */ }
      }
    } catch { /* sharing goes on */ }
  }
}

let clears = 0;
/** Counts full clears, so a share running across a sign-out can tell and keep nothing. */
export const billPdfClears = () => clears;

/** On sign-out, account switch and account erase: every bill PDF goes, since each holds a customer's name. */
export function removeAllBillPdfs(): void {
  clears++;
  for (const folder of folders()) {
    try {
      if (folder.exists) folder.delete();
    } catch { /* the next routine cleanup tries again */ }
  }
}
