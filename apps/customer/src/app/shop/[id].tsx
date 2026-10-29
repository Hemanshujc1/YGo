import type { ShopPagePack, ShopPageProduct, ShopPageResponse } from "@ygo/contracts";
import { formatMoney } from "@ygo/format";
import { Button, Text } from "@ygo/mobile";
import { useFocusEffect, useLocalSearchParams, useNavigation } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../../api";
import { TopBar } from "../../components/top-bar";
import { goHome } from "../../lib/go-home";
import { offLabel, packLabel } from "../../lib/shop-page";
import { strings } from "../../strings";

// C05 Shop page (#370): the shop's terms (DSC-2), then its products under their top category.
// Choosing a pack and the cart are C17 (#50); opening hours join with #371.

type PageState =
  | { kind: "loading" }
  | { kind: "loaded"; page: ShopPageResponse }
  | { kind: "not-serving" }
  | { kind: "failed"; message: string };

type Params = { id: string; pincode: string; latitude: string; longitude: string };

const words = strings.shop;
const money = (amount: string) => formatMoney(Number(amount));

function Pack({ pack, baseUnit, first }: { pack: ShopPagePack; baseUnit: ShopPageProduct["baseUnit"]; first: boolean }) {
  const off = offLabel(pack);
  return (
    <View className={`min-h-12 flex-row flex-wrap items-center gap-x-3 gap-y-1 py-2 ${first ? "" : "border-t border-border"}`}>
      <Text className="min-w-16 text-body tabular-nums text-text">{packLabel(pack.quantity, baseUnit)}</Text>
      <View className="flex-1 flex-row flex-wrap items-center justify-end gap-x-2 gap-y-1">
        {pack.outOfStock ? (
          <View className="h-6 justify-center rounded-tag bg-sunken px-2">
            <Text className="text-small-label font-medium text-muted">{words.outOfStock}</Text>
          </View>
        ) : (
          off && (
            <View className="h-6 justify-center rounded-tag bg-success-subtle px-2">
              <Text className="text-small-label font-medium text-on-success-subtle">{off}</Text>
            </View>
          )
        )}
        {pack.mrp && (
          <Text accessibilityLabel={words.mrp(money(pack.mrp))} className="text-secondary tabular-nums text-muted line-through">
            {money(pack.mrp)}
          </Text>
        )}
        <Text className={`text-label font-semibold tabular-nums ${pack.outOfStock ? "text-muted" : "text-text"}`}>{money(pack.price)}</Text>
      </View>
    </View>
  );
}

function Product({ product }: { product: ShopPageProduct }) {
  return (
    <View className="rounded-card border border-border bg-surface px-4 py-3">
      <Text className="text-body font-semibold text-text">{product.name}</Text>
      {product.brand && <Text className="text-secondary text-muted">{product.brand}</Text>}
      <View className="mt-1">
        {product.packs.map((pack, index) => <Pack key={pack.listingId} pack={pack} baseUnit={product.baseUnit} first={index === 0} />)}
      </View>
    </View>
  );
}

function Page({ page }: { page: ShopPageResponse }) {
  const { shop, groups } = page;
  return (
    <>
      <View className="rounded-card border border-border bg-surface p-4">
        <Text className="text-body tabular-nums text-text">{strings.feed.card(shop.estimatedMinutes, money(shop.deliveryFee))}</Text>
        <View className="mt-3 gap-1 border-t border-border pt-3">
          <Text className="text-body tabular-nums text-text">{words.minimumOrder(money(shop.minimumOrder))}</Text>
          <Text className="text-secondary tabular-nums text-muted">{words.fssai(shop.fssaiNumber)}</Text>
        </View>
      </View>
      {groups.length === 0 && <Text className="mt-6 text-body text-muted">{words.empty}</Text>}
      {groups.map((group) => (
        <View key={group.category} className="mt-6 gap-3">
          <Text accessibilityRole="header" className="text-headline font-semibold text-text">{group.category}</Text>
          {group.products.map((product) => <Product key={product.id} product={product} />)}
        </View>
      ))}
    </>
  );
}

export default function ShopPage() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { id, pincode, latitude, longitude } = useLocalSearchParams<Params>();
  const [state, setState] = useState<PageState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  // Asked again each time the page shows, as Home does, so stock and prices stay current.
  useFocusEffect(useCallback(() => {
    let current = true;
    setState({ kind: "loading" });
    // Home's link carries the place; a link without one (or a broken one) has nothing to check.
    const query = { pincode, latitude: Number(latitude), longitude: Number(longitude) };
    if (!id || !pincode || !Number.isFinite(query.latitude) || !Number.isFinite(query.longitude)) {
      setState({ kind: "not-serving" });
      return;
    }
    api.shopPage(id, query).then(
      (result) => {
        if (!current) return;
        if (result.ok) setState({ kind: "loaded", page: result.data });
        else if (result.code === "NOT_FOUND") setState({ kind: "not-serving" });
        else setState({ kind: "failed", message: strings.errors[result.code] });
      },
      () => current && setState({ kind: "failed", message: strings.area.offline }),
    );
    return () => {
      current = false;
    };
  }, [id, pincode, latitude, longitude, attempt]));

  return (
    <View className="flex-1 bg-bg" style={{ paddingTop: insets.top }}>
      <TopBar title={state.kind === "loaded" ? state.page.shop.name : words.title} />
      <ScrollView contentContainerClassName="px-4" contentContainerStyle={{ paddingTop: 8, paddingBottom: insets.bottom + 32 }}>
        {state.kind === "loading" && (
          <View className="min-h-12 flex-row items-center gap-2">
            <ActivityIndicator className="text-primary" />
            <Text className="text-body text-muted">{words.loading}</Text>
          </View>
        )}
        {state.kind === "failed" && (
          <View className="items-start">
            <Text className="text-body font-semibold text-text">{words.failed}</Text>
            <Text className="text-secondary text-muted">{state.message}</Text>
            <Button label={strings.area.retry} onPress={() => setAttempt((n) => n + 1)} variant="text" />
          </View>
        )}
        {state.kind === "not-serving" && (
          <View className="items-start">
            <Text className="text-headline font-semibold text-text">{words.notServing}</Text>
            <Text className="mt-1 text-body text-muted">{words.notServingBody}</Text>
            <Button label={words.home} onPress={() => goHome(navigation)} variant="text" />
          </View>
        )}
        {state.kind === "loaded" && <Page page={state.page} />}
      </ScrollView>
    </View>
  );
}
