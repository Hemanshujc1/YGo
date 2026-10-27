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
      return { id, uploadUrl };
    },
    async validate(uploadId: string) {
      let source: Buffer;
      try {
        source = await files.read(uploadKey(uploadId), VISIT_PHOTO_MAX_BYTES);
      } catch (error) {
        if (error instanceof FileTooLargeError) throw new InvalidVisitPhotoError("Visit photo exceeds 10 MB", { cause: error });
        throw error;
      }
      const metadata = await inspect(source);
      // Freeze exactly the bytes inspected, not a copy of a mutable upload key.
      const hash = createHash("sha256").update(source).digest("hex");
      const key = `visit-photos/${encodeURIComponent(uploadId)}/${hash}.jpg`;
      await files.write(key, source, "image/jpeg");
      return { key, ...metadata };
    },
    async downloadUrl(key: string) {
      return files.downloadUrl(key, { expiresIn: 5 * 60, cacheControl: "private, no-store" });
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
  const latitude = coordinate(tags?.GPSLatitude?.value, tags?.GPSLatitudeRef?.value[0], "N", "S", 90);
  const longitude = coordinate(tags?.GPSLongitude?.value, tags?.GPSLongitudeRef?.value[0], "E", "W", 180);
  if (latitude === null || longitude === null) throw new VisitPhotoLocationMissingError();
  // Preserve the original camera value; it may have no timezone.
  return { latitude, longitude, capturedAt: tags?.DateTimeOriginal?.value[0] ?? null };
}

function coordinate(value: [[number, number], [number, number], [number, number]] | undefined, ref: string | undefined, positive: string, negative: string, max: number) {
  if (!value || value.length !== 3 || (ref !== positive && ref !== negative)) return null;
  const parts = value.map(([numerator, denominator]) => numerator / denominator) as [number, number, number];
  if (parts.some((part) => !Number.isFinite(part) || part < 0) || parts[1] >= 60 || parts[2] >= 60) return null;
  const degrees = parts[0] + parts[1] / 60 + parts[2] / 3600;
  return degrees <= max ? degrees * (ref === negative ? -1 : 1) : null;
}
