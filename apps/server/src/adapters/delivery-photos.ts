import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { DELIVERY_PHOTO_MAX_BYTES, DeliveryPhotoUploadBody } from "@ygo/contracts";
import { FileTooLargeError, privateReadUrl, type FileStorage } from "./file-storage";

export class InvalidDeliveryPhotoError extends Error {
  constructor(options?: ErrorOptions) {
    super("Delivery proof must be a valid JPEG no larger than 5 MB", options);
    this.name = "InvalidDeliveryPhotoError";
  }
}

/** Longest a transcode may run; Sharp stops it there. */
const TRANSCODE_TIMEOUT_SECONDS = 20;

/** Private proof storage. Upload and validation keys are scoped to the order and assigned account. */
export function createDeliveryPhotoStorage(files: FileStorage) {
  const uploadKey = (orderId: string, accountId: string, id: string) => `delivery-uploads/${orderId}/${accountId}/${id}.jpg`;
  return {
    /** A private read link that stops working after 5 minutes (#560); the caller has already checked who may read this order's proof. */
    async downloadUrl(key: string) {
      return privateReadUrl(files, key);
    },
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
    /**
     * Reads, transcodes and writes the proof. The signal stops it: a transfer is aborted, the transcode is
     * bounded by Sharp's own timeout, and nothing is written once the signal has fired. When save returns or
     * throws, nothing of it is still running.
     */
    async save(orderId: string, accountId: string, id: string, byteLength: number, signal?: AbortSignal) {
      let source: Buffer;
      try { source = await files.read(uploadKey(orderId, accountId, id), DELIVERY_PHOTO_MAX_BYTES, signal); }
      catch (error) {
        if (error instanceof FileTooLargeError) throw new InvalidDeliveryPhotoError({ cause: error });
        throw error;
      }
      signal?.throwIfAborted();
      if (source.length !== byteLength) throw new InvalidDeliveryPhotoError();
      let proof: Buffer;
      try {
        const image = sharp(source, { failOn: "warning" }).timeout({ seconds: TRANSCODE_TIMEOUT_SECONDS });
        const metadata = await image.metadata();
        if (metadata.format !== "jpeg") throw new Error("Not JPEG");
        proof = await image.rotate().resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();
      } catch (error) { throw new InvalidDeliveryPhotoError({ cause: error }); }
      signal?.throwIfAborted();
      const key = `delivery-proofs/${orderId}/${id}.jpg`;
      await files.write(key, proof, "image/jpeg", signal);
      return key;
    },
  };
}

export type DeliveryPhotoStorage = ReturnType<typeof createDeliveryPhotoStorage>;
