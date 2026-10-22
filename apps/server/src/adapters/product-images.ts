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

export class InvalidProductImageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidProductImageError";
  }
}

export interface PreparedProductImage {
  sourceHash: string;
  variants: ProductImageBuffers;
}

export function createS3ProductImageClient(options: { region: string; endpoint?: string }): ProductImagePutClient {
  const client = new S3Client(options);
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
  return {
    prepare(source: Buffer): Promise<PreparedProductImage> {
      return createVariants(source);
    },
    async store(productId: string, source: Buffer): Promise<{ keys: ProductImageVariants; urls: ProductImageVariants }> {
      return this.storePrepared(productId, await this.prepare(source));
    },
    async storePrepared(productId: string, prepared: PreparedProductImage): Promise<{ keys: ProductImageVariants; urls: ProductImageVariants }> {
      const version = `v1-${prepared.sourceHash}`;
      const safeProductId = encodeURIComponent(productId);
      const keys: ProductImageVariants = {
        256: `products/${safeProductId}/${version}/256.webp`,
        512: `products/${safeProductId}/${version}/512.webp`,
        1024: `products/${safeProductId}/${version}/1024.webp`,
      };

      await Promise.all(PRODUCT_IMAGE_SIZES.map((size) => options.client.putObject({
        bucket: options.bucket,
        key: keys[size],
        body: prepared.variants[size],
        contentType: "image/webp",
        cacheControl: PRODUCT_IMAGE_CACHE_CONTROL,
      })));

      const urls: ProductImageVariants = {
        256: `https://${options.cloudFrontDomain}/${keys[256]}`,
        512: `https://${options.cloudFrontDomain}/${keys[512]}`,
        1024: `https://${options.cloudFrontDomain}/${keys[1024]}`,
      };
      return { keys, urls };
    },
    urls(keys: ProductImageVariants): ProductImageVariants {
      return {
        256: `https://${options.cloudFrontDomain}/${keys[256]}`,
        512: `https://${options.cloudFrontDomain}/${keys[512]}`,
        1024: `https://${options.cloudFrontDomain}/${keys[1024]}`,
      };
    },
  };
}

export type ProductImageStorage = ReturnType<typeof createProductImageStorage>;

async function createVariants(source: Buffer): Promise<PreparedProductImage> {
  try {
    if (source.byteLength > MAX_FILE_BYTES) throw new InvalidProductImageError("Product image exceeds 10 MiB");

    const image = sharp(source, { animated: true, failOn: "error", limitInputPixels: MAX_PIXELS }).rotate();
    const metadata = await image.metadata();
    if (!metadata.format || !FORMATS.has(metadata.format) || !metadata.width || !metadata.height) {
      throw new InvalidProductImageError("Product image must be a valid JPEG, PNG, or WebP image");
    }
    if ((metadata.pages && metadata.pages > 1) || (metadata.format === "png" && isAnimatedPng(source))) {
      throw new InvalidProductImageError("Animated product images are not supported");
    }
    if (metadata.width > MAX_SIDE || metadata.height > MAX_SIDE || metadata.width * metadata.height > MAX_PIXELS) {
      throw new InvalidProductImageError("Product image dimensions exceed the allowed limits");
    }

    const variants = {} as ProductImageBuffers;
    for (const size of PRODUCT_IMAGE_SIZES) {
      variants[size] = await image.clone().resize({
        width: size,
        height: size,
        fit: "inside",
        withoutEnlargement: true,
      }).webp().toBuffer();
    }
    return { sourceHash: createHash("sha256").update(source).digest("hex"), variants };
  } catch (error) {
    if (error instanceof InvalidProductImageError) throw error;
    throw new InvalidProductImageError("Product image is not a valid supported image", { cause: error });
  }
}

function isAnimatedPng(source: Buffer): boolean {
  let offset = 8;
  while (offset + 12 <= source.length) {
    const length = source.readUInt32BE(offset);
    const type = source.toString("ascii", offset + 4, offset + 8);
    if (offset + 12 + length > source.length) return false;
    if (type === "acTL") return true;
    if (type === "IEND") return false;
    offset += 12 + length;
  }
  return false;
}
