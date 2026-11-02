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

// Outside the cache, so it survives the cache being cleared: the time of a full clear that left files behind.
const pending = () => new File(Paths.document, "bill-pdfs-clear-pending");

// Deletes an entry, falling back to its contents one by one when the whole delete fails.
// True when no file is left; an empty folder that won't delete holds no customer data.
function wipe(entry: Directory | File): boolean {
  try { entry.delete(); return true; } catch { /* fall back below */ }
  if (!(entry instanceof Directory)) return false;
  let children: Array<Directory | File>;
  try { children = entry.list(); } catch { return false; }
  let gone = true;
  for (const child of children) gone = wipe(child) && gone;
  try { entry.delete(); } catch { /* empty or not, its files are what matter */ }
  return gone;
}

// The recorded clear time; null when it is missing, blank or unreadable, which means "delete everything".
function recorded(marker: File): number | null {
  const at = Number(marker.textSync());
  return at > 0 && Number.isFinite(at) ? at : null;
}

function remember(at: number) {
  try {
    const marker = pending();
    if (!marker.exists) marker.create();
    // Keep the later time, so a second failed clear can't shrink what the retry covers.
    const before = recorded(marker);
    marker.write(String(before === null ? at : Math.max(before, at)));
  } catch { /* nothing more can be done until the next clear */ }
}
function forget() {
  try { const marker = pending(); if (marker.exists) marker.delete(); } catch { /* the next launch retries harmlessly */ }
}

/**
 * On sign-out, account switch and account erase: every bill PDF goes, since each holds a customer's name.
 * A folder that won't delete is emptied file by file. Anything still left is recorded and retried at the next launch.
 * Returns whether every PDF is gone.
 */
export function removeAllBillPdfs(now = Date.now()): boolean {
  clears++;
  const list = folders();
  let gone = list.length > 0;
  for (const folder of list) {
    try { if (folder.exists && !wipe(folder)) gone = false; } catch { gone = false; }
  }
  if (gone) forget(); else remember(now);
  return gone;
}

/**
 * At launch and before each share: finishes a full clear that left files behind, deleting everything made up to that
 * clear (and anything of unknown age). PDFs shared since, by whoever signed in next, stay.
 * Returns whether nothing from it is left.
 */
export function retryBillPdfClear(): boolean {
  let at: number | null;
  try {
    const marker = pending();
    if (!marker.exists) return true;
    at = recorded(marker);
  } catch { return false; }
  const list = folders();
  // Nothing could be checked, so the record stays.
  if (list.length === 0) return false;
  let gone = true;
  for (const folder of list) {
    try {
      if (!folder.exists) continue;
      for (const entry of folder.list()) {
        const made = madeAt(entry);
        if ((made === null || at === null || made <= at) && !wipe(entry)) gone = false;
      }
    } catch { gone = false; }
  }
  if (gone) forget();
  return gone;
}
