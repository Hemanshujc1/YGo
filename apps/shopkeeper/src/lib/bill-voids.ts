import type { ApiResult } from "@ygo/api-client";
import type { ShopCounterBillsResponse } from "@ygo/contracts";
import type { OpeningStockQueue } from "./opening-stock-queue";

/**
 * Bill screen and S08 ask the server which bills are voided and keep it on the phone (#493). Only a good answer is
 * used, and it only adds: an offline phone, a failed read or an empty list leaves every void already known.
 * Returns whether a new void was learned, so the screen reads its cards again.
 */
export async function refreshBillVoids(client: { shopCounterBills(): Promise<ApiResult<ShopCounterBillsResponse>> }, queue: Pick<OpeningStockQueue, "saveVoids">, stillCurrent: () => boolean = () => true): Promise<boolean> {
  try {
    const answer = await client.shopCounterBills();
    // The account may have changed while the server answered: its bills never go into another account's phone database.
    return answer.ok && stillCurrent() ? queue.saveVoids(answer.data.bills) : false;
  } catch {
    return false;
  }
}
