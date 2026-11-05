import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createDeliveryPhotoStorage } from "../src/adapters/delivery-photos";
import type { FileStorage } from "../src/adapters/file-storage";

const jpeg = () => sharp({ create: { width: 40, height: 40, channels: 3, background: "#888" } }).jpeg().toBuffer();
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A storage that records what it was asked to do and how it ended. */
function recordingStorage(overrides: Partial<FileStorage>) {
  const writes: string[] = [];
  const files = {
    uploadUrl: async () => "", downloadUrl: async () => "", delete: async () => undefined,
    read: async () => Buffer.alloc(0),
    write: async (key: string) => { writes.push(key); },
    ...overrides,
  } as FileStorage;
  return { files, writes };
}

describe("delivery photo save cancellation (#524)", () => {
  it("stops a slow read when the signal fires and writes nothing", async () => {
    let readEnded = false;
    const { files, writes } = recordingStorage({
      read: (_key, _max, signal) => new Promise((_, reject) => signal?.addEventListener("abort", () => { readEnded = true; reject(signal.reason); })),
    });
    const stop = new AbortController();
    const saving = createDeliveryPhotoStorage(files).save("o", "a", "u", 1, stop.signal);
    setTimeout(() => stop.abort(), 20);
    await expect(saving).rejects.toThrow();
    expect(readEnded).toBe(true);
    await pause(100);
    expect(writes).toEqual([]);
  });

  it("writes nothing when the signal fires while the read is finishing", async () => {
    const source = await jpeg();
    const stop = new AbortController();
    // A read that ignores the signal and returns after it fired.
    const { files, writes } = recordingStorage({ read: async () => { stop.abort(); return source; } });
    await expect(createDeliveryPhotoStorage(files).save("o", "a", "u", source.length, stop.signal)).rejects.toThrow();
    await pause(100);
    expect(writes).toEqual([]);
  });

  it("passes the signal to the write and ends with it", async () => {
    const source = await jpeg();
    const stop = new AbortController();
    let writeEnded = false;
    const { files } = recordingStorage({
      read: async () => source,
      write: (_key, _body, _type, signal) => new Promise((_, reject) => { setTimeout(() => stop.abort(), 10); signal?.addEventListener("abort", () => { writeEnded = true; reject(signal.reason); }); }),
    });
    await expect(createDeliveryPhotoStorage(files).save("o", "a", "u", source.length, stop.signal)).rejects.toThrow();
    expect(writeEnded).toBe(true);
  });

  it("still saves when the signal never fires", async () => {
    const source = await jpeg();
    const { files, writes } = recordingStorage({ read: async () => source });
    expect(await createDeliveryPhotoStorage(files).save("o", "a", "u", source.length, new AbortController().signal)).toBe("delivery-proofs/o/u.jpg");
    expect(writes).toEqual(["delivery-proofs/o/u.jpg"]);
  });
});
