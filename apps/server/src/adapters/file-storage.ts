import path from "node:path";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
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
  read(key: string, maxBytes: number): Promise<Buffer>;
  write(key: string, source: Buffer, contentType: string): Promise<void>;
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
    read: (key, maxBytes) => readBounded(createReadStream(resolve(key)), maxBytes),
    async write(key, source) {
      const file = resolve(key);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, source);
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
    async read(key, maxBytes) {
      const object = await client.send(new GetObjectCommand({ Bucket: options.bucket, Key: key }));
      if (!object.Body) throw new Error("Stored file has no body");
      const stream = object.Body as AsyncIterable<Uint8Array> & { destroy(): void };
      if (object.ContentLength !== undefined && object.ContentLength > maxBytes) {
        stream.destroy();
        throw new FileTooLargeError();
      }
      return readBounded(stream, maxBytes);
    },
    async write(key, source, contentType) {
      await client.send(new PutObjectCommand({
        Bucket: options.bucket, Key: key, Body: source,
        ContentType: contentType, CacheControl: "private, no-store",
      }));
    },
  };
}

async function readBounded(stream: AsyncIterable<Uint8Array> & { destroy(): void }, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of stream) {
      length += chunk.byteLength;
      if (length > maxBytes) throw new FileTooLargeError();
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } finally {
    stream.destroy();
  }
}
