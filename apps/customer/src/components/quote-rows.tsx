import type { CartQuote } from "@ygo/contracts";
import { Text } from "@ygo/mobile";
import type { ReactNode } from "react";
import { View } from "react-native";
import { feeText } from "../lib/cart";
import { money } from "../lib/money";
import { strings } from "../strings";

const words = strings.cart;

function Row({ label, value, total = false }: { label: string; value: string; total?: boolean }) {
  return (
    <View className="flex-row items-center justify-between gap-3 py-1">
      <Text className={total ? "text-body font-semibold text-text" : "text-body text-muted"}>{label}</Text>
      <Text className={`tabular-nums ${total ? "text-title font-semibold text-text" : "text-body text-text"}`}>{value}</Text>
    </View>
  );
}

/** Items, every fee by name and the total to pay, as C07 and C09/C19 show them (CRT-2). */
export function QuoteRows({ quote, children }: { quote: CartQuote; children?: ReactNode }) {
  return (
    <View className="rounded-card border border-border bg-surface p-4">
      <Row label={words.items} value={money(quote.productValue)} />
      <Row label={words.delivery} value={feeText(quote.deliveryFee)} />
      {quote.smallCartFee && <Row label={words.smallCart} value={money(quote.smallCartFee)} />}
      <View className="mt-2 border-t border-border pt-2">
        <Row label={words.total} value={money(quote.total)} total />
      </View>
      {children}
    </View>
  );
}
