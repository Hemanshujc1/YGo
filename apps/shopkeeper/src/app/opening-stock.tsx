import { OpeningStockBody, type ShopListingCatalogItem } from "@ygo/contracts";
import { trimDecimal } from "@ygo/format";
import { Button, SupportEmail, Text } from "@ygo/mobile";
import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, session, supportEmail } from "../api";
import { type OpeningStockQueue, refreshListingsAfterConflict, refreshListingsForQueuedConflicts, replaceListingsFromRefresh, syncQueuedOpeningStock } from "../lib/opening-stock-queue";
import { strings } from "../strings";
import { legacyOpeningStock, openOpeningStock } from "../lib/opening-stock-database";

const words = strings.shopSetup;
type Load = { kind: "loading" } | { kind: "failed"; message: string } | { kind: "loaded"; shopId: string; queue: OpeningStockQueue; items: ShopListingCatalogItem[]; accountId: string };

function isCurrentAccount(accountId: string): boolean {
  const current = session.get();
  return "account" in current && current.account.id === accountId;
}

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
    const identity = session.get();
    if (!("account" in identity)) return;
    const [application, listings] = await Promise.all([
      api.shopApplication().catch(() => null),
      api.shopListings().catch(() => null),
    ]);
    if (!isCurrentAccount(identity.account.id)) return;
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
    let queue: OpeningStockQueue;
    try {
      queue = await openOpeningStock(identity.account.id);
      if (!isCurrentAccount(identity.account.id)) return;
      queue.importLegacy(shopId, legacyOpeningStock);
    } catch {
      if (!isCurrentAccount(identity.account.id)) return;
      setLoad({ kind: "failed", message: words.storageFailed });
      return;
    }
    const items = listings.data.items.filter((item) => item.listing !== null);
    setLoad({ kind: "loaded", accountId: identity.account.id, shopId, queue, items });
    setQuantities(Object.fromEntries(items.map((item) => [item.packId, queue.pending(shopId, item.packId)?.quantity ?? ""])));
    const syncResults = await Promise.all(items.filter((item) => !queue.heldPacks(shopId).includes(item.packId) && queue.pending(shopId, item.packId) !== null).map(async (item) => ({
      item,
      result: await syncQueuedOpeningStock(queue, shopId, item.packId, (entry) => api.openingStock(item.packId, entry)).catch(() => ({ kind: "pending" as const, code: null })),
    })));
    if (!isCurrentAccount(identity.account.id)) return;
    setEditableQueued((current) => ({
      ...current,
      ...Object.fromEntries(syncResults.filter(({ item, result }) => !item.openingStockRecorded && result.kind === "pending" && result.code === "VALIDATION_FAILED").map(({ item }) => [item.packId, true])),
    }));
    setMessage((current) => ({
      ...current,
      ...Object.fromEntries(syncResults.filter(({ result }) => result.kind === "pending").map(({ item, result }) => [
        item.packId,
        result.kind !== "pending" ? "" : result.code === "OPENING_STOCK_ALREADY_RECORDED" || item.openingStockRecorded
          ? `${words.stockConflict} ${queue.pending(shopId, item.packId)?.quantity ?? ""} ${item.baseUnit}.`
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
    if (!isCurrentAccount(identity.account.id)) return;
    if (conflictRefresh.kind === "failed") {
      setStockRefreshFailed((current) => ({
        ...current,
        ...Object.fromEntries(conflictRefresh.packIds.map((packId) => [packId, true])),
      }));
      setMessage((current) => ({
        ...current,
        ...Object.fromEntries(conflictItems.map((item) => [
          item.packId,
          `${words.stockConflict} ${queue.pending(shopId, item.packId)?.quantity ?? ""} ${item.baseUnit}. ${words.stockStatusUnavailable}`,
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
      if (!isCurrentAccount(identity.account.id)) return;
      if (updated?.ok) setLoad({ kind: "loaded", accountId: identity.account.id, shopId, queue, items: updated.data.items.filter((item) => item.listing !== null) });
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function retryStockRefresh(item: ShopListingCatalogItem, shopId: string) {
    if (refreshingStock || load.kind !== "loaded") return;
    const accountId = load.accountId;
    if (!isCurrentAccount(accountId)) return;
    const queue = load.queue;
    setRefreshingStock(item.packId);
    const result = await refreshListingsAfterConflict(
      load.kind === "loaded" ? load.items : [],
      async () => {
        const answer = await api.shopListings().catch(() => null);
        return answer?.ok ? answer.data.items.filter((row) => row.listing !== null) : null;
      },
    );
    if (!isCurrentAccount(accountId)) return;
    setRefreshingStock(null);
    if (result.kind === "failed") return;
    setStockRefreshFailed((current) => ({ ...current, [item.packId]: false }));
    setMessage((current) => ({ ...current, [item.packId]: words.stockConflict + " " + (queue.pending(shopId, item.packId)?.quantity ?? "") + " " + item.baseUnit + "." }));
    setLoad((current) => current.kind === "loaded" && current.shopId === shopId
      ? { ...current, items: result.items }
      : current);
  }

  async function save(item: ShopListingCatalogItem) {
    if (load.kind !== "loaded" || saving) return;
    const shopId = load.shopId;
    const accountId = load.accountId;
    if (!isCurrentAccount(accountId)) return;
    const queue = load.queue;
    const queued = queue.pending(shopId, item.packId);
    const entry = OpeningStockBody.safeParse(queued && !editableQueued[item.packId]
      ? queued
      : { quantity: quantities[item.packId] ?? queued?.quantity, clientId: queued?.clientId ?? clientId() });
    if (!entry.success) {
      setMessage((current) => ({ ...current, [item.packId]: words.errors.quantity }));
      return;
    }
    try {
      queue.save(shopId, item.packId, entry.data);
    } catch {
      setMessage((current) => ({ ...current, [item.packId]: words.storageFailed }));
      return;
    }
    setEditableQueued((current) => ({ ...current, [item.packId]: false }));
    setSaving(item.packId);
    setMessage((current) => ({ ...current, [item.packId]: "" }));
    const answer = await api.openingStock(item.packId, entry.data).catch(() => null);
    if (!isCurrentAccount(accountId)) return;
    setSaving(null);
    if (answer?.ok) {
      try { queue.clear(shopId, item.packId, entry.data); } catch {
        setMessage((current) => ({ ...current, [item.packId]: words.storageFailed }));
        return;
      }
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
      if (!isCurrentAccount(accountId)) return;
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

  function recover(sourcePack: string, targetPack: string, quantity: string, chosen: OpeningStockBody | null): string | null {
    if (load.kind !== "loaded" || !isCurrentAccount(load.accountId)) return words.storageFailed;
    if (!load.items.some((item) => item.packId === targetPack && !item.openingStockRecorded)) return words.loadFailed;
    const entry = OpeningStockBody.safeParse(chosen ?? { quantity, clientId: clientId() });
    if (!entry.success) return words.errors.quantity;
    try { load.queue.recover(load.shopId, sourcePack, targetPack, entry.data); } catch { return words.storageFailed; }
    setQuantities((current) => ({ ...current, [targetPack]: entry.data.quantity }));
    setMessage((current) => ({ ...current, [targetPack]: words.stockQueued }));
    // The user retries explicitly after reviewing the recovered quantity.
    setLoad({ ...load });
    return null;
  }

  return (
    <ScrollView className="flex-1 bg-bg" contentContainerClassName="gap-4 px-4" contentContainerStyle={{ paddingTop: insets.top + 20, paddingBottom: insets.bottom + 28 }} keyboardShouldPersistTaps="handled">
      <Link href="/" asChild><Pressable accessibilityRole="button"><Text className="text-body font-semibold text-primary">‹ {words.back}</Text></Pressable></Link>
      <Text accessibilityRole="header" className="text-title-large font-semibold text-text">{words.stock}</Text>
      <Text className="text-body text-muted">{words.quantity}</Text>
      {load.kind === "loading" && <ActivityIndicator size="large" className="text-primary" />}
      {load.kind === "failed" && <><Text className="text-body text-danger">{load.message}</Text><Button label={words.retry} onPress={() => void refresh()} variant="secondary" /><SupportEmail address={supportEmail} className="text-secondary" /></>}
      {load.kind === "loaded" && load.queue.heldPacks(load.shopId).map((packId) => <OpeningStockRecovery key={packId} shopId={load.shopId} packId={packId} queue={load.queue} items={load.items} onRecover={(target, quantity, chosen) => recover(packId, target, quantity, chosen)} />)}
      {load.kind === "loaded" && load.items.length === 0 && <>
        <Text className="text-body text-muted">{words.noListings}</Text>
        <Link href="/listings" asChild><Pressable accessibilityRole="button" className="rounded-button border border-primary px-4 py-3"><Text className="text-body font-semibold text-primary">{words.listings}</Text></Pressable></Link>
      </>}
      {load.kind === "loaded" && load.items.map((item) => {
        const queued = load.queue.pending(load.shopId, item.packId);
        return <View key={item.packId} className="gap-3 rounded-card border border-border bg-surface p-4">
          <Text className="text-body font-semibold text-text">{item.name} · {item.packQuantity} {item.baseUnit}</Text>
          <Text className="text-secondary text-muted">{item.openingStockRecorded ? `${words.saved} ${item.stock} ${item.baseUnit}` : `${words.quantity}: ${item.baseUnit}`}</Text>
          {!item.openingStockRecorded && <>
          <TextInput accessibilityLabel={`${words.quantity} ${item.name}`} editable={!queued || editableQueued[item.packId]} keyboardType="decimal-pad" value={queued && !editableQueued[item.packId] ? queued.quantity : quantities[item.packId] ?? queued?.quantity ?? ""} onChangeText={(value) => setQuantities((current) => ({ ...current, [item.packId]: value }))} className="h-[52px] rounded-input border border-border bg-bg px-3 text-body text-text" />
            {queued && (!message[item.packId] || message[item.packId] === words.saveOffline) && <Text className="text-secondary text-pending">{words.stockQueued}</Text>}
            <Button label={words.saveStock} onPress={() => void save(item)} busy={saving === item.packId} disabled={load.queue.heldPacks(load.shopId).includes(item.packId)} />
          </>}
          {message[item.packId] && <Text accessibilityLiveRegion="polite" className={`text-secondary ${message[item.packId] === words.saveOffline ? "text-pending" : message[item.packId] === words.stockRecorded ? "text-success" : "text-danger"}`}>{message[item.packId]}</Text>}
          {stockRefreshFailed[item.packId] && <Button label={words.retry} onPress={() => void retryStockRefresh(item, load.shopId)} busy={refreshingStock === item.packId} variant="secondary" />}
        </View>;
      })}
    </ScrollView>
  );
}

function OpeningStockRecovery({ shopId, packId, queue, items, onRecover }: {
  shopId: string; packId: string; queue: OpeningStockQueue; items: ShopListingCatalogItem[];
  onRecover: (targetPack: string, quantity: string, chosen: OpeningStockBody | null) => string | null;
}) {
  const words = strings.shopSetup.recovery;
  const available = items.filter((item) => !item.openingStockRecorded);
  const [target, setTarget] = useState(available.some((item) => item.packId === packId) ? packId : "");
  const [quantity, setQuantity] = useState("");
  const [chosen, setChosen] = useState<OpeningStockBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  return <View className="gap-3 rounded-card border border-border bg-surface p-4">
    <Text accessibilityRole="header" className="text-headline font-semibold text-text">{words.title}</Text>
    <Text className="text-body text-muted">{words.body}</Text>
    <Text selectable className="text-secondary text-muted">{`opening:${shopId}:${packId}`}</Text>
    {queue.versions(shopId, packId).map(({ payload, entry }) => <View key={payload} className="gap-2">
      <Text selectable className="text-secondary text-text">{payload}</Text>
      {entry && target === packId && <Button label={words.use(trimDecimal(entry.quantity))} variant="secondary" onPress={() => { setQuantity(entry.quantity); setChosen(entry); }} />}
    </View>)}
    <Text className="text-body text-text">{words.product}</Text>
    {available.map((item) => <Button key={item.packId} label={`${target === item.packId ? "✓ " : ""}${item.name} · ${trimDecimal(item.packQuantity)} ${item.baseUnit}`} variant="secondary" onPress={() => { setTarget(item.packId); setChosen(null); }} />)}
    <Text className="text-body text-text">{words.quantity}</Text>
    <TextInput accessibilityLabel={words.quantity} value={quantity} keyboardType="decimal-pad" onChangeText={(value) => { setQuantity(value); setChosen(null); }} className="h-[52px] rounded-input border border-border bg-bg px-3 text-body text-text" />
    <Button label={words.save} disabled={!target} onPress={() => setError(onRecover(target, quantity, chosen))} />
    {error && <Text accessibilityLiveRegion="polite" className="text-secondary text-danger">{error}</Text>}
    <Text className="text-secondary text-muted">{words.support}</Text>
    <SupportEmail address={supportEmail} className="text-secondary" />
  </View>;
}
