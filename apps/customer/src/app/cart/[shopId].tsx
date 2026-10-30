import type { CartLine, SavedAddress } from "@ygo/contracts";
import { Button, Text } from "@ygo/mobile";
import { router, useLocalSearchParams, useNavigation } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../../api";
import { Stepper } from "../../components/stepper";
import { QuoteRows } from "../../components/quote-rows";
import { TopBar } from "../../components/top-bar";
import { reasonText, type CartView } from "../../lib/cart";
import { addressQuery, deliverLine, type DeliverTo } from "../../lib/deliver-to";
import { paramsQuery } from "../../lib/feed";
import { goHome } from "../../lib/go-home";
import { money } from "../../lib/money";
import { placeOrder } from "../../lib/order";
import { addressLine } from "../../lib/saved-addresses";
import { packLabel, partLabel } from "../../lib/shop-page";
import { useCart, useDeliverTo } from "../../lib/use-cart";
import { openPlaced } from "../../lib/use-order";
import { strings } from "../../strings";

// C07 Cart (#406): each line with its total, every fee by name and the total to pay, all from the server (CRT-2).
// Each reason the cart can't be ordered names its fix (CRT-4). Place order sends it to a saved address the shop delivers to (#427).

type Params = { shopId: string; pincode: string; latitude: string; longitude: string };

const words = strings.cart;

/** Where a figure goes while a newer cart is saving: never the old figure (design system rule 7). */
const pending = <View className="h-5 w-14 rounded-tag bg-sunken" />;

function Line({ line, count, saving, setCount }: { line: CartLine; count: number; saving: boolean; setCount: (count: number) => void }) {
  const orderable = line.state === "orderable";
  return (
    <View className="gap-2 border-t border-border py-3">
      <View className="flex-row gap-3">
        <View className="flex-1">
          <Text className="text-body font-semibold text-text">{line.name}</Text>
          <Text className="text-secondary tabular-nums text-muted">
            {[line.brand, packLabel(line.quantity, line.baseUnit), line.part ? partLabel(line.part, line.baseUnit) : money(line.price)]
              .filter(Boolean).join(" · ")}
          </Text>
        </View>
        {orderable && (saving || !line.lineTotal ? pending : <Text className="text-label font-semibold tabular-nums text-text">{money(line.lineTotal)}</Text>)}
      </View>
      {line.part ? (
        // The whole remainder of a pack, set only on an orderable line: removed, never stepped (owner's answer 5 on #377).
        <View className="items-end">
          <Button label={words.remove} onPress={() => setCount(0)} variant="text" />
        </View>
      ) : orderable ? (
        <View className="items-end">
          <Stepper count={count} max={line.left} onChange={setCount} />
        </View>
      ) : (
        <View className="flex-row items-center justify-between gap-3">
          <View className="h-6 justify-center rounded-tag bg-sunken px-2">
            <Text className="text-small-label font-medium text-muted">{line.state === "unavailable" ? words.unavailable : words.outOfStock}</Text>
          </View>
          <Button label={words.remove} onPress={() => setCount(0)} variant="text" />
        </View>
      )}
    </View>
  );
}

function Cart({ view, setCount, retry, backToShop }: { view: CartView; setCount: (listingId: string, count: number) => void; retry: () => void; backToShop: () => void }) {
  const server = view.server;
  if (!server) return null;
  // The counts on screen, each with what the server last said about its pack; a pack still on its first save waits for the reply.
  const lines = view.lines.flatMap(({ listingId, count }) => {
    const line = server.lines.find((known) => known.listingId === listingId);
    return line ? [{ line, count }] : [];
  });
  const quote = server.quote;
  const now = Date.now();
  return (
    <View>
      {view.notice && <Text className="mb-3 text-body text-text">{view.notice}</Text>}
      {view.lines.length === 0 ? (
        <View className="items-start">
          <Text className="text-body text-muted">{words.empty}</Text>
          <Button label={words.backToShop} onPress={backToShop} variant="text" />
        </View>
      ) : (
        <>
          <View className="rounded-card border border-border bg-surface px-4">
            {lines.map(({ line, count }, index) => (
              <View key={line.listingId} className={index === 0 ? "-mt-px" : ""}>
                <Line line={line} count={count} saving={view.saving} setCount={(next) => setCount(line.listingId, next)} />
              </View>
            ))}
          </View>

          {view.message ? (
            <View className="mt-4 items-start">
              <Text className="text-body font-semibold text-text">{words.notSaved}</Text>
              <Text className="text-secondary text-muted">{view.message}</Text>
              <Button label={words.retry} onPress={retry} variant="text" />
            </View>
          ) : view.saving ? (
            <View className="mt-4 min-h-12 flex-row items-center gap-2">
              <ActivityIndicator className="text-primary" />
              <Text className="text-body text-muted">{words.updating}</Text>
            </View>
          ) : (
            <>
              {quote && (
                <View className="mt-4">
                  <QuoteRows quote={quote} />
                </View>
              )}
              {server.reasons.map((reason) => (
                <View key={reason.code} className="mt-4 items-start rounded-card bg-sunken px-4 py-3">
                  <Text className="text-body text-text">{reasonText(reason, now)}</Text>
                  {(reason.code === "BELOW_MINIMUM_CART" || reason.code === "BELOW_CONTRIBUTION_FLOOR") && (
                    <Button label={words.backToShop} onPress={backToShop} variant="text" />
                  )}
                </View>
              ))}
            </>
          )}
        </>
      )}
    </View>
  );
}

/** "Deliver to: Home · Flat 4B" with Change, or what to do when the shop delivers to none of the saved addresses (owner's answer 5 on #427). */
function DeliverToRow({ to, onChange, onAdd, retry }: { to: DeliverTo; onChange: () => void; onAdd: () => void; retry: () => void }) {
  if (to.status === "loading") {
    return (
      <View className="mt-4 min-h-12 flex-row items-center gap-2">
        <ActivityIndicator className="text-primary" />
        <Text className="text-body text-muted">{words.loadingAddresses}</Text>
      </View>
    );
  }
  if (to.status === "failed") {
    return (
      <View className="mt-4 items-start">
        <Text className="text-body text-text">{words.addressesFailed}</Text>
        <Button label={words.retry} onPress={retry} variant="text" />
      </View>
    );
  }
  if (!to.address) {
    return (
      <View className="mt-4 items-start rounded-card bg-sunken px-4 py-3">
        <Text className="text-body text-text">{words.noAddress}</Text>
        <Button label={words.addAddress} onPress={onAdd} variant="text" />
      </View>
    );
  }
  return (
    <View className="mt-4 flex-row items-center gap-3 rounded-card border border-border bg-surface py-1 pl-4 pr-1">
      <View className="flex-1">
        <Text className="text-secondary text-muted">{words.deliverTo}</Text>
        <Text className="text-body font-semibold text-text">{deliverLine(to.address)}</Text>
      </View>
      <Button label={words.change} onPress={onChange} variant="text" />
    </View>
  );
}

/** Every address the shop delivers to, the chosen one marked, then Add address (owner's answer 3 on #427). */
function AddressSheet({ to, onPick, onAdd, onClose }: { to: DeliverTo; onPick: (address: SavedAddress) => void; onAdd: () => void; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal transparent visible animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
      <View className="flex-1 justify-end bg-scrim">
        <Pressable accessibilityRole="button" accessibilityLabel={words.close} onPress={onClose} className="flex-1" />
        <View accessibilityViewIsModal className="max-h-[70%] gap-2 rounded-t-sheet bg-raised px-4 pt-4" style={{ paddingBottom: insets.bottom + 12 }}>
          <Text accessibilityRole="header" className="text-headline font-semibold text-text">{words.deliverTo}</Text>
          <ScrollView>
            {to.addresses.map((address) => {
              const selected = address.id === to.address?.id;
              return (
                <Pressable
                  key={address.id}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  onPress={() => onPick(address)}
                  className={`min-h-14 justify-center rounded-input px-3 py-2 ${selected ? "bg-primary-subtle" : ""}`}
                >
                  <Text className={`text-body font-semibold ${selected ? "text-on-primary-subtle" : "text-text"}`}>{strings.confirm[address.label]}</Text>
                  <Text className={`text-secondary ${selected ? "text-on-primary-subtle" : "text-muted"}`}>{addressLine(address)}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
          <Button label={words.addAddress} onPress={onAdd} variant="text" />
          <Button label={words.close} onPress={onClose} variant="text" />
        </View>
      </View>
    </Modal>
  );
}

export default function CartScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { shopId, pincode, latitude, longitude } = useLocalSearchParams<Params>();
  const home = useMemo(() => paramsQuery({ pincode, latitude, longitude }), [pincode, latitude, longitude]);
  const { deliverTo, view: to } = useDeliverTo(shopId ?? "", home);
  // Priced for the address it goes to, at that address's pin (#52 answer 3); Home's place until one is chosen.
  const query = (to.address && addressQuery(to.address)) || home;
  const { cart, view } = useCart(shopId ?? "", query);
  const [picking, setPicking] = useState(false);
  const [placing, setPlacing] = useState(false);
  /** What stopped the last Place order; `retry` turns the button into Try again (design system, button errors). */
  const [problem, setProblem] = useState<{ text: string; retry: boolean } | null>(null);
  // Set before React re-renders, so a second tap never places twice.
  const working = useRef(false);
  // Back to the shop page this cart was opened from, or a new one when it isn't in the stack.
  const backToShop = () => router.navigate({ pathname: "/shop/[id]", params: { id: shopId, pincode, latitude, longitude } });
  // C15's Confirm location at the cart's place; after Confirm it comes back here (owner's answer 4 on #427).
  const addAddress = () => {
    setPicking(false);
    if (query) router.push({ pathname: "/confirm-location", params: { latitude: String(query.latitude), longitude: String(query.longitude), back: "1" } });
  };
  const setCount = (listingId: string, count: number) => {
    setProblem(null);
    cart.setCount(listingId, count);
  };

  async function place() {
    const server = view.server;
    const address = to.address;
    if (working.current || !server?.quote || !server.placeable || !address || !shopId) return;
    working.current = true;
    setPlacing(true);
    setProblem(null);
    const done = await placeOrder(api, shopId, { ...server, quote: server.quote }, address.id);
    working.current = false;
    setPlacing(false);
    switch (done.kind) {
      case "placed":
        // The server emptied the cart as it placed the order: read it again rather than guess the revision.
        openPlaced(done.order);
        cart.retry();
        // In place of the cart, so Back goes to the shop page and not to an empty cart (owner's answer 7 on #427).
        return router.replace({ pathname: "/order/[id]", params: { id: done.order.id, placed: "1" } });
      case "changed":
        if (done.cart && query) cart.adopt(done.cart, query);
        else cart.retry();
        return setProblem({ text: words.changed, retry: false });
      case "gone":
        // The server can't say which one: read both again.
        setProblem({ text: words.gone, retry: false });
        cart.retry();
        return void deliverTo.load(home);
      // Only no answer turns the button into Try again; a refusal won't change on a retry (owner's answer 6 on #427).
      case "offline":
        return setProblem({ text: words.placeOffline, retry: true });
      case "error":
        return setProblem({ text: strings.errors[done.code], retry: false });
    }
  }

  const server = view.server;
  // Off until the cart is priced at the chosen address, so the total on the button is the one sent.
  const priced = view.pricedFor !== null && query !== undefined && view.pricedFor.pincode === query.pincode
    && view.pricedFor.latitude === query.latitude && view.pricedFor.longitude === query.longitude;
  const placeable = Boolean(server?.placeable && server.quote && to.address && priced && !view.saving && !view.message);

  return (
    <View className="flex-1 bg-bg" style={{ paddingTop: insets.top }}>
      <TopBar title={view.server?.shop.name || words.title} />
      <ScrollView contentContainerClassName="px-4" contentContainerStyle={{ paddingTop: 8, paddingBottom: insets.bottom + 32 }}>
        {query && view.status === "loading" && (
          <View className="min-h-12 flex-row items-center gap-2">
            <ActivityIndicator className="text-primary" />
            <Text className="text-body text-muted">{words.loading}</Text>
          </View>
        )}
        {query && view.status === "failed" && (
          <View className="items-start">
            <Text className="text-body font-semibold text-text">{words.failed}</Text>
            <Text className="text-secondary text-muted">{view.message}</Text>
            <Button label={words.retry} onPress={cart.retry} variant="text" />
          </View>
        )}
        {/* A link without a place has no cart to price. */}
        {(!query || view.status === "none") && (
          <View className="items-start">
            <Text className="text-headline font-semibold text-text">{strings.shop.notServing}</Text>
            <Text className="mt-1 text-body text-muted">{strings.shop.notServingBody}</Text>
            <Button label={strings.shop.home} onPress={() => goHome(navigation)} variant="text" />
          </View>
        )}
        {view.status === "ready" && query && <Cart view={view} setCount={setCount} retry={cart.retry} backToShop={backToShop} />}
        {view.status === "ready" && query && view.lines.length > 0 && (
          <>
            <DeliverToRow to={to} onChange={() => setPicking(true)} onAdd={addAddress} retry={() => void deliverTo.load(home)} />
            {server?.quote && (
              <View className="mt-4">
                <Button
                  label={placing ? words.placing : problem?.retry ? words.retry : words.place(money(server.quote.total))}
                  onPress={() => void place()}
                  busy={placing}
                  disabled={!placeable}
                />
                {problem && <Text accessibilityLiveRegion="polite" className="mt-2 text-secondary text-text">{problem.text}</Text>}
              </View>
            )}
            <Text className="mt-4 text-secondary text-muted">{words.footer}</Text>
          </>
        )}
      </ScrollView>
      {picking && (
        <AddressSheet
          to={to}
          onPick={(address) => {
            setPicking(false);
            setProblem(null);
            deliverTo.choose(address.id);
          }}
          onAdd={addAddress}
          onClose={() => setPicking(false)}
        />
      )}
    </View>
  );
}
