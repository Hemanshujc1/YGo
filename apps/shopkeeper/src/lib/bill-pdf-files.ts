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

// Outside the cache, so it survives the cache being cleared: one empty file per full clear that left files behind,
// named by its time, or "unknown" when its time couldn't be recorded. Files are only ever created, never rewritten,
// so a failed record can't leave an older time standing in for a newer clear.
const records = () => new Directory(Paths.document, "bill-pdf-clears");
const UNKNOWN = "unknown";
// Set when no record at all could be made: this session's retries then delete everything and keep every record.
let unrecorded = false;

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

function record(name: string): boolean {
  try {
    const folder = records();
    folder.create({ intermediates: true, idempotent: true });
    const file = new File(folder, name);
    if (!file.exists) file.create();
    return true;
  } catch { return false; }
}
// Turns an existing record into "unknown". A rename needs no new space, so it can work on a full disk.
function widen(): boolean {
  try {
    const folder = records();
    if (folder.exists && new File(folder, UNKNOWN).exists) return true;
    const first = folder.exists ? folder.list().find((entry): entry is File => entry instanceof File) : undefined;
    if (!first) return false;
    first.rename(UNKNOWN);
    return true;
  } catch { return false; }
}
function remember(at: number) {
  if (!record(String(at)) && !record(UNKNOWN) && !widen()) unrecorded = true;
}

// The records on disk and the time the retry must cover: the latest, or null for "delete everything".
// Null overall when the records can't be read, so nothing is assumed finished.
function readRecords(): { files: File[]; at: number | null } | null {
  try {
    const folder = records();
    if (!folder.exists) return { files: [], at: null };
    const files = folder.list().filter((entry): entry is File => entry instanceof File);
    let at = 0;
    for (const file of files) {
      // Only a plain positive number is a time; "unknown" or anything else means delete everything.
      if (!/^\d+$/.test(file.name) || Number(file.name) === 0) return { files, at: null };
      at = Math.max(at, Number(file.name));
    }
    return { files, at };
  } catch { return null; }
}
function forget(files: File[]) {
  for (const file of files) {
    try { file.delete(); } catch { /* the next retry finds nothing left and tries again */ }
  }
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
  if (!gone) { remember(now); return false; }
  // Every PDF is gone, so every earlier record is done too.
  const read = readRecords();
  if (read) forget(read.files);
  unrecorded = false;
  return true;
}

/**
 * At launch and before each share: finishes full clears that left files behind, deleting everything made up to the
 * latest of them (and anything of unknown age). PDFs shared since, by whoever signed in next, stay.
 * Returns whether nothing from them is left; the records go only then.
 */
export function retryBillPdfClear(): boolean {
  const read = readRecords();
  if (!read) return false;
  if (read.files.length === 0 && !unrecorded) return true;
  const at = unrecorded ? null : read.at;
  const list = folders();
  // Nothing could be checked, so the records stay.
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
  if (!gone) return false;
  forget(read.files);
  unrecorded = false;
  return true;
}
