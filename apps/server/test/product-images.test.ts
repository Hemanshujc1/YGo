import { createHash } from "node:crypto";
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
    async putObject(input) { calls.push(input); },
  };
  return {
    calls,
    images: createProductImageStorage({ client, bucket: "ygo-product-images", cloudFrontDomain: "images.ygo.example" }),
  };
}

describe("product image storage", () => {
  it.each([
    ["unsupported", Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"/>")],
    ["corrupt", Buffer.from("not an image")],
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
