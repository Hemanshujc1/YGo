import type { CartQuote } from "@ygo/contracts";
import { Text } from "@ygo/mobile";
import type { ReactNode } from "react";
import { View } from "react-native";
import { discountText, feeText, offerText } from "../lib/cart";
import { money } from "../lib/money";
import { strings } from "../strings";

const words = strings.cart;

function Row({ label, note, value, was, total = false }: { label: string; note?: string; value: string; was?: string; total?: boolean }) {
  return (
    <View className={`flex-row justify-between gap-3 py-1 ${note ? "items-start" : "items-center"}`}>
      <View className="flex-1">
        <Text className={total ? "text-body font-semibold text-text" : "text-body text-muted"}>{label}</Text>
        {note && <Text className="text-secondary text-muted">{note}</Text>}
      </View>
      {was && <Text className="text-secondary tabular-nums text-muted line-through">{was}</Text>}
      <Text className={`tabular-nums ${total ? "text-title font-semibold text-text" : "text-body text-text"}`}>{value}</Text>
    </View>
  );
}

/**
 * Items, the shop's discount with its offer when one applied, every fee by name and the total to pay, as C07 and C09/C19 show them (CRT-2, CRT-5).
 * `was` strikes the figures a changed total replaced, each only when it differs (C10, #578).
 */
export function QuoteRows({ quote, was, children }: { quote: CartQuote; was?: { productValue: string; total: string }; children?: ReactNode }) {
  return (
    <View className="rounded-card border border-border bg-surface p-4">
      <Row label={words.items} value={money(quote.productValue)} was={was && was.productValue !== quote.productValue ? money(was.productValue) : undefined} />
      {quote.shopDiscount && <Row label={words.shopDiscount} note={offerText(quote.shopDiscount.offer)} value={discountText(quote.shopDiscount.amount)} />}
      <Row label={words.delivery} value={feeText(quote.deliveryFee)} />
      {quote.smallCartFee && Number(quote.smallCartFee) > 0 && <Row label={words.smallCart} value={money(quote.smallCartFee)} />}
      <View className="mt-2 border-t border-border pt-2">
        <Row label={words.total} value={money(quote.total)} was={was && was.total !== quote.total ? money(was.total) : undefined} total />
      </View>
      {children}
    </View>
  );
}
