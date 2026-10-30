import type { FeedQuery } from "@ygo/contracts";
import { useFocusEffect } from "expo-router";
import { useCallback, useSyncExternalStore } from "react";
import { api, session } from "../api";
import { createCart, stockLeft, type Cart } from "./cart";
import { createDeliverTo, type DeliverToStore } from "./deliver-to";

// One cart per shop, so C05 and C07 show the same counts (#406). The server holds the cart.
const carts = new Map<string, Cart>();
// C07's Deliver to for each shop, kept until the app closes (owner's answer 3 on #427).
const deliverTos = new Map<string, DeliverToStore>();

// The carts belong to one account: a sign-out or another account drops them, with any unsent taps,
// so a save waiting for its pause can't carry one account's taps under the next one's sign-in.
let owner: string | undefined;
session.subscribe(() => {
  const state = session.get();
  const account = "account" in state ? state.account.id : undefined;
  if (account === owner) return;
  owner = account;
  for (const cart of carts.values()) cart.stop();
  carts.clear();
  deliverTos.clear();
});

function cartFor(shopId: string): Cart {
  let cart = carts.get(shopId);
  if (!cart) {
    cart = createCart(api, shopId);
    carts.set(shopId, cart);
  }
  return cart;
}

/** The shop's cart, read again each time the screen shows; `query` is undefined until the place is known. */
export function useCart(shopId: string, query: FeedQuery | undefined) {
  const cart = cartFor(shopId);
  const view = useSyncExternalStore(cart.subscribe, cart.get);
  const { pincode, latitude, longitude } = query ?? {};
  useFocusEffect(useCallback(() => {
    if (pincode !== undefined && latitude !== undefined && longitude !== undefined) void cart.load({ pincode, latitude, longitude });
  }, [cart, pincode, latitude, longitude]));
  return { cart, view };
}

/** One pack's count and the packs left at stock, so a tap redraws only the pack it changed. */
export function usePack(cart: Cart, listingId: string): { count: number; left: number | null } {
  const count = useSyncExternalStore(cart.subscribe, () => cart.get().lines.find((line) => line.listingId === listingId)?.count ?? 0);
  const left = useSyncExternalStore(cart.subscribe, () => stockLeft(cart.get().server, listingId));
  return { count, left };
}

/** The addresses this shop delivers to and the one chosen, read again each time C07 shows; `place` is Home's. */
export function useDeliverTo(shopId: string, place: FeedQuery | undefined) {
  let deliverTo = deliverTos.get(shopId);
  if (!deliverTo) {
    deliverTo = createDeliverTo(api, shopId);
    deliverTos.set(shopId, deliverTo);
  }
  const store = deliverTo;
  const view = useSyncExternalStore(store.subscribe, store.get);
  const { pincode, latitude, longitude } = place ?? {};
  useFocusEffect(useCallback(() => {
    void store.load(pincode !== undefined && latitude !== undefined && longitude !== undefined ? { pincode, latitude, longitude } : undefined);
  }, [store, pincode, latitude, longitude]));
  return { deliverTo: store, view };
}
