import { OpeningStockBody, type ShopListingCatalogItem } from "@ygo/contracts";
import { Button, Text } from "@ygo/mobile";
import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../api";
import { clearOpeningStock, pendingOpeningStock, queueOpeningStock } from "../lib/opening-stock-queue";
import { strings } from "../strings";

const words = strings.shopSetup;
type Load = { kind: "loading" } | { kind: "failed"; message: string } | { kind: "loaded"; shopId: string; items: ShopListingCatalogItem[] };

function clientId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    return (char === "x" ? value : (value & 3) | 8).toString(16);
  });
}

export default function OpeningStockScreen() {
  const insets = useSafeAreaInsets();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [message, setMessage] = useState<Record<string, string>>({});

  async function sync(shopId: string, packId: string) {
    const pending = pendingOpeningStock(shopId, packId);
    if (!pending) return false;
    const answer = await api.openingStock(packId, pending).catch(() => null);
    if (answer?.ok || answer?.code === "OPENING_STOCK_ALREADY_RECORDED") {
      clearOpeningStock(shopId, packId);
      return answer?.ok ?? false;
    }
    return false;
  }

  async function refresh() {
    setLoad({ kind: "loading" });
    const [application, listings] = await Promise.all([
      api.shopApplication().catch(() => null),
      api.shopListings().catch(() => null),
    ]);
    if (!application?.ok) {
      setLoad({ kind: "failed", message: application ? strings.errors[application.code] : words.loadFailed });
      return;
    }
    if (!application.data.application) {
      setLoad({ kind: "failed", message: words.loadFailed });
      return;
    }
    if (!listings?.ok) {
      setLoad({ kind: "failed", message: listings ? strings.errors[listings.code] : words.loadFailed });
      return;
    }
    const shopId = application.data.application.id;
    const items = listings.data.items.filter((item) => item.listing !== null);
    setLoad({ kind: "loaded", shopId, items });
    setQuantities(Object.fromEntries(items.map((item) => [item.packId, pendingOpeningStock(shopId, item.packId)?.quantity ?? ""])));
    const synced = await Promise.all(items.filter((item) => !item.openingStockRecorded).map((item) => sync(shopId, item.packId)));
    if (synced.some(Boolean)) {
      const updated = await api.shopListings().catch(() => null);
      if (updated?.ok) setLoad({ kind: "loaded", shopId, items: updated.data.items.filter((item) => item.listing !== null) });
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function save(item: ShopListingCatalogItem) {
    if (load.kind !== "loaded" || saving) return;
    const shopId = load.shopId;
    const queued = pendingOpeningStock(shopId, item.packId);
    const entry = OpeningStockBody.safeParse(queued ?? { quantity: quantities[item.packId], clientId: clientId() });
    if (!entry.success) {
      setMessage((current) => ({ ...current, [item.packId]: words.errors.quantity }));
      return;
    }
    queueOpeningStock(shopId, item.packId, entry.data);
    setSaving(item.packId);
    setMessage((current) => ({ ...current, [item.packId]: "" }));
    const answer = await api.openingStock(item.packId, entry.data).catch(() => null);
    setSaving(null);
    if (answer?.ok) {
      clearOpeningStock(shopId, item.packId);
      setLoad((current) => current.kind === "loaded" ? {
        ...current,
        items: current.items.map((row) => row.packId === item.packId
          ? { ...row, stock: answer.data.quantity, openingStockRecorded: true }
          : row),
      } : current);
      setMessage((current) => ({ ...current, [item.packId]: words.stockRecorded }));
      return;
    }
    if (answer?.code === "OPENING_STOCK_ALREADY_RECORDED") clearOpeningStock(shopId, item.packId);
    setMessage((current) => ({
      ...current,
      [item.packId]: answer ? strings.errors[answer.code] : words.saveOffline,
    }));
  }

  return (
    <ScrollView className="flex-1 bg-bg" contentContainerClassName="gap-4 px-4" contentContainerStyle={{ paddingTop: insets.top + 20, paddingBottom: insets.bottom + 28 }} keyboardShouldPersistTaps="handled">
      <Link href="/" asChild><Pressable accessibilityRole="button"><Text className="text-body font-semibold text-primary">‹ {words.back}</Text></Pressable></Link>
      <Text accessibilityRole="header" className="text-title-large font-semibold text-text">{words.stock}</Text>
      <Text className="text-body text-muted">{words.quantity}</Text>
      {load.kind === "loading" && <ActivityIndicator size="large" className="text-primary" />}
      {load.kind === "failed" && <><Text className="text-body text-danger">{load.message}</Text><Button label={words.retry} onPress={() => void refresh()} variant="secondary" /></>}
      {load.kind === "loaded" && load.items.length === 0 && <>
        <Text className="text-body text-muted">{words.noListings}</Text>
        <Link href="/listings" asChild><Pressable accessibilityRole="button" className="rounded-button border border-primary px-4 py-3"><Text className="text-body font-semibold text-primary">{words.listings}</Text></Pressable></Link>
      </>}
      {load.kind === "loaded" && load.items.map((item) => {
        const queued = pendingOpeningStock(load.shopId, item.packId);
        return <View key={item.packId} className="gap-3 rounded-card border border-border bg-surface p-4">
          <Text className="text-body font-semibold text-text">{item.name} · {item.packQuantity} {item.baseUnit}</Text>
          <Text className="text-secondary text-muted">{item.openingStockRecorded ? `${words.saved} ${item.stock} ${item.baseUnit}` : `${words.quantity}: ${item.baseUnit}`}</Text>
          {!item.openingStockRecorded && <>
          <TextInput accessibilityLabel={`${words.quantity} ${item.name}`} editable={!queued} keyboardType="decimal-pad" value={queued?.quantity ?? quantities[item.packId] ?? ""} onChangeText={(value) => setQuantities((current) => ({ ...current, [item.packId]: value }))} className="h-[52px] rounded-input border border-border bg-bg px-3 text-body text-text" />
            {queued && <Text className="text-secondary text-pending">{words.stockQueued}</Text>}
            {message[item.packId] && <Text accessibilityLiveRegion="polite" className={`text-secondary ${message[item.packId] === words.saveOffline ? "text-pending" : message[item.packId] === words.stockRecorded ? "text-success" : "text-danger"}`}>{message[item.packId]}</Text>}
            <Button label={words.saveStock} onPress={() => void save(item)} busy={saving === item.packId} />
          </>}
        </View>;
      })}
    </ScrollView>
  );
}
