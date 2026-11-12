import { STOCK_CHANGE_REASONS, type StockChangePayload, type StockChangeReason } from "@ygo/contracts";
import { trimDecimal } from "@ygo/format";
import { Button, Text } from "@ygo/mobile";
import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { buildStockChange } from "../lib/stock-change";
import { strings } from "../strings";

const words = strings.stock;

/**
 * Change one pack's stock with a reason from the fixed list (S11, S13, BIL-7, #67). Works offline: Save only queues the change on the phone.
 * Damaged and expired always take stock away; "Counted" sends the total, and the server works the difference out against its latest figure.
 * The amount is trimmed when the user leaves the field, not on every keystroke (#451).
 */
export function StockChangeForm({ packId, name, baseUnit, onSave, onCancel }: {
  packId: string; name: string; baseUnit: "each" | "kg" | "l"; onSave: (change: StockChangePayload) => void; onCancel: () => void;
}) {
  const [reason, setReason] = useState<StockChangeReason>("received");
  const [away, setAway] = useState(false);
  const [text, setText] = useState("");
  const [wrong, setWrong] = useState(false);
  const fixedAway = reason === "damaged" || reason === "expired";

  function save() {
    const change = buildStockChange(packId, reason, away, text, baseUnit);
    if (!change) return setWrong(true);
    setWrong(false);
    onSave(change);
  }

  return <View className="gap-3 rounded-card border border-border bg-bg p-3">
    <Text accessibilityRole="header" className="text-body font-semibold text-text">{words.changeFor(name)}</Text>
    <Text className="text-secondary text-muted">{words.reasonTitle}</Text>
    <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-2">
      {STOCK_CHANGE_REASONS.map((value) => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ selected: reason === value }} onPress={() => { setReason(value); setWrong(false); }}
        className={reason === value ? "rounded-button bg-primary px-3 py-2" : "rounded-button border border-border px-3 py-2"}>
        <Text className={reason === value ? "text-body font-semibold text-on-primary" : "text-body text-text"}>{words.reasons[value]}</Text>
      </Pressable>)}
    </View>
    {reason !== "counted" && !fixedAway && <View accessibilityRole="radiogroup" className="flex-row gap-2">
      {[false, true].map((value) => <Pressable key={String(value)} accessibilityRole="radio" accessibilityState={{ selected: away === value }} onPress={() => setAway(value)}
        className={away === value ? "rounded-button bg-primary px-3 py-2" : "rounded-button border border-border px-3 py-2"}>
        <Text className={away === value ? "text-body font-semibold text-on-primary" : "text-body text-text"}>{value ? words.takeAway : words.addTo}</Text>
      </Pressable>)}
    </View>}
    <TextInput accessibilityLabel={`${words.amountLabel(reason, baseUnit)} ${name}`} keyboardType="decimal-pad" value={text} onChangeText={(value) => { setText(value); setWrong(false); }}
      onBlur={() => setText((current) => trimDecimal(current.trim()))} className="h-[52px] rounded-input border border-border bg-surface px-3 text-body text-text" />
    <Text className="text-secondary text-muted">{words.amountLabel(reason, baseUnit)}</Text>
    {wrong && <Text accessibilityLiveRegion="polite" className="text-secondary text-danger">{words.amountWrong}</Text>}
    <View className="flex-row gap-3">
      <Button label={words.saveChange} onPress={save} />
      <Button label={words.cancel} variant="secondary" onPress={onCancel} />
    </View>
  </View>;
}
