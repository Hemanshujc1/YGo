import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  createProductImageStorage,
  PRODUCT_IMAGE_CACHE_CONTROL,
  type ProductImagePutClient,
} from "../src/adapters/product-images";

const productId = "123e4567-e89b-12d3-a456-426614174000";

function storage() {
  const calls: Parameters<ProductImagePutClient["putObject"]>[0][] = [];
  const client: ProductImagePutClient = {
    async deleteObject() {},
    async putObject(input) { calls.push(input); },
  };
  return {
    calls,
    images: createProductImageStorage({ client, bucket: "ygo-product-images", imageBaseUrl: "https://images.ygo.example" }),
  };
}

function animatedPng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const typeBytes = Buffer.from(type);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crcInput = Buffer.concat([typeBytes, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcInput));
    return Buffer.concat([length, crcInput, crc]);
  };
  const frameControl = (sequence: number) => {
    const data = Buffer.alloc(26);
    data.writeUInt32BE(sequence, 0);
    data.writeUInt32BE(1, 4);
    data.writeUInt32BE(1, 8);
    data.writeUInt16BE(1, 20);
    data.writeUInt16BE(10, 22);
    return data;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const animationControl = Buffer.alloc(8);
  animationControl.writeUInt32BE(2, 0);
  const secondFrame = Buffer.concat([Buffer.from([2, 0, 0, 0]), deflateSync(Buffer.from([0, 0, 255, 0, 255]))]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("acTL", animationControl),
    chunk("fcTL", frameControl(0)),
    chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    chunk("fcTL", frameControl(1)),
    chunk("fdAT", secondFrame),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function animatedWebp(): Promise<Buffer> {
  const frames = await Promise.all(["red", "blue"].map((background) =>
    sharp({ create: { width: 2, height: 2, channels: 3, background } }).png().toBuffer(),
  ));
  return sharp(frames, { join: { animated: true } }).webp().toBuffer();
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

describe("product image storage", () => {
  it.each([
    ["unsupported", Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"/>")],
    ["oversized", Buffer.alloc(10 * 1024 * 1024 + 1)],
  ])("rejects %s input without S3 writes", async (_label, source) => {
    const { images, calls } = storage();
    await expect(images.store(productId, source as Buffer)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("rejects oversized dimensions without S3 writes", async () => {
    const { images, calls } = storage();
    const source = await sharp({ create: { width: 8001, height: 1, channels: 3, background: "black" } }).png().toBuffer();
    await expect(images.store(productId, source)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("rejects a truncated JPEG without S3 writes", async () => {
    const { images, calls } = storage();
    const jpeg = await sharp({ create: { width: 100, height: 80, channels: 3, background: "red" } }).jpeg().toBuffer();
    await expect(images.store(productId, jpeg.subarray(0, Math.floor(jpeg.length / 2)))).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("rejects animated PNG input without S3 writes", async () => {
    const { images, calls } = storage();
    const source = animatedPng();
    expect(source.includes(Buffer.from("acTL"))).toBe(true);
    await expect(images.store(productId, source)).rejects.toThrow("Animated product images are not supported");
    expect(calls).toEqual([]);
  });

  it("rejects animated WebP input without S3 writes", async () => {
    const { images, calls } = storage();
    const source = await animatedWebp();
    await expect(sharp(source, { animated: true }).metadata()).resolves.toMatchObject({ format: "webp", pages: 2 });
    await expect(images.store(productId, source)).rejects.toThrow("Animated product images are not supported");
    expect(calls).toEqual([]);
  });

  it("rejects sources above 24 megapixels without S3 writes", async () => {
    const { images, calls } = storage();
    const source = await sharp({ create: { width: 6001, height: 4000, channels: 3, background: "black" } }).png().toBuffer();
    await expect(images.store(productId, source)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("stores all WebP variants with immutable keys and only the allowed S3 write fields", async () => {
    const { images, calls } = storage();
    const source = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "red" } }).jpeg().toBuffer();
    const result = await images.store(productId, source);
    const version = `v1-${createHash("sha256").update(source).digest("hex")}`;

    expect(result.keys).toEqual({
      256: `products/${productId}/${version}/256.webp`,
      512: `products/${productId}/${version}/512.webp`,
      1024: `products/${productId}/${version}/1024.webp`,
    });
    expect(result.urls[512]).toBe(`https://images.ygo.example/${result.keys[512]}`);
    expect(calls).toHaveLength(3);
    expect(calls.map(({ key }) => key).sort()).toEqual(Object.values(result.keys).sort());
    expect(calls.every(({ bucket, contentType, cacheControl }) =>
      bucket === "ygo-product-images" && contentType === "image/webp" && cacheControl === PRODUCT_IMAGE_CACHE_CONTROL,
    )).toBe(true);
    expect(calls.every((call) => Object.keys(call).sort().join(",") === "body,bucket,cacheControl,contentType,key")).toBe(true);
  });

  it("waits for late successful uploads before cleanup after a partial failure", async () => {
    const events: string[] = [];
    let release!: () => void;
    let late!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { late = resolve; });
    const images = createProductImageStorage({
      client: {
        async putObject({ key }) {
          if (key.endsWith("/256.webp")) throw new Error("failed put");
          late(); await waiting; events.push("put");
        },
        async deleteObject() { events.push("delete"); },
      }, bucket: "test", imageBaseUrl: "https://images.ygo.example",
    });
    const prepared = await images.prepare(await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer());
    const storing = images.storePrepared(productId, prepared).catch(async () => { await images.remove(images.keys(productId, prepared)); });
    await started;
    expect(events).toEqual([]);
    release(); await storing;
    expect(events).toEqual(["put", "put", "delete", "delete", "delete"]);
  });

  it("builds local image URLs from a base that includes the bucket path", async () => {
    const calls: Parameters<ProductImagePutClient["putObject"]>[0][] = [];
    const images = createProductImageStorage({
      client: { async deleteObject() {}, async putObject(input) { calls.push(input); } },
      bucket: "ygo-product-images",
      imageBaseUrl: "http://127.0.0.1:8333/ygo-product-images/",
    });
    const source = await sharp({ create: { width: 12, height: 8, channels: 3, background: "red" } }).png().toBuffer();
    const result = await images.store(productId, source);

    expect(result.urls[256]).toBe(`http://127.0.0.1:8333/ygo-product-images/${result.keys[256]}`);
    expect(result.urls[512]).toBe(`http://127.0.0.1:8333/ygo-product-images/${result.keys[512]}`);
    expect(result.urls[1024]).toBe(`http://127.0.0.1:8333/ygo-product-images/${result.keys[1024]}`);
    expect(calls).toHaveLength(3);
  });

  it("does not upscale a source smaller than 256 pixels", async () => {
    const { images, calls } = storage();
    const source = await sharp({ create: { width: 100, height: 80, channels: 3, background: "blue" } }).png().toBuffer();
    await images.store(productId, source);
    const image = calls.find(({ key }) => key.endsWith("/256.webp"));
    expect(image).toBeDefined();
    if (!image) throw new Error("Missing 256 pixel variant");
    await expect(sharp(image.body).metadata()).resolves.toMatchObject({ width: 100, height: 80, format: "webp" });
  });

  it("keeps the aspect ratio of non-square sources", async () => {
    const { images, calls } = storage();
    const source = await sharp({ create: { width: 1200, height: 600, channels: 3, background: "green" } }).png().toBuffer();
    await images.store(productId, source);
    const image = calls.find(({ key }) => key.endsWith("/512.webp"));
    expect(image).toBeDefined();
    if (!image) throw new Error("Missing 512 pixel variant");
    await expect(sharp(image.body).metadata()).resolves.toMatchObject({ width: 512, height: 256, format: "webp" });
  });
});
