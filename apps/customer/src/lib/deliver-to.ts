import type { ApiResult } from "@ygo/api-client";
import type { FeedQuery, SavedAddress, SavedAddressesResponse } from "@ygo/contracts";
import { strings } from "../strings";
import { loadAddresses } from "./saved-addresses";

/** C07's "Deliver to: Home · Flat 4B". */
export const deliverLine = (address: SavedAddress) => `${strings.confirm[address.label]} · ${address.flat}`;

/** The cart is priced for the address it goes to, at its own pin. */
export function addressQuery(address: SavedAddress): FeedQuery | undefined {
  return address.point ? { pincode: address.pincode, ...address.point } : undefined;
}

/** The address Confirm location just saved for C07's Add address, chosen when the cart shows again (owner's answer 4 on #427). */
let added: string | undefined;
export const addedFromCart = (id: string) => void (added = id);

/**
 * Which address C07 delivers to (owner's answers 2 and 3 on #427): the Customer's own choice for
 * this shop, else the place chosen on Home, else the newest. `addresses` are the ones the shop
 * delivers to, newest first.
 */
export function pickAddress(
  addresses: readonly SavedAddress[],
  { chosen, place }: { chosen: string | undefined; place: FeedQuery | undefined },
): SavedAddress | null {
  const kept = addresses.find((address) => address.id === chosen);
  if (kept) return kept;
  const here = place && addresses.find(({ pincode, point }) =>
    pincode === place.pincode && point?.latitude === place.latitude && point.longitude === place.longitude);
  return here || (addresses[0] ?? null);
}

export type DeliverTo = { status: "loading" | "failed" | "ready"; addresses: SavedAddress[]; address: SavedAddress | null };

/** One shop's Deliver to, kept with its cart until the app closes or the account changes. */
export function createDeliverTo(client: { savedAddresses(shopId: string): Promise<ApiResult<SavedAddressesResponse>> }, shopId: string) {
  let view: DeliverTo = { status: "loading", addresses: [], address: null };
  /** Set by the Customer, or by an address they just added; otherwise the choice follows Home's place. */
  let chosen: string | undefined;
  let ticket = 0;
  const listeners = new Set<() => void>();
  const set = (next: Partial<DeliverTo>) => {
    view = { ...view, ...next };
    for (const listener of listeners) listener();
  };

  return {
    get: () => view,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    /** Reads the addresses again each time C07 shows; `place` is Home's. */
    async load(place: FeedQuery | undefined) {
      const mine = ++ticket;
      if (view.status === "failed") set({ status: "loading" });
      const found = await loadAddresses({ savedAddresses: () => client.savedAddresses(shopId) });
      if (mine !== ticket) return;
      // A failed reload keeps the list shown.
      if (!found) return set({ status: view.status === "ready" ? "ready" : "failed" });
      // An address added from C07 the shop doesn't deliver to stays out, and the choice stays as it was.
      if (added && found.some((row) => row.id === added)) chosen = added;
      added = undefined;
      const address = pickAddress(found, { chosen, place });
      set({ status: "ready", addresses: found, address });
    },

    choose(id: string) {
      const address = view.addresses.find((row) => row.id === id);
      if (!address) return;
      chosen = id;
      set({ address });
    },
  };
}

export type DeliverToStore = ReturnType<typeof createDeliverTo>;
