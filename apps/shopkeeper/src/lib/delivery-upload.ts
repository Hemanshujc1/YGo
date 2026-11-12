import type { ApiResult } from "@ygo/api-client";
import type { DeliveryPhotoUpload, SyncAction, SyncActionsBody } from "@ygo/contracts";
import type { DeliveryStore } from "./delivery-store";

/** The server's upload lasts 15 minutes (#616); one older than this is asked for again before the action goes. */
export const UPLOAD_FRESH_MS = 10 * 60_000;
type Uploaded = string | "network" | "refused";
type Client = { deliveryPhotoUpload(orderId: string, body: { contentType: "image/jpeg"; byteLength: number }): Promise<ApiResult<DeliveryPhotoUpload>> };
const transient = (status: number | undefined) => status === undefined || status >= 500 || status === 408 || status === 429;

/** Ask for an upload and send the photo; its id, or why not: "network" is worth another try, "refused" is the server's answer. */
export async function uploadPhoto(client: Client, orderId: string, bytes: Uint8Array): Promise<Uploaded> {
  const made = await client.deliveryPhotoUpload(orderId, { contentType: "image/jpeg", byteLength: bytes.byteLength }).catch(() => null);
  if (!made) return "network";
  if (!made.ok) return transient(made.status) ? "network" : "refused";
  const put = await fetch(made.data.uploadUrl, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: bytes as unknown as BodyInit }).catch(() => null);
  return !put ? "network" : put.ok ? made.data.id : transient(put.status) ? "network" : "refused";
}

/**
 * Before a batch goes, upload each delivery action's proof photo, one at a time in queue order, and put the server's upload id into the
 * action (saved first, so a replay sends the same bytes). The server's upload id is valid for minutes, so the action goes straight after.
 * An upload that cannot be reached stops the batch there and returns what came before; null when nothing is ready. A photo the server
 * refuses leaves the stand-in id, so the server refuses the action itself and the phone shows why, rather than the sequence stalling.
 */
export async function prepareDeliveries(store: DeliveryStore, batch: SyncActionsBody, upload: (orderId: string, bytes: Uint8Array) => Promise<Uploaded>, now = () => new Date()): Promise<SyncActionsBody | null> {
  const ready: SyncAction[] = [];
  for (const action of batch.actions) {
    const payload = action.payload as { orderId?: string; photoUploadId?: string };
    const photoId = action.type.startsWith("delivery_") && payload.photoUploadId ? store.photoFor(payload.photoUploadId) : null;
    const photo = photoId ? store.photo(photoId) : null;
    if (photoId && photo && (!photo.uploadId || (!store.sent(action.id) && now().getTime() - Date.parse(photo.uploadedAt ?? "") > UPLOAD_FRESH_MS))) {
      const id = await upload(photo.orderId, photo.bytes);
      if (id === "network") break;
      if (id !== "refused") {
        store.uploaded(photoId, id);
        const next = { ...action, payload: { ...payload, photoUploadId: id } };
        store.rewrite(next);
        ready.push(next);
        continue;
      }
    } else if (photo?.uploadId && payload.photoUploadId !== photo.uploadId) {
      const next = { ...action, payload: { ...payload, photoUploadId: photo.uploadId } };
      store.rewrite(next);
      ready.push(next);
      continue;
    }
    ready.push(action);
  }
  return ready.length ? { ...batch, actions: ready } : null;
}
