import { OpeningStockBody, type ShopListingCatalogItem } from "@ygo/contracts";
import { Button, Text } from "@ygo/mobile";
import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../api";
import { clearOpeningStock, pendingOpeningStock, queueOpeningStock, refreshListingsAfterConflict, refreshListingsForQueuedConflicts, replaceListingsFromRefresh, syncQueuedOpeningStock } from "../lib/opening-stock-queue";
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
  const [editableQueued, setEditableQueued] = useState<Record<string, boolean>>({});
  const [stockRefreshFailed, setStockRefreshFailed] = useState<Record<string, boolean>>({});
  const [refreshingStock, setRefreshingStock] = useState<string | null>(null);

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
    const syncResults = await Promise.all(items.filter((item) => pendingOpeningStock(shopId, item.packId) !== null).map(async (item) => ({
      item,
      result: await syncQueuedOpeningStock(shopId, item.packId, (entry) => api.openingStock(item.packId, entry)),
    })));
    setEditableQueued((current) => ({
      ...current,
      ...Object.fromEntries(syncResults.filter(({ item, result }) => !item.openingStockRecorded && result.kind === "pending" && result.code === "VALIDATION_FAILED").map(({ item }) => [item.packId, true])),
    }));
    setMessage((current) => ({
      ...current,
      ...Object.fromEntries(syncResults.filter(({ result }) => result.kind === "pending").map(({ item, result }) => [
        item.packId,
        result.kind !== "pending" ? "" : result.code === "OPENING_STOCK_ALREADY_RECORDED" || item.openingStockRecorded
          ? `${words.stockConflict} ${pendingOpeningStock(shopId, item.packId)?.quantity ?? ""} ${item.baseUnit}.`
          : result.code ? strings.errors[result.code] : words.saveOffline,
      ])),
    }));
    const conflictItems = syncResults
      .filter(({ result }) => result.kind === "pending" && result.code === "OPENING_STOCK_ALREADY_RECORDED")
      .map(({ item }) => item);
    const conflictRefresh = await refreshListingsForQueuedConflicts(
      items,
      conflictItems,
      async () => {
        const updated = await api.shopListings().catch(() => null);
        return updated?.ok ? updated.data.items.filter((row) => row.listing !== null) : null;
      },
    );
    if (conflictRefresh.kind === "failed") {
      setStockRefreshFailed((current) => ({
        ...current,
        ...Object.fromEntries(conflictRefresh.packIds.map((packId) => [packId, true])),
      }));
      setMessage((current) => ({
        ...current,
        ...Object.fromEntries(conflictItems.map((item) => [
          item.packId,
          `${words.stockConflict} ${pendingOpeningStock(shopId, item.packId)?.quantity ?? ""} ${item.baseUnit}. ${words.stockStatusUnavailable}`,
        ])),
      }));
    } else if (conflictRefresh.kind === "refreshed") {
      setLoad((current) => current.kind === "loaded" && current.shopId === shopId
        ? { ...current, items: conflictRefresh.items }
        : current);
      setStockRefreshFailed((current) => ({
        ...current,
        ...Object.fromEntries(conflictRefresh.packIds.map((packId) => [packId, false])),
      }));
    }
    if (syncResults.some(({ result }) => result.kind === "synced")) {
      const updated = await api.shopListings().catch(() => null);
      if (updated?.ok) setLoad({ kind: "loaded", shopId, items: updated.data.items.filter((item) => item.listing !== null) });
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function retryStockRefresh(item: ShopListingCatalogItem, shopId: string) {
    if (refreshingStock) return;
    setRefreshingStock(item.packId);
    const result = await refreshListingsAfterConflict(
      load.kind === "loaded" ? load.items : [],
      async () => {
        const answer = await api.shopListings().catch(() => null);
        return answer?.ok ? answer.data.items.filter((row) => row.listing !== null) : null;
      },
    );
    setRefreshingStock(null);
    if (result.kind === "failed") return;
    setStockRefreshFailed((current) => ({ ...current, [item.packId]: false }));
    setMessage((current) => ({ ...current, [item.packId]: words.stockConflict + " " + (pendingOpeningStock(shopId, item.packId)?.quantity ?? "") + " " + item.baseUnit + "." }));
    setLoad((current) => current.kind === "loaded" && current.shopId === shopId
      ? { ...current, items: result.items }
      : current);
  }

  async function save(item: ShopListingCatalogItem) {
    if (load.kind !== "loaded" || saving) return;
    const shopId = load.shopId;
    const queued = pendingOpeningStock(shopId, item.packId);
    const entry = OpeningStockBody.safeParse(queued && !editableQueued[item.packId]
      ? queued
      : { quantity: quantities[item.packId] ?? queued?.quantity, clientId: queued?.clientId ?? clientId() });
    if (!entry.success) {
      setMessage((current) => ({ ...current, [item.packId]: words.errors.quantity }));
      return;
    }
    queueOpeningStock(shopId, item.packId, entry.data);
    setEditableQueued((current) => ({ ...current, [item.packId]: false }));
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
    if (answer?.code === "OPENING_STOCK_ALREADY_RECORDED") {
      setMessage((current) => ({ ...current, [item.packId]: `${words.stockConflict} ${entry.data.quantity} ${item.baseUnit}.` }));
      const updated = await api.shopListings().catch(() => null);
      if (updated?.ok) {
        const refreshedItems = updated.data.items.filter((row) => row.listing !== null);
        setLoad((current) => current.kind === "loaded" && current.shopId === shopId
          ? { ...current, items: replaceListingsFromRefresh(current.items, refreshedItems) }
          : current);
        setStockRefreshFailed((current) => ({ ...current, [item.packId]: false }));
      } else {
        setStockRefreshFailed((current) => ({ ...current, [item.packId]: true }));
        setMessage((current) => ({ ...current, [item.packId]: words.stockConflict + " " + entry.data.quantity + " " + item.baseUnit + ". " + words.stockStatusUnavailable }));
      }
      return;
    }
    if (answer?.code === "VALIDATION_FAILED") setEditableQueued((current) => ({ ...current, [item.packId]: true }));
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
          <TextInput accessibilityLabel={`${words.quantity} ${item.name}`} editable={!queued || editableQueued[item.packId]} keyboardType="decimal-pad" value={queued && !editableQueued[item.packId] ? queued.quantity : quantities[item.packId] ?? queued?.quantity ?? ""} onChangeText={(value) => setQuantities((current) => ({ ...current, [item.packId]: value }))} className="h-[52px] rounded-input border border-border bg-bg px-3 text-body text-text" />
            {queued && (!message[item.packId] || message[item.packId] === words.saveOffline) && <Text className="text-secondary text-pending">{words.stockQueued}</Text>}
            <Button label={words.saveStock} onPress={() => void save(item)} busy={saving === item.packId} />
          </>}
          {message[item.packId] && <Text accessibilityLiveRegion="polite" className={`text-secondary ${message[item.packId] === words.saveOffline ? "text-pending" : message[item.packId] === words.stockRecorded ? "text-success" : "text-danger"}`}>{message[item.packId]}</Text>}
          {stockRefreshFailed[item.packId] && <Button label={words.retry} onPress={() => void retryStockRefresh(item, load.shopId)} busy={refreshingStock === item.packId} variant="secondary" />}
        </View>;
      })}
    </ScrollView>
  );
}
