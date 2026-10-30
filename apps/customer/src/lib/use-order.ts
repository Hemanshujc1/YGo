import type { OrderResponse } from "@ygo/contracts";
import { useInFront } from "@ygo/mobile";
import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "../api";
import { createOrder } from "./order";

/** The order placement answered with, so C09 opens on it with no wait. */
const placed = new Map<string, OrderResponse>();
export const openPlaced = (order: OrderResponse) => void placed.set(order.id, order);

/**
 * One order, read every 10 s while its screen is in front and the app is in the foreground, until
 * its status is final (owner's answer 9 on #427).
 */
export function useOrder(id: string) {
  const [order] = useState(() => createOrder(api, id, placed.get(id)));
  useEffect(() => void placed.delete(id), [id]);
  const view = useSyncExternalStore(order.subscribe, order.get);
  useInFront(order);
  return { order, view };
}
