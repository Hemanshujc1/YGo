import type { ShopOrderSummary } from "@ygo/contracts";
import { formatTime } from "@ygo/format";
import { StatusChip, Text } from "@ygo/mobile";
import { Link } from "expo-router";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { money } from "../lib/money";
import { treatments } from "../lib/shop-orders";
import { strings } from "../strings";

const words = strings.orders;

/** One order's card, opening S05: on S04 (#431), and pinned on Home while S03 shows (#507) with its countdown as `children`. */
export function OrderRow({ order, chip, children }: { order: ShopOrderSummary; chip: boolean; children?: ReactNode }) {
  return (
    <Link href={`/orders/${order.id}`} asChild>
      <Pressable accessibilityRole="button" className="gap-1 rounded-card border border-border bg-surface p-4 active:bg-primary-subtle">
        <View className="flex-row items-center justify-between gap-3">
          <Text className="text-body font-semibold text-text">{words.detailTitle(order.number)}</Text>
          <Text className="text-secondary tabular-nums text-muted">{formatTime(order.placedAt)}</Text>
        </View>
        <Text className="text-body tabular-nums text-text">{words.row(order.itemCount, money(order.total))}</Text>
        <Text className="text-secondary text-muted">{[order.address.flat, order.address.areaLine].filter(Boolean).join(", ")}</Text>
        {/* Done today mixes delivered, rejected, expired and cancelled orders (owner's answer 3 on #431). */}
        {order.cancelAsked && <Text className="text-secondary font-semibold text-danger">{words.cancelAsked}</Text>}
        {chip && <StatusChip word={words.statuses[order.status]} treatment={treatments[order.status]} />}
        {children}
      </Pressable>
    </Link>
  );
}
