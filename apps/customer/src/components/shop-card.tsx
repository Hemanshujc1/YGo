import type { FeedQuery, FeedShop } from "@ygo/contracts";
import { formatMoney } from "@ygo/format";
import { Text } from "@ygo/mobile";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { Pressable } from "react-native";
import { closedLine } from "../lib/feed";
import { strings } from "../strings";

/** A shop's card on C04 and C16 (DSC-2): tapping it opens C05 for the same place. */
export function ShopCard({ shop, query, now, children }: { shop: FeedShop; query: FeedQuery; now: number; children?: ReactNode }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push({ pathname: "/shop/[id]", params: { id: shop.id, pincode: query.pincode, latitude: String(query.latitude), longitude: String(query.longitude) } })}
      className="rounded-card border border-border bg-surface p-4 active:bg-primary-subtle"
    >
      <Text className="text-headline font-semibold text-text">{shop.name}</Text>
      <Text className="mt-1 text-secondary tabular-nums text-muted">
        {strings.feed.card(shop.estimatedMinutes, formatMoney(Number(shop.deliveryFee)))}
      </Text>
      {!shop.open && <Text className="mt-1 text-secondary tabular-nums text-muted">{closedLine(shop, now)}</Text>}
      {children}
    </Pressable>
  );
}
