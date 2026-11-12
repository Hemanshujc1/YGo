import { access, session } from "../api";
import { openOpeningStock } from "./opening-stock-database";
import type { DeliveryCache } from "./shop-orders";

/** This account's queue and shop, when the shop may use the phone's own database; the screens save delivery work through it. */
export async function openDelivery() {
  const identity = session.get();
  if (!("account" in identity)) return null;
  const shopId = access.get().shopId;
  if (!shopId || !access.allowed(identity.account.id, shopId)) return null;
  return { queue: await openOpeningStock(identity.account.id), shopId };
}

/** The encrypted copy of My deliveries (#617). It opens the account's database on each call, which is one open handle. */
export const deliveryCache: DeliveryCache = {
  saveList: async (list) => (await openDelivery())?.queue.deliveries.saveList(list),
  list: async () => (await openDelivery())?.queue.deliveries.list() ?? null,
  saveOrder: async (order, offset) => (await openDelivery())?.queue.deliveries.saveOrder(order, offset),
  order: async (id) => (await openDelivery())?.queue.deliveries.order(id) ?? null,
};
