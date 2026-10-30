import type { FeedQuery } from "@ygo/contracts";
import { useFocusEffect } from "expo-router";
import { useCallback, useSyncExternalStore } from "react";
import { api } from "../api";
import { createCart, stockLeft, type Cart } from "./cart";

// One cart per shop for the app's life, so C05 and C07 show the same counts (#406). The server holds the cart.
const carts = new Map<string, Cart>();

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
