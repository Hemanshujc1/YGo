import type { ShopPagePack, ShopPageProduct, ShopPageResponse } from "@ygo/contracts";
import { formatMoney } from "@ygo/format";
import { Button, Text } from "@ygo/mobile";
import { useFocusEffect, useLocalSearchParams, useNavigation } from "expo-router";
import { memo, useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, SectionList, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../../api";
import { TopBar } from "../../components/top-bar";
import { goHome } from "../../lib/go-home";
import { hoursLine, offLabel, packLabel, shopSections, weekRows } from "../../lib/shop-page";
import { strings } from "../../strings";

// C05 Shop page (#370): the shop's terms (DSC-2), then its products under their top category.
// Choosing a pack and the cart are C17 (#50). The hours line opens the week (#381).

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

/** The terms card above the list (DSC-2), with the hours line that opens the week (#381). */
function Terms({ shop }: { shop: ShopPageResponse["shop"] }) {
  const [week, setWeek] = useState(false);
  return (
    <View className="rounded-card border border-border bg-surface p-4">
      <Text className="text-body tabular-nums text-text">{strings.feed.card(shop.estimatedMinutes, money(shop.deliveryFee))}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityHint={words.hours.week}
        accessibilityState={{ expanded: week }}
        onPress={() => setWeek((open) => !open)}
        className="mt-1 min-h-12 justify-center"
      >
        <Text className={`text-body tabular-nums ${shop.open ? "text-success" : "text-muted"}`}>{hoursLine(shop, Date.now())}</Text>
      </Pressable>
      {week && (
        <View className="gap-1 pb-1">
          {weekRows(shop.hours, shop.today).map((row) => (
            <View key={row.day} className="flex-row gap-3">
              <Text className={`w-28 text-secondary ${row.today ? "font-semibold text-text" : "text-muted"}`}>{row.day}</Text>
              <Text className={`flex-1 text-secondary tabular-nums ${row.today ? "font-semibold text-text" : "text-muted"}`}>{row.text}</Text>
            </View>
          ))}
        </View>
      )}
      <View className="mt-3 gap-1 border-t border-border pt-3">
        <Text className="text-body tabular-nums text-text">{words.minimumOrder(money(shop.minimumOrder))}</Text>
        <Text className="text-secondary tabular-nums text-muted">{words.fssai(shop.fssaiNumber)}</Text>
      </View>
    </View>
  );
}

const ProductRow = memo(Product);
const productGap = () => <View className="h-3" />;

/**
 * A SectionList, so a large shop draws only the products near the screen: one section per top category (#370).
 * NativeWind maps no class prop onto SectionList's content container, so each row carries the side gutter.
 */
function Page({ page, bottom }: { page: ShopPageResponse; bottom: number }) {
  const sections = useMemo(() => shopSections(page.groups), [page.groups]);
  return (
    <SectionList
      sections={sections}
      keyExtractor={(product) => product.id}
      renderItem={({ item }) => <View className="px-4"><ProductRow product={item} /></View>}
      renderSectionHeader={({ section }) => (
        <Text accessibilityRole="header" className="px-4 pb-3 pt-6 text-headline font-semibold text-text">{section.title}</Text>
      )}
      ItemSeparatorComponent={productGap}
      ListHeaderComponent={<View className="px-4"><Terms shop={page.shop} /></View>}
      ListEmptyComponent={<Text className="mt-6 px-4 text-body text-muted">{words.empty}</Text>}
      stickySectionHeadersEnabled={false}
      contentContainerStyle={{ paddingTop: 8, paddingBottom: bottom + 32 }}
    />
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
      {state.kind === "loaded" ? (
        <Page page={state.page} bottom={insets.bottom} />
      ) : (
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
        </ScrollView>
      )}
    </View>
  );
}
