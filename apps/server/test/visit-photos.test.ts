import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalFileStorage, createS3FileStorage, FileTooLargeError } from "../src/adapters/file-storage";
import { VISIT_PHOTO_MAX_BYTES } from "@ygo/contracts";
import { createVisitPhotoStorage, InvalidVisitPhotoError, VisitPhotoLocationMissingError } from "../src/adapters/visit-photos";

// A private S3 protocol test server: verify SigV4 independently of the SDK,
// including the method, path, query and signed headers. No anonymous access.
const secret = "test-secret";
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
function authorized(request: IncomingMessage, url: URL) {
  // SDK server-side requests use header signing; this fixture only verifies
  // the browser's presigned URLs. Server calls stay inside the test process.
  if (request.headers.authorization) return true;
  const signature = url.searchParams.get("X-Amz-Signature");
  const date = url.searchParams.get("X-Amz-Date");
  const credential = url.searchParams.get("X-Amz-Credential");
  const signedHeaders = url.searchParams.get("X-Amz-SignedHeaders");
  if (!signature || !date || !credential || !signedHeaders) return false;
  const expires = Number(url.searchParams.get("X-Amz-Expires"));
  const timestamp = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`);
  if (!expires || Date.now() > timestamp + expires * 1000) return false;
  const query = [...url.searchParams].filter(([key]) => key !== "X-Amz-Signature")
    .map(([key, value]) => [encode(key), encode(value)] as const)
    .sort(([a, av], [b, bv]) => a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join("&");
  const headers = signedHeaders.split(";").map((name) => `${name}:${request.headers[name] ?? ""}\n`).join("");
  const canonical = [request.method, url.pathname, query, headers, signedHeaders, "UNSIGNED-PAYLOAD"].join("\n");
  const [, day = "", region = "", service = ""] = credential.split("/");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const hmac = (key: string | Buffer, value: string) => createHmac("sha256", key).update(value).digest();
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), service), "aws4_request");
  const expected = createHmac("sha256", key).update(`AWS4-HMAC-SHA256\n${date}\n${scope}\n${createHash("sha256").update(canonical).digest("hex")}`).digest("hex");
  return signature === expected;
}

async function jpeg(gps = true, capture = true, latitude = "12/1 30/1 0/1", ref = "S") {
  const image = sharp({ create: { width: 4, height: 4, channels: 3, background: "red" } });
  return image.withExif({
    ...(gps ? { IFD3: { GPSLatitudeRef: ref, GPSLatitude: latitude, GPSLongitudeRef: "W", GPSLongitude: "77/1 15/1 0/1" } } : {}),
    ...(capture ? { IFD2: { DateTimeOriginal: "2020:01:02 03:04:05" } } : {}),
  }).jpeg().toBuffer();
}

describe("private visit photos", () => {
  const objects = new Map<string, Buffer>();
  let endpoint: string;
  let storage: ReturnType<typeof createVisitPhotoStorage>;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", endpoint);
    if (!authorized(request, url)) { response.writeHead(403).end(); return; }
    if (request.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      objects.set(url.pathname, Buffer.concat(chunks));
      response.writeHead(200).end();
    } else if (request.method === "GET" && objects.has(url.pathname)) {
      const body = objects.get(url.pathname) ?? Buffer.alloc(0);
      response.writeHead(200, { "content-length": body.length, "content-type": "image/jpeg" }).end(body);
    } else response.writeHead(404).end();
  });
  beforeEach(async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "test-access");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", secret);
    objects.clear();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test port");
    endpoint = `http://127.0.0.1:${address.port}`;
    storage = createVisitPhotoStorage(createS3FileStorage({ bucket: "private-visits", region: "ap-south-1", endpoint }));
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    vi.unstubAllEnvs();
  });
  async function upload(source: Buffer) {
    const upload = await storage.createUpload({ contentType: "image/jpeg", byteLength: source.length });
    expect((await fetch(upload.uploadUrl, { method: "PUT", body: new Uint8Array(source), headers: { "content-type": "image/jpeg" } })).status).toBe(200);
    return upload;
  }

  it("signs only the configured private destination and intended method/headers", async () => {
    const source = await jpeg();
    const { uploadUrl } = await upload(source);
    const url = new URL(uploadUrl);
    expect(url.origin).toBe(endpoint);
    expect(url.pathname).toMatch(/^\/private-visits\/visit-uploads\/[\w-]+\.jpg$/);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect((await fetch(uploadUrl)).status).toBe(403);
    expect((await fetch(uploadUrl, { method: "PUT", body: new Uint8Array(source), headers: { "content-type": "image/png" } })).status).toBe(403);
    expect((await fetch(uploadUrl, { method: "PUT", body: "short", headers: { "content-type": "image/jpeg" } })).status).toBe(403);
    url.pathname = url.pathname.replace("private-visits", "public-products");
    expect((await fetch(url, { method: "PUT", body: new Uint8Array(source), headers: { "content-type": "image/jpeg" } })).status).toBe(403);
  });

  it("reads GPS and capture time from the original, freezing exact bytes away from the upload", async () => {
    const source = await jpeg();
    const uploaded = await upload(source);
    const photo = await storage.validate(uploaded.id);
    expect(photo).toMatchObject({ latitude: -12.5, longitude: -77.25, capturedAt: "2020:01:02 03:04:05" });
    const downloadUrl = await storage.downloadUrl(photo.key);
    const url = new URL(downloadUrl);
    expect(url.pathname).toContain("/private-visits/visit-photos/");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect((await fetch(`${url.origin}${url.pathname}`)).status).toBe(403);
    expect(Buffer.from(await (await fetch(downloadUrl)).arrayBuffer())).toEqual(source);
    expect((await fetch(downloadUrl, { method: "PUT", body: "replace" })).status).toBe(403);
    const replacement = Buffer.from(source);
    const captureOffset = replacement.indexOf("2020:01:02 03:04:05");
    expect(captureOffset).toBeGreaterThan(0);
    replacement.write("2021", captureOffset);
    expect((await fetch(uploaded.uploadUrl, { method: "PUT", body: new Uint8Array(replacement), headers: { "content-type": "image/jpeg" } })).status).toBe(200);
    expect(objects.get(new URL(uploaded.uploadUrl).pathname)).toEqual(replacement);
    expect(Buffer.from(await (await fetch(downloadUrl)).arrayBuffer())).toEqual(source);
  });

  it("permits missing capture time and zero coordinates", async () => {
    const result = await upload(await jpeg(true, false, "0/1 0/1 0/1", "N"));
    expect(await storage.validate(result.id)).toMatchObject({ latitude: 0, capturedAt: null });
  });

  it.each(["missing", "out-of-range", "bad-ref"])("rejects %s EXIF GPS without saving evidence", async (kind) => {
    const source = await jpeg(kind !== "missing", true, kind === "out-of-range" ? "91/1 0/1 0/1" : undefined, kind === "bad-ref" ? "X" : "N");
    const result = await upload(source);
    await expect(storage.validate(result.id)).rejects.toBeInstanceOf(VisitPhotoLocationMissingError);
    expect([...objects.keys()].some((key) => key.includes("/visit-photos/"))).toBe(false);
  });

  it("rejects non-JPEG, corrupt JPEG and oversized data despite declared content type", async () => {
    const valid = await jpeg();
    for (const source of [Buffer.from("not JPEG"), valid.subarray(0, valid.length - 40), await sharp(valid).png().toBuffer()]) {
      const result = await upload(source);
      await expect(storage.validate(result.id)).rejects.toBeInstanceOf(InvalidVisitPhotoError);
    }
    const result = await upload(valid);
    objects.set(new URL(result.uploadUrl).pathname, Buffer.alloc(VISIT_PHOTO_MAX_BYTES + 1));
    await expect(storage.validate(result.id)).rejects.toThrow("exceeds 10 MB");
    await expect(storage.createUpload({ contentType: "image/jpeg", byteLength: VISIT_PHOTO_MAX_BYTES + 1 })).rejects.toThrow();
  });
});


it("exercises the same visit validation through local FileStorage with bounded reads", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ygo-visit-"));
  try {
    const files = createLocalFileStorage(root);
    const storage = createVisitPhotoStorage(files);
    const source = await jpeg();
    await files.write("visit-uploads/local.jpg", source, "image/jpeg");
    const photo = await storage.validate("local");
    expect(photo).toMatchObject({ latitude: -12.5, longitude: -77.25 });
    expect(await files.read(photo.key, source.length)).toEqual(source);
    await expect(files.read(photo.key, source.length - 1)).rejects.toBeInstanceOf(FileTooLargeError);
    await expect(files.write("../escape.jpg", source, "image/jpeg")).rejects.toThrow("escapes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
