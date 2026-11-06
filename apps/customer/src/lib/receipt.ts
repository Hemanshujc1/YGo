import type { ApiResult } from "@ygo/api-client";
import type { OrderStatus, ReceiptResponse } from "@ygo/contracts";
import { shareReceipt } from "./share-receipt";

/** C19 offers the receipt for a delivered or picked-up order, and no other (#61). */
export const hasReceipt = (status: OrderStatus) => status === "delivered" || status === "picked_up";

/** Reads the receipt and opens the share sheet. "failed" covers offline, a refusal and a PDF that couldn't be made; a share sheet the Customer closes is not a failure. */
export async function makeReceipt(
  client: { receipt(id: string): Promise<ApiResult<ReceiptResponse>> },
  id: string,
  share: (receipt: ReceiptResponse) => Promise<void> = shareReceipt,
): Promise<"shared" | "failed"> {
  const result = await client.receipt(id);
  if (!result.ok) return "failed";
  try {
    await share(result.data);
    return "shared";
  } catch {
    return "failed";
  }
}
