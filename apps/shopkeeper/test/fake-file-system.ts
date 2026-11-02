// A small stand-in for expo-file-system: folders and files by URI, with modification times and failures to inject.
type Disk = {
  folders: Set<string>; files: Map<string, number>; now: number; failList: boolean; failDelete: Set<string>; failMove: boolean; reset(): void;
};
// One disk for every copy of this module, since tests reload the code under test with vi.resetModules().
const shared = globalThis as { fakeDisk?: Disk };
export const disk: Disk = shared.fakeDisk ??= {
  folders: new Set<string>(),
  files: new Map<string, number>(),
  now: 0,
  failList: false,
  failDelete: new Set<string>(),
  failMove: false,
  reset() {
    this.folders.clear(); this.files.clear(); this.now = 0;
    this.failList = false; this.failDelete.clear(); this.failMove = false;
  },
};

type Part = string | { uri: string };
const join = (parts: Part[]) => parts.map((part) => typeof part === "string" ? part : part.uri).join("/");
const under = (uri: string, parent: string) => uri.startsWith(`${parent}/`);

export class File {
  uri: string;
  constructor(...parts: Part[]) { this.uri = join(parts); }
  get name() { return this.uri.slice(this.uri.lastIndexOf("/") + 1); }
  get exists() { return disk.files.has(this.uri); }
  get modificationTime() { return disk.files.get(this.uri) ?? null; }
  async base64() { return "Rk9OVA=="; }
  delete() { if (disk.failDelete.has(this.uri)) throw new Error("busy"); disk.files.delete(this.uri); }
  async move(to: { uri: string }) {
    if (disk.failMove) throw new Error("disk full");
    if (disk.files.has(to.uri)) throw new Error("destination exists");
    // Like a real rename, the file keeps its modification time.
    const time = disk.files.get(this.uri) ?? disk.now;
    disk.files.delete(this.uri); disk.files.set(to.uri, time);
  }
}

export class Directory {
  uri: string;
  constructor(...parts: Part[]) { this.uri = join(parts); }
  get name() { return this.uri.slice(this.uri.lastIndexOf("/") + 1); }
  get exists() { return disk.folders.has(this.uri); }
  create() {
    if (disk.folders.has(this.uri)) throw new Error("folder exists");
    for (let at = this.uri; at.includes("/"); at = at.slice(0, at.lastIndexOf("/"))) disk.folders.add(at);
  }
  list(): Array<File | Directory> {
    if (disk.failList) throw new Error("can't read");
    const child = (uri: string) => under(uri, this.uri) && !uri.slice(this.uri.length + 1).includes("/");
    return [...[...disk.folders].filter(child).map((uri) => new Directory(uri)), ...[...disk.files.keys()].filter(child).map((uri) => new File(uri))];
  }
  delete() {
    if (disk.failDelete.has(this.uri)) throw new Error("busy");
    for (const uri of [...disk.folders]) if (uri === this.uri || under(uri, this.uri)) disk.folders.delete(uri);
    for (const uri of [...disk.files.keys()]) if (under(uri, this.uri)) disk.files.delete(uri);
  }
}

export const Paths = { cache: { uri: "file:///cache" } };
export const bills = "file:///cache/bills";
