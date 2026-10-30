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

/**
 * Which address C07 delivers to (owner's answers 2–4 on #427): one just added from C07, else the
 * Customer's own choice for this shop, else the place chosen on Home, else the newest. `addresses`
 * are the ones the shop delivers to, newest first; `known` the ids the last list held.
 */
export function pickAddress(
  addresses: readonly SavedAddress[],
  { known, chosen, place }: { known: ReadonlySet<string> | null; chosen: string | undefined; place: FeedQuery | undefined },
): SavedAddress | null {
  const added = known && addresses.find((address) => !known.has(address.id));
  if (added) return added;
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
  let known: Set<string> | null = null;
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
      const address = pickAddress(found, { known, chosen, place });
      if (known && address && !known.has(address.id)) chosen = address.id;
      known = new Set(found.map((row) => row.id));
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
