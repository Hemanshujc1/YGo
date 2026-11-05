import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { DELIVERY_PHOTO_MAX_BYTES, DeliveryPhotoUploadBody } from "@ygo/contracts";
import { FileTooLargeError, type FileStorage } from "./file-storage";

export class InvalidDeliveryPhotoError extends Error {
  constructor(options?: ErrorOptions) {
    super("Delivery proof must be a valid JPEG no larger than 5 MB", options);
    this.name = "InvalidDeliveryPhotoError";
  }
}

/** Private proof storage. Upload and validation keys are scoped to the order and assigned account. */
export function createDeliveryPhotoStorage(files: FileStorage) {
  const uploadKey = (orderId: string, accountId: string, id: string) => `delivery-uploads/${orderId}/${accountId}/${id}.jpg`;
  return {
    async deleteProof(key: string) {
      await files.delete(key);
    },
    async deleteStagedProof(orderId: string, id: string) {
      await files.delete(`delivery-proofs/${orderId}/${id}.jpg`);
    },
    async deleteUpload(orderId: string, accountId: string, id: string) {
      await files.delete(uploadKey(orderId, accountId, id));
    },
    async createUpload(orderId: string, accountId: string, input: unknown) {
      const body = DeliveryPhotoUploadBody.parse(input);
      const id = randomUUID();
      const uploadUrl = await files.uploadUrl(uploadKey(orderId, accountId, id), body.contentType, { byteLength: body.byteLength, expiresIn: 15 * 60 });
      return { id, uploadUrl };
    },
    async save(orderId: string, accountId: string, id: string, byteLength: number) {
      let source: Buffer;
      try { source = await files.read(uploadKey(orderId, accountId, id), DELIVERY_PHOTO_MAX_BYTES); }
      catch (error) {
        if (error instanceof FileTooLargeError) throw new InvalidDeliveryPhotoError({ cause: error });
        throw error;
      }
      if (source.length !== byteLength) throw new InvalidDeliveryPhotoError();
      let proof: Buffer;
      try {
        const image = sharp(source, { failOn: "warning" });
        const metadata = await image.metadata();
        if (metadata.format !== "jpeg") throw new Error("Not JPEG");
        proof = await image.rotate().resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();
      } catch (error) { throw new InvalidDeliveryPhotoError({ cause: error }); }
      const key = `delivery-proofs/${orderId}/${id}.jpg`;
      await files.write(key, proof, "image/jpeg");
      return key;
    },
  };
}

export type DeliveryPhotoStorage = ReturnType<typeof createDeliveryPhotoStorage>;
