import type { SyncActionsResponse } from "@ygo/contracts";
import { access, accountEpoch, api, session } from "../api";
import { isCurrentAccount } from "./account";
import { legacyOpeningStock, openOpeningStock } from "./opening-stock-database";
import { syncOpeningStockBatch } from "./opening-stock-queue";
import { createSyncLoop, type Outcome } from "./sync-loop";

const halt = { kind: "halt", value: null } as const;
// No answer, a server fault or a busy server may pass; any other refusal needs the person.
const kindOf = (status: number | undefined) => status === undefined || status >= 500 || status === 408 || status === 429 ? "retry" as const : "halt" as const;

/**
 * One pass: send the queue in order, then pull Stock. Any verified shop may
 * send (opening stock starts at Approved); only a Live or Suspended lease
 * pulls Stock. A late answer for an earlier account or shop is dropped.
 */
export async function stockSyncPass(): Promise<Outcome<SyncActionsResponse>> {
  const identity = session.get();
  if (!("account" in identity)) return halt;
  const account = identity.account, epoch = accountEpoch();
  const answer = await access.verify(account);
  if (!isCurrentAccount(account.id, epoch)) return halt;
  const view = access.get();
  const pulls = !!view.shopId && access.allowed(account.id, view.shopId);
  const shopId = pulls ? view.shopId : view.mode === "online" && answer?.state === "approved" ? answer.shopId : null;
  // Online with no answer means the access check itself failed to arrive.
  if (!shopId) return view.mode === "online" && !answer ? { kind: "retry", value: null } : halt;
  const still = () => isCurrentAccount(account.id, epoch) && (!pulls || access.allowed(account.id, shopId));

  const queue = await openOpeningStock(account.id);
  if (!still()) return halt;
  if (answer?.shopId === shopId) queue.importLegacy(shopId, legacyOpeningStock);
  let refused: "retry" | "halt" | null = null;
  const since = pulls ? queue.cache.cursor(shopId) : undefined;
  const response = await syncOpeningStockBatch(queue, shopId, async (body) => {
    const sent = await api.syncActions(body);
    if (!sent.ok) refused = kindOf(sent.status);
    return sent;
  }, still);
  if (!still()) return halt;
  // A thrown or dropped reply leaves the actions queued; the server replays its first answer.
  const sent = !response ? refused ?? "retry" : response.results.some((row) => row.status === "retry") ? "retry" : "done";
  if (!pulls) return { kind: sent, value: response };

  // Pull even when sending failed: other phones' changes still arrive.
  if (response) queue.cache.confirmFlags(shopId, response.results, since);
  const from = queue.cache.cursor(shopId);
  const page = await api.syncChanges(from).catch(() => null);
  if (!still() || (page?.ok && page.data.shopId !== shopId)) return halt;
  if (page?.ok) queue.cache.apply(page.data, from);
  const pulled = !page ? "retry" : page.ok ? "done" : kindOf(page.status);
  const order = ["done", "retry", "halt"] as const;
  return { kind: order[Math.max(order.indexOf(sent), order.indexOf(pulled))] ?? "halt", value: response };
}

export const stockSync = createSyncLoop(stockSyncPass);
