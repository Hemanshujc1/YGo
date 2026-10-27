import { createHash, randomUUID } from "node:crypto";
import { CreateVisitPhotoUploadBody, VISIT_PHOTO_MAX_BYTES } from "@ygo/contracts";
import ExifReader, { type ExpandedTags } from "exifreader";
import sharp from "sharp";
import { FileTooLargeError, type FileStorage } from "./file-storage";

export class InvalidVisitPhotoError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidVisitPhotoError";
  }
}

export class VisitPhotoLocationMissingError extends InvalidVisitPhotoError {
  constructor() {
    super("Visit photo must contain valid EXIF GPS coordinates");
    this.name = "VisitPhotoLocationMissingError";
  }
}

/** Private bucket only. Callers authorize the Admin and resolve IDs/keys from
 * persisted records before calling validate or downloadUrl (#322).
 * Pass the byte length recorded at upload creation, never a new client value.
 * Never pass a client-supplied URL or storage key to this adapter.
 */
export function createVisitPhotoStorage(files: FileStorage) {
  const uploadKey = (id: string) => `visit-uploads/${encodeURIComponent(id)}.jpg`;
  return {
    async createUpload(input: CreateVisitPhotoUploadBody) {
      const body = CreateVisitPhotoUploadBody.parse(input);
      const id = randomUUID();
      const uploadUrl = await files.uploadUrl(uploadKey(id), body.contentType, {
        byteLength: body.byteLength, expiresIn: 15 * 60,
      });
      return { id, uploadUrl: presignedHttpUrl(uploadUrl) };
    },
    async validate(uploadId: string, declaredByteLength: number) {
      let source: Buffer;
      try {
        source = await files.read(uploadKey(uploadId), VISIT_PHOTO_MAX_BYTES);
      } catch (error) {
        if (error instanceof FileTooLargeError) throw new InvalidVisitPhotoError("Visit photo exceeds 10 MB", { cause: error });
        throw error;
      }
      if (source.length !== declaredByteLength) throw new InvalidVisitPhotoError("Visit photo does not match its declared size");
      const metadata = await inspect(source);
      // Freeze exactly the bytes inspected, not a copy of a mutable upload key.
      const hash = createHash("sha256").update(source).digest("hex");
      const key = `visit-photos/${encodeURIComponent(uploadId)}/${hash}.jpg`;
      await files.write(key, source, "image/jpeg");
      return { key, ...metadata };
    },
    async downloadUrl(key: string) {
      return presignedHttpUrl(await files.downloadUrl(key, { expiresIn: 5 * 60, cacheControl: "private, no-store" }));
    },
  };
}

export type VisitPhotoStorage = ReturnType<typeof createVisitPhotoStorage>;

async function inspect(source: Buffer) {
  let tags: ExpandedTags["exif"];
  try {
    const image = sharp(source, { failOn: "warning" });
    const metadata = await image.metadata();
    if (metadata.format !== "jpeg") throw new Error("Not JPEG");
    // metadata() alone accepts truncated images. Decode the pixels too.
    await image.stats();
    tags = ExifReader.load(source, { expanded: true }).exif;
  } catch (error) {
    throw new InvalidVisitPhotoError("Visit photo must be a valid JPEG", { cause: error });
  }
  const latitude = coordinate(tags?.GPSLatitude?.value, tags?.GPSLatitudeRef?.value?.[0], "N", "S", 90);
  const longitude = coordinate(tags?.GPSLongitude?.value, tags?.GPSLongitudeRef?.value?.[0], "E", "W", 180);
  if (latitude === null || longitude === null) throw new VisitPhotoLocationMissingError();
  // Preserve the original camera value; it may have no timezone.
  return { latitude, longitude, capturedAt: tags?.DateTimeOriginal?.value[0] ?? null };
}

function coordinate(value: unknown, ref: unknown, positive: string, negative: string, max: number) {
  if (!Array.isArray(value) || value.length !== 3 || (ref !== positive && ref !== negative)) return null;
  const parts: number[] = [];
  for (const rational of value) {
    if (!Array.isArray(rational) || rational.length !== 2) return null;
    const [numerator, denominator] = rational;
    if (typeof numerator !== "number" || !Number.isFinite(numerator) || numerator < 0
      || typeof denominator !== "number" || !Number.isFinite(denominator) || denominator <= 0) return null;
    parts.push(numerator / denominator);
  }
  const [degrees = NaN, minutes = NaN, seconds = NaN] = parts;
  if (minutes >= 60 || seconds >= 60) return null;
  const coordinate = degrees + minutes / 60 + seconds / 3600;
  return coordinate <= max ? coordinate * (ref === negative ? -1 : 1) : null;
}

function presignedHttpUrl(value: string) {
  const url = new URL(value);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.searchParams.has("X-Amz-Signature")) {
    throw new Error("Visit photos require presigned HTTP URLs; use authenticated S3 storage");
  }
  return value;
}
