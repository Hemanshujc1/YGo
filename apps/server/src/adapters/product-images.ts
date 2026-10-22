import { createHash } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import sharp from "sharp";

export const PRODUCT_IMAGE_SIZES = [256, 512, 1024] as const;
export const PRODUCT_IMAGE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 24_000_000;
const MAX_SIDE = 8_000;
const FORMATS = new Set(["jpeg", "png", "webp"]);

export interface ProductImagePutClient {
  putObject(input: {
    bucket: string;
    key: string;
    body: Buffer;
    contentType: "image/webp";
    cacheControl: typeof PRODUCT_IMAGE_CACHE_CONTROL;
  }): Promise<void>;
}

export interface ProductImageVariants {
  256: string;
  512: string;
  1024: string;
}

type ProductImageBuffers = Record<keyof ProductImageVariants, Buffer>;

export function createS3ProductImageClient(client: S3Client): ProductImagePutClient {
  return {
    async putObject(input) {
      await client.send(new PutObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        CacheControl: input.cacheControl,
      }));
    },
  };
}

export function createProductImageStorage(options: {
  client: ProductImagePutClient;
  bucket: string;
  cloudFrontDomain: string;
}) {
  const domain = options.cloudFrontDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");

  return {
    async store(productId: string, source: Buffer): Promise<{ keys: ProductImageVariants; urls: ProductImageVariants }> {
      const variants = await createVariants(source);
      const version = `v1-${createHash("sha256").update(source).digest("hex")}`;
      const safeProductId = encodeURIComponent(productId);
      const keys: ProductImageVariants = {
        256: `products/${safeProductId}/${version}/256.webp`,
        512: `products/${safeProductId}/${version}/512.webp`,
        1024: `products/${safeProductId}/${version}/1024.webp`,
      };

      await Promise.all(PRODUCT_IMAGE_SIZES.map((size) => options.client.putObject({
        bucket: options.bucket,
        key: keys[size],
        body: variants[size],
        contentType: "image/webp",
        cacheControl: PRODUCT_IMAGE_CACHE_CONTROL,
      })));

      const urls: ProductImageVariants = {
        256: `https://${domain}/${keys[256]}`,
        512: `https://${domain}/${keys[512]}`,
        1024: `https://${domain}/${keys[1024]}`,
      };
      return { keys, urls };
    },
  };
}

async function createVariants(source: Buffer): Promise<ProductImageBuffers> {
  if (source.byteLength > MAX_FILE_BYTES) throw new Error("Product image exceeds 10 MiB");

  const metadata = await sharp(source, { failOn: "error", limitInputPixels: MAX_PIXELS }).metadata();
  if (!metadata.format || !FORMATS.has(metadata.format) || !metadata.width || !metadata.height) {
    throw new Error("Product image must be a valid JPEG, PNG, or WebP image");
  }
  if (metadata.width > MAX_SIDE || metadata.height > MAX_SIDE || metadata.width * metadata.height > MAX_PIXELS) {
    throw new Error("Product image dimensions exceed the allowed limits");
  }

  const render = (size: number) => sharp(source, { failOn: "error", limitInputPixels: MAX_PIXELS }).rotate().resize({
      width: size,
      height: size,
      fit: "inside",
      withoutEnlargement: true,
    }).webp().toBuffer();
  const [small, medium, large] = await Promise.all([render(256), render(512), render(1024)]);
  return { 256: small, 512: medium, 1024: large };
}
