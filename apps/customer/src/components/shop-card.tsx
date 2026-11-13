import type { FeedQuery, FeedShop } from "@ygo/contracts";
import { formatRating } from "@ygo/format";
import { Text } from "@ygo/mobile";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { closedLine, termsLine } from "../lib/feed";
import { Star } from "./icons";
import { strings } from "../strings";

/** A shop's card on C04 and C16 (DSC-2): tapping it opens C05 for the same place. */
export function ShopCard({ shop, query, now, children }: { shop: FeedShop; query: FeedQuery; now: number; children?: ReactNode }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push({ pathname: "/shop/[id]", params: { id: shop.id, pincode: query.pincode, latitude: String(query.latitude), longitude: String(query.longitude) } })}
      className="rounded-card border border-border bg-surface p-4 active:bg-primary-subtle"
    >
      <View className="flex-row items-center justify-between gap-2">
        <Text className="flex-1 text-headline font-semibold text-text">{shop.name}</Text>
        {shop.rating !== null && (
          <View accessibilityLabel={strings.rating.starAriaLabel(shop.rating)} className="flex-row items-center gap-1">
            <Star size={14} className="text-accent" fill="currentColor" />
            <Text className="text-secondary font-medium tabular-nums text-text">{formatRating(shop.rating)}</Text>
          </View>
        )}
      </View>
      <Text className="mt-1 text-secondary tabular-nums text-muted">
        {termsLine(shop)}
      </Text>
      {!shop.open && <Text className="mt-1 text-secondary tabular-nums text-muted">{closedLine(shop, now)}</Text>}
      {children}
    </Pressable>
  );
}
