import type { CartLine, FeedQuery } from "@ygo/contracts";
import { formatMoney } from "@ygo/format";
import { Button, Text } from "@ygo/mobile";
import { router, useLocalSearchParams, useNavigation } from "expo-router";
import { useMemo } from "react";
import { ActivityIndicator, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Stepper } from "../../components/stepper";
import { TopBar } from "../../components/top-bar";
import { feeText, reasonText, type CartView } from "../../lib/cart";
import { goHome } from "../../lib/go-home";
import { packLabel } from "../../lib/shop-page";
import { useCart } from "../../lib/use-cart";
import { strings } from "../../strings";

// C07 Cart (#406): each line with its total, every fee by name and the total to pay, all from the server (CRT-2).
// Each reason the cart can't be ordered names its fix (CRT-4). Placing the order is #52.

type Params = { shopId: string; pincode: string; latitude: string; longitude: string };

const words = strings.cart;
const money = (amount: string) => formatMoney(Number(amount));

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
            {[line.brand, packLabel(line.quantity, line.baseUnit), money(line.price)].filter(Boolean).join(" · ")}
          </Text>
        </View>
        {orderable && (saving || !line.lineTotal ? pending : <Text className="text-label font-semibold tabular-nums text-text">{money(line.lineTotal)}</Text>)}
      </View>
      {orderable ? (
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

function Row({ label, value, total = false }: { label: string; value: string; total?: boolean }) {
  return (
    <View className="flex-row items-center justify-between gap-3 py-1">
      <Text className={total ? "text-body font-semibold text-text" : "text-body text-muted"}>{label}</Text>
      <Text className={`tabular-nums ${total ? "text-title font-semibold text-text" : "text-body text-text"}`}>{value}</Text>
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
                <View className="mt-4 rounded-card border border-border bg-surface p-4">
                  <Row label={words.items} value={money(quote.productValue)} />
                  <Row label={words.delivery} value={feeText(quote.deliveryFee)} />
                  {quote.smallCartFee && <Row label={words.smallCart} value={money(quote.smallCartFee)} />}
                  <View className="mt-2 border-t border-border pt-2">
                    <Row label={words.total} value={money(quote.total)} total />
                  </View>
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
          <Text className="mt-4 text-secondary text-muted">{words.footer}</Text>
        </>
      )}
    </View>
  );
}

export default function CartScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { shopId, pincode, latitude, longitude } = useLocalSearchParams<Params>();
  const query = useMemo<FeedQuery | undefined>(() => {
    const place = { pincode, latitude: Number(latitude), longitude: Number(longitude) };
    return pincode && Number.isFinite(place.latitude) && Number.isFinite(place.longitude) ? place : undefined;
  }, [pincode, latitude, longitude]);
  const { view, setCount, retry, reload } = useCart(shopId ?? "", query);
  // Back to the shop page this cart was opened from, or a new one when it isn't in the stack.
  const backToShop = () => router.navigate({ pathname: "/shop/[id]", params: { id: shopId, pincode, latitude, longitude } });

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
            <Button label={words.retry} onPress={() => reload(query)} variant="text" />
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
        {view.status === "ready" && query && <Cart view={view} setCount={setCount} retry={retry} backToShop={backToShop} />}
      </ScrollView>
    </View>
  );
}
