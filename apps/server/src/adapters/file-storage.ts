import path from "node:path";
import { createReadStream } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { pathToFileURL } from "node:url";

/**
 * Photos: the phone PUTs a file straight to storage and clients GET it back,
 * both through presigned URLs (ADR-0004, ADR-0005). The real implementation
 * speaks the S3 API to a configured endpoint (ADR-0008).
 */
export interface FileStorage {
  uploadUrl(key: string, contentType: string, options?: { byteLength?: number; expiresIn?: number }): Promise<string>;
  downloadUrl(key: string, options?: { expiresIn?: number; cacheControl?: string }): Promise<string>;
  /** The signal stops the transfer: the request is aborted and the stream destroyed. */
  read(key: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer>;
  write(key: string, source: Buffer, contentType: string, signal?: AbortSignal): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Files under a local directory, addressed by plain `file:` URLs with no
 * signature. The content type is ignored: nothing here enforces it.
 */
export function createLocalFileStorage(root: string): FileStorage {
  const base = path.resolve(root);
  const resolve = (key: string) => {
    const file = path.resolve(base, key);
    if (!file.startsWith(base + path.sep)) throw new Error(`key escapes the storage root: ${key}`);
    return file;
  };
  const url = async (key: string) => pathToFileURL(resolve(key)).href;
  return {
    uploadUrl: url, downloadUrl: url,
    read: (key, maxBytes, signal) => readBounded(createReadStream(resolve(key), { signal }), maxBytes, signal),
    async delete(key) {
      try { await unlink(resolve(key)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    },
    async write(key, source, _contentType, signal) {
      const file = resolve(key);
      signal?.throwIfAborted();
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, source, { signal });
    },
  };
}


export class FileTooLargeError extends Error {
  constructor() {
    super("Stored file exceeds the allowed size");
    this.name = "FileTooLargeError";
  }
}

/** Uses the same S3 protocol for AWS and authenticated local development. */
export function createS3FileStorage(options: { bucket: string; region: string; endpoint?: string }): FileStorage {
  const client = new S3Client({
    region: options.region, endpoint: options.endpoint,
    forcePathStyle: Boolean(options.endpoint),
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
  return {
    uploadUrl(key, contentType, signing = {}) {
      return getSignedUrl(client, new PutObjectCommand({
        Bucket: options.bucket, Key: key, ContentType: contentType, ContentLength: signing.byteLength,
      }), { expiresIn: signing.expiresIn ?? 900, signableHeaders: new Set(["content-type", "content-length"]) });
    },
    downloadUrl(key, signing = {}) {
      return getSignedUrl(client, new GetObjectCommand({
        Bucket: options.bucket, Key: key, ResponseCacheControl: signing.cacheControl,
      }), { expiresIn: signing.expiresIn ?? 300 });
    },
    async read(key, maxBytes, signal) {
      const object = await client.send(new GetObjectCommand({ Bucket: options.bucket, Key: key }), { abortSignal: signal });
      if (!object.Body) throw new Error("Stored file has no body");
      const stream = object.Body as AsyncIterable<Uint8Array> & { destroy(): void };
      if (object.ContentLength !== undefined && object.ContentLength > maxBytes) {
        stream.destroy();
        throw new FileTooLargeError();
      }
      return readBounded(stream, maxBytes, signal);
    },
    async write(key, source, contentType, signal) {
      await client.send(new PutObjectCommand({
        Bucket: options.bucket, Key: key, Body: source,
        ContentType: contentType, CacheControl: "private, no-store",
      }), { abortSignal: signal });
    },
    async delete(key) { await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key })); },
  };
}

async function readBounded(stream: AsyncIterable<Uint8Array> & { destroy(): void }, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  const stop = () => stream.destroy();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    signal?.throwIfAborted();
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      length += chunk.byteLength;
      if (length > maxBytes) throw new FileTooLargeError();
      chunks.push(Buffer.from(chunk));
    }
    signal?.throwIfAborted();
    return Buffer.concat(chunks);
  } finally {
    signal?.removeEventListener("abort", stop);
    stream.destroy();
  }
}
