import { invalidFields, SaveShopListingBody, type SaveShopListingBody as SaveBody, type ShopListingCatalogItem } from "@ygo/contracts";
import { formatMoney } from "@ygo/format";
import { Button, Text } from "@ygo/mobile";
import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Switch, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../api";
import { stockLine } from "../lib/stock-line";
import { strings } from "../strings";

const words = strings.shopSetup;
type Load = { kind: "loading" } | { kind: "failed"; message: string } | { kind: "loaded"; items: ShopListingCatalogItem[] };
type Form = {
  onlinePrice: string; counterPrice: string; mrp: string; lowStockLevel: string;
  available: boolean; minimumOrderQuantity: string; quantityStep: string;
  quantityOptions: { name: string; quantity: string; price: string }[];
};

const emptyForm: Form = { onlinePrice: "", counterPrice: "", mrp: "", lowStockLevel: "0", available: true, minimumOrderQuantity: "", quantityStep: "", quantityOptions: [] };

function formFor(item: ShopListingCatalogItem): Form {
  const listing = item.listing;
  return listing ? {
    onlinePrice: listing.onlinePrice, counterPrice: listing.counterPrice, mrp: listing.mrp,
    lowStockLevel: listing.lowStockLevel, available: listing.available,
    minimumOrderQuantity: listing.minimumOrderQuantity ?? "", quantityStep: listing.quantityStep ?? "",
    quantityOptions: listing.quantityOptions.map(({ name, quantity, price }) => ({ name, quantity, price })),
  } : emptyForm;
}

export default function ListingsScreen() {
  const insets = useSafeAreaInsets();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [selected, setSelected] = useState<ShopListingCatalogItem | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [search, setSearch] = useState("");
  const [wrong, setWrong] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function refresh() {
    setLoad({ kind: "loading" });
    const answer = await api.shopListings().catch(() => null);
    if (answer?.ok) setLoad({ kind: "loaded", items: answer.data.items });
    else setLoad({ kind: "failed", message: answer ? strings.errors[answer.code] : words.loadFailed });
  }

  useEffect(() => { void refresh(); }, []);

  function choose(item: ShopListingCatalogItem | null) {
    setSelected(item);
    setForm(item ? formFor(item) : emptyForm);
    setWrong([]);
    setMessage(null);
  }

  function edit(field: keyof Form, value: Form[keyof Form]) {
    setForm((current) => ({ ...current, [field]: value }));
    setWrong((current) => current.filter((name) => name !== field));
    setMessage(null);
  }

  async function save() {
    if (!selected || saving) return;
    const input: SaveBody = {
      onlinePrice: form.onlinePrice,
      counterPrice: form.counterPrice,
      mrp: form.mrp,
      lowStockLevel: form.lowStockLevel,
      available: form.available,
      minimumOrderQuantity: selected.classification === "measured" ? form.minimumOrderQuantity : null,
      quantityStep: selected.classification === "measured" ? form.quantityStep : null,
      quantityOptions: form.quantityOptions,
    };
    const checked = SaveShopListingBody.safeParse(input);
    if (!checked.success) {
      setWrong(invalidFields(checked.error));
      setMessage(words.invalid);
      return;
    }
    setSaving(true);
    setMessage(null);
    const answer = await api.saveShopListing(selected.packId, checked.data).catch(() => null);
    setSaving(false);
    if (!answer?.ok) {
      setMessage(answer ? strings.errors[answer.code] : words.loadFailed);
      return;
    }
    setLoad((current) => current.kind === "loaded"
      ? { kind: "loaded", items: current.items.map((item) => item.packId === selected.packId ? answer.data : item) }
      : current);
    setSelected(answer.data);
    setForm(formFor(answer.data));
    setMessage(words.saved);
  }

  const visible = load.kind === "loaded" ? load.items.filter((item) => `${item.name} ${item.brand ?? ""} ${item.barcode ?? ""}`.toLowerCase().includes(search.trim().toLowerCase())) : [];
  return (
    <ScrollView className="flex-1 bg-bg" contentContainerClassName="gap-4 px-4" contentContainerStyle={{ paddingTop: insets.top + 20, paddingBottom: insets.bottom + 28 }} keyboardShouldPersistTaps="handled">
      <Link href="/" asChild><Pressable accessibilityRole="button"><Text className="text-body font-semibold text-primary">‹ {words.back}</Text></Pressable></Link>
      <Text accessibilityRole="header" className="text-title-large font-semibold text-text">{words.listings}</Text>
      {load.kind === "loading" && <ActivityIndicator size="large" className="text-primary" />}
      {load.kind === "failed" && <><Text className="text-body text-danger">{load.message}</Text><Button label={words.retry} onPress={() => void refresh()} variant="secondary" /></>}
      {load.kind === "loaded" && !selected && <>
        <TextInput accessibilityLabel={words.search} placeholder={words.search} value={search} onChangeText={setSearch} className="h-[52px] rounded-input border border-border bg-surface px-3 text-body text-text" />
        {visible.length === 0 && <Text className="text-body text-muted">{search ? words.searchEmpty : words.noItems}</Text>}
        {visible.map((item) => <Pressable key={item.packId} onPress={() => choose(item)} className="gap-1 rounded-card border border-border bg-surface p-4">
          <Text className="text-body font-semibold text-text">{item.name}{item.brand ? ` · ${item.brand}` : ""}</Text>
          <Text className="text-secondary text-muted">{item.packQuantity} {item.baseUnit} {item.barcode ? `· ${item.barcode}` : ""}</Text>
          <Text className="text-secondary text-muted">{item.listing ? `${words.onlinePrice}: ${formatMoney(Number(item.listing.onlinePrice))}` : words.chooseProduct}</Text>
          {item.listing && <Text className="text-secondary text-muted">{stockLine(item.stock, item.held, item.baseUnit)}</Text>}
        </Pressable>)}
      </>}
      {load.kind === "loaded" && selected && <>
        <Pressable accessibilityRole="button" onPress={() => choose(null)}><Text className="text-body font-semibold text-primary">‹ {words.chooseProduct}</Text></Pressable>
        <Text className="text-body font-semibold text-text">{selected.name} · {selected.packQuantity} {selected.baseUnit}</Text>
        <Field label={words.onlinePrice} value={form.onlinePrice} onChange={(value) => edit("onlinePrice", value)} error={wrong.includes("onlinePrice")} />
        <Field label={words.counterPrice} value={form.counterPrice} onChange={(value) => edit("counterPrice", value)} error={wrong.includes("counterPrice")} />
        <Field label={words.mrp} value={form.mrp} onChange={(value) => edit("mrp", value)} error={wrong.includes("mrp")} />
        <Field label={words.lowStock} value={form.lowStockLevel} onChange={(value) => edit("lowStockLevel", value)} error={wrong.includes("lowStockLevel")} />
        {selected.classification === "measured" && <>
          <Field label={words.minimum} value={form.minimumOrderQuantity} onChange={(value) => edit("minimumOrderQuantity", value)} error={wrong.includes("minimumOrderQuantity")} />
          <Field label={words.step} value={form.quantityStep} onChange={(value) => edit("quantityStep", value)} error={wrong.includes("quantityStep")} />
        </>}
        <View className="flex-row items-center justify-between rounded-card bg-surface p-3">
          <Text className="flex-1 text-body text-text">{words.available}</Text>
          <Switch value={form.available} onValueChange={(value) => edit("available", value)} />
        </View>
        <View className="gap-3 rounded-card border border-border bg-surface p-4">
          <Text className="text-body font-semibold text-text">Quantity-price options</Text>
          {form.quantityOptions.map((option, index) => <View key={index} className="gap-2">
            <Field label={words.optionName} value={option.name} onChange={(name) => edit("quantityOptions", form.quantityOptions.map((current, at) => at === index ? { ...current, name } : current))} error={wrong.some((name) => name.startsWith("quantityOptions"))} keyboardType="default" />
            <Field label={words.optionQuantity} value={option.quantity} onChange={(quantity) => edit("quantityOptions", form.quantityOptions.map((current, at) => at === index ? { ...current, quantity } : current))} error={wrong.some((name) => name.startsWith("quantityOptions"))} />
            <Field label={words.optionPrice} value={option.price} onChange={(price) => edit("quantityOptions", form.quantityOptions.map((current, at) => at === index ? { ...current, price } : current))} error={wrong.some((name) => name.startsWith("quantityOptions"))} />
            <Pressable accessibilityRole="button" onPress={() => edit("quantityOptions", form.quantityOptions.filter((_, at) => at !== index))}><Text className="text-secondary text-danger">{words.removeOption}</Text></Pressable>
          </View>)}
          <Button label={words.addOption} onPress={() => edit("quantityOptions", [...form.quantityOptions, { name: "", quantity: "", price: "" }])} variant="secondary" />
        </View>
        {message && <Text accessibilityLiveRegion="polite" className={`text-secondary ${message === words.saved ? "text-success" : "text-danger"}`}>{message}</Text>}
        {wrong.map((field) => <Text key={field} className="text-secondary text-danger">{words.errors[field as keyof typeof words.errors] ?? words.invalid}</Text>)}
        <Button label={words.save} onPress={() => void save()} busy={saving} />
      </>}
      <Link href="/opening-stock" asChild><Pressable accessibilityRole="button" className="py-2"><Text className="text-body font-semibold text-primary">{words.stock}</Text></Pressable></Link>
    </ScrollView>
  );
}

function Field({ label, value, onChange, error = false, keyboardType = "decimal-pad" }: { label: string; value: string; onChange: (value: string) => void; error?: boolean; keyboardType?: "decimal-pad" | "default" }) {
  return <View className="gap-1">
    <Text className="text-secondary font-semibold text-text">{label}</Text>
    <TextInput accessibilityLabel={label} keyboardType={keyboardType} value={value} onChangeText={onChange} className={`h-[52px] rounded-input border bg-surface px-3 text-body text-text ${error ? "border-danger" : "border-border"}`} />
  </View>;
}
