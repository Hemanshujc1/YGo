import { ErrorCode, OpeningStockBody, type ShopListingCatalogItem, SyncActionCode } from "@ygo/contracts";
import { trimDecimal } from "@ygo/format";
import { Button, SupportEmail, Text } from "@ygo/mobile";
import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { accountEpoch, api, session, supportEmail } from "../api";
import { type OpeningStockQueue, refreshListingsAfterConflict, refreshListingsForQueuedConflicts, replaceListingsFromRefresh } from "../lib/opening-stock-queue";
import { stockSync } from "../lib/stock-sync";
import { SyncStatus } from "../components/sync-status";
import { strings } from "../strings";
import { legacyOpeningStock, openOpeningStock } from "../lib/opening-stock-database";
import { stockLine } from "../lib/stock-line";

import { isCurrentAccount } from "../lib/account";

const words = strings.shopSetup;
type Load = { kind: "loading" } | { kind: "failed"; message: string } | { kind: "loaded"; shopId: string; queue: OpeningStockQueue; items: ShopListingCatalogItem[]; epoch: number; accountId: string };


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
  const [correcting, setCorrecting] = useState<Record<string, boolean>>({});
  const [editableQueued, setEditableQueued] = useState<Record<string, boolean>>({});
  const [stockRefreshFailed, setStockRefreshFailed] = useState<Record<string, boolean>>({});
  const [refreshingStock, setRefreshingStock] = useState<string | null>(null);

  async function refresh() {
    setLoad({ kind: "loading" });
    const identity = session.get();
    if (!("account" in identity)) return;
    const epoch = accountEpoch();
    const [application, listings] = await Promise.all([
      api.shopApplication().catch(() => null),
      api.shopListings().catch(() => null),
    ]);
    if (!isCurrentAccount(identity.account.id, epoch)) return;
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
      if (!isCurrentAccount(identity.account.id, epoch)) return;
      queue.importLegacy(shopId, legacyOpeningStock);
    } catch {
      if (!isCurrentAccount(identity.account.id, epoch)) return;
      setLoad({ kind: "failed", message: words.storageFailed });
      return;
    }
    const items = listings.data.items.filter((item) => item.listing !== null);
    setLoad({ kind: "loaded", accountId: identity.account.id, epoch, shopId, queue, items });
    setQuantities(Object.fromEntries(items.map((item) => [item.packId, trimDecimal(queue.pending(shopId, item.packId)?.quantity ?? "")])));
    const pendingBefore = new Map(items.map((item) => [item.packId, queue.pending(shopId, item.packId)]));
    const response = await stockSync.run();
    if (!isCurrentAccount(identity.account.id, epoch)) return;
    const syncResults = items.filter((item) => pendingBefore.get(item.packId)).map((item) => {
      const result = response?.results.find((row) => row.actionId === pendingBefore.get(item.packId)?.clientId);
      const failed = queue.failed(shopId, item.packId);
      return { item, result: result?.status === "applied" ? { kind: "synced" as const }
        : { kind: "pending" as const, code: ErrorCode.safeParse(failed?.code ?? result?.code).success ? (failed?.code ?? result?.code) as ErrorCode : null } };
    });
    if (!isCurrentAccount(identity.account.id, epoch)) return;
    setEditableQueued((current) => ({
      ...current,
      ...Object.fromEntries(syncResults.filter(({ item, result }) => !item.openingStockRecorded && result.kind === "pending" && result.code === "VALIDATION_FAILED").map(({ item }) => [item.packId, true])),
    }));
    setMessage((current) => ({
      ...current,
      ...Object.fromEntries(syncResults.filter(({ result }) => result.kind === "pending").map(({ item, result }) => [
        item.packId,
        result.kind !== "pending" ? "" : result.code === "OPENING_STOCK_ALREADY_RECORDED" || item.openingStockRecorded
          ? `${words.stockConflict} ${trimDecimal(queue.pending(shopId, item.packId)?.quantity ?? "")} ${item.baseUnit}.`
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
    if (!isCurrentAccount(identity.account.id, epoch)) return;
    if (conflictRefresh.kind === "failed") {
      setStockRefreshFailed((current) => ({
        ...current,
        ...Object.fromEntries(conflictRefresh.packIds.map((packId) => [packId, true])),
      }));
      setMessage((current) => ({
        ...current,
        ...Object.fromEntries(conflictItems.map((item) => [
          item.packId,
          `${words.stockConflict} ${trimDecimal(queue.pending(shopId, item.packId)?.quantity ?? "")} ${item.baseUnit}. ${words.stockStatusUnavailable}`,
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
    // Corrections the pass applied are fetched by the sync listener below.
    if (syncResults.some(({ result }) => result.kind === "synced")) {
      const updated = await api.shopListings().catch(() => null);
      if (!isCurrentAccount(identity.account.id, epoch)) return;
      if (updated?.ok) setLoad({ kind: "loaded", accountId: identity.account.id, epoch, shopId, queue, items: updated.data.items.filter((item) => item.listing !== null) });
    }
  }

  useEffect(() => { void refresh(); }, []);

  // Passes the loop runs on its own redraw this screen too (#460). Once a pack's latest correction stops
  // waiting, its totals and the Correct pre-fill come from the server again: a failed fetch tries again
  // after the next pass, and only the latest fetch is kept.
  const loaded = load.kind === "loaded" ? load : null;
  useEffect(() => {
    if (!loaded) return;
    const { queue, shopId, accountId, epoch } = loaded;
    const key = (row: { id: string; status: string }) => `${row.id}:${row.status}`;
    let before: Set<string>, stale = false, asked = 0;
    try { before = new Set(Object.values(queue.corrections(shopId)).map(key)); } catch { return; }
    return stockSync.subscribe(() => {
      if (stockSync.get().running || !isCurrentAccount(accountId, epoch)) return;
      let now: ReturnType<OpeningStockQueue["corrections"]>;
      try { now = queue.corrections(shopId); } catch { return; }
      const changed = Object.values(now).filter((row) => !before.has(key(row)));
      before = new Set(Object.values(now).map(key));
      if (changed.length) setLoad((current) => current.kind === "loaded" ? { ...current } : current);
      stale ||= changed.some((row) => row.status !== "pending");
      if (!stale) return;
      const ticket = ++asked;
      void api.shopListings().catch(() => null).then((updated) => {
        if (ticket !== asked || !updated?.ok || !isCurrentAccount(accountId, epoch)) return;
        stale = false;
        const refreshed = updated.data.items.filter((row) => row.listing !== null);
        setLoad((current) => current.kind === "loaded" && current.shopId === shopId ? { ...current, items: replaceListingsFromRefresh(current.items, refreshed) } : current);
      });
    });
  }, [loaded?.queue, loaded?.shopId, loaded?.accountId, loaded?.epoch]);

  async function retryStockRefresh(item: ShopListingCatalogItem, shopId: string) {
    if (refreshingStock || load.kind !== "loaded") return;
    const accountId = load.accountId, epoch = load.epoch;
    if (!isCurrentAccount(accountId, epoch)) return;
    const queue = load.queue;
    setRefreshingStock(item.packId);
    const result = await refreshListingsAfterConflict(
      load.kind === "loaded" ? load.items : [],
      async () => {
        const answer = await api.shopListings().catch(() => null);
        return answer?.ok ? answer.data.items.filter((row) => row.listing !== null) : null;
      },
    );
    if (!isCurrentAccount(accountId, epoch)) return;
    setRefreshingStock(null);
    if (result.kind === "failed") return;
    setStockRefreshFailed((current) => ({ ...current, [item.packId]: false }));
    setMessage((current) => ({ ...current, [item.packId]: words.stockConflict + " " + trimDecimal(queue.pending(shopId, item.packId)?.quantity ?? "") + " " + item.baseUnit + "." }));
    setLoad((current) => current.kind === "loaded" && current.shopId === shopId
      ? { ...current, items: result.items }
      : current);
  }

  // A recorded count is corrected by queueing one more action (#452); the server works out the difference.
  async function saveCorrection(item: ShopListingCatalogItem) {
    if (load.kind !== "loaded" || saving) return;
    const { shopId, queue, accountId, epoch } = load;
    if (!isCurrentAccount(accountId, epoch)) return;
    const entry = OpeningStockBody.safeParse({ quantity: quantities[item.packId], clientId: clientId() });
    if (!entry.success) {
      setMessage((current) => ({ ...current, [item.packId]: words.errors.quantity }));
      return;
    }
    let queued: ReturnType<OpeningStockQueue["saveCorrection"]>;
    try { queued = queue.saveCorrection(shopId, item.packId, entry.data.quantity); } catch {
      setMessage((current) => ({ ...current, [item.packId]: words.storageFailed }));
      return;
    }
    if (typeof queued === "string") {
      setMessage((current) => ({ ...current, [item.packId]: strings.stock[queued] }));
      return;
    }
    setCorrecting((current) => ({ ...current, [item.packId]: false }));
    setSaving(item.packId);
    setMessage((current) => ({ ...current, [item.packId]: "" }));
    const response = await stockSync.run();
    if (!isCurrentAccount(accountId, epoch)) return;
    setSaving(null);
    // The sync listener fetches the new totals; a refusal shows from the queue on the card.
    const result = response?.results.find((row) => row.actionId === queued.id);
    setMessage((current) => ({
      ...current,
      [item.packId]: result?.status === "applied" ? words.correctionRecorded : result?.status === "rejected" ? "" : words.saveOffline,
    }));
  }

  async function save(item: ShopListingCatalogItem) {
    if (load.kind !== "loaded" || saving) return;
    const shopId = load.shopId;
    const accountId = load.accountId, epoch = load.epoch;
    if (!isCurrentAccount(accountId, epoch)) return;
    const queue = load.queue;
    const queued = queue.pending(shopId, item.packId);
    const entry = OpeningStockBody.safeParse(queued && !queue.failed(shopId, item.packId) && !editableQueued[item.packId]
      ? queued
      : { quantity: quantities[item.packId] ?? queued?.quantity, clientId: queued && !queue.failed(shopId, item.packId) ? queued.clientId : clientId() });
    if (!entry.success) {
      setMessage((current) => ({ ...current, [item.packId]: words.errors.quantity }));
      return;
    }
    try {
      const blocked = queue.save(shopId, item.packId, entry.data);
      if (blocked) {
        setMessage((current) => ({ ...current, [item.packId]: strings.stock[blocked] }));
        return;
      }
    } catch {
      setMessage((current) => ({ ...current, [item.packId]: words.storageFailed }));
      return;
    }
    setEditableQueued((current) => ({ ...current, [item.packId]: false }));
    setSaving(item.packId);
    setMessage((current) => ({ ...current, [item.packId]: "" }));
    const response = await stockSync.run();
    if (!isCurrentAccount(accountId, epoch)) return;
    setSaving(null);
    const result = response?.results.find((row) => row.actionId === entry.data.clientId);
    const code = ErrorCode.safeParse(result?.code);
    const answer = result?.status === "applied" && result.result ? { ok: true as const, data: result.result }
      : result?.status === "rejected" && code.success ? { ok: false as const, code: code.data } : null;
    const applied = new Map(response?.results.flatMap((row) => row.status === "applied" && row.result && "quantity" in row.result ? [[row.result.listingId, row.result] as const] : []));
    if (applied.size > 0) {
      // Only a first count is what's left, since nothing sold before it. A correction in the same batch
      // answers with the opening total, so the sync listener fetches that pack instead (#460).
      setLoad((current) => current.kind === "loaded" ? {
        ...current,
        items: current.items.map((row) => {
          const saved = !row.openingStockRecorded && row.listing && applied.get(row.listing.id);
          return saved ? { ...row, stock: saved.quantity, openingStockRecorded: true } : row;
        }),
      } : current);
      setMessage((current) => ({ ...current, ...Object.fromEntries(load.items
        .filter((row) => !row.openingStockRecorded && row.listing && applied.has(row.listing.id)).map((row) => [row.packId, words.stockRecorded])) }));
    }
    if (answer?.ok) return;
    if (answer?.code === "OPENING_STOCK_ALREADY_RECORDED") {
      setMessage((current) => ({ ...current, [item.packId]: `${words.stockConflict} ${trimDecimal(entry.data.quantity)} ${item.baseUnit}.` }));
      const updated = await api.shopListings().catch(() => null);
      if (!isCurrentAccount(accountId, epoch)) return;
      if (updated?.ok) {
        const refreshedItems = updated.data.items.filter((row) => row.listing !== null);
        setLoad((current) => current.kind === "loaded" && current.shopId === shopId
          ? { ...current, items: replaceListingsFromRefresh(current.items, refreshedItems) }
          : current);
        setStockRefreshFailed((current) => ({ ...current, [item.packId]: false }));
      } else {
        setStockRefreshFailed((current) => ({ ...current, [item.packId]: true }));
        setMessage((current) => ({ ...current, [item.packId]: words.stockConflict + " " + trimDecimal(entry.data.quantity) + " " + item.baseUnit + ". " + words.stockStatusUnavailable }));
      }
      return;
    }
    if (answer?.code === "VALIDATION_FAILED") setEditableQueued((current) => ({ ...current, [item.packId]: true }));
    setMessage((current) => ({
      ...current,
      [item.packId]: result?.status === "rejected" ? (answer ? strings.errors[answer.code] : words.syncAttention) : words.saveOffline,
    }));
  }

  function recover(sourcePack: string, targetPack: string, quantity: string, chosen: OpeningStockBody | null): string | null {
    if (load.kind !== "loaded" || !isCurrentAccount(load.accountId, load.epoch)) return words.storageFailed;
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
      {load.kind === "loaded" && <SyncStatus />}
      <Text className="text-body text-muted">{words.quantity}</Text>
      {load.kind === "loading" && <ActivityIndicator size="large" className="text-primary" />}
      {load.kind === "failed" && <><Text className="text-body text-danger">{load.message}</Text><Button label={words.retry} onPress={() => void refresh()} variant="secondary" /><SupportEmail address={supportEmail} className="text-secondary" /></>}
      {load.kind === "loaded" && load.queue.heldPacks(load.shopId).map((packId) => <OpeningStockRecovery key={packId} shopId={load.shopId} packId={packId} queue={load.queue} items={load.items} onRecover={(target, quantity, chosen) => recover(packId, target, quantity, chosen)} />)}
      {load.kind === "loaded" && load.items.length === 0 && <>
        <Text className="text-body text-muted">{words.noListings}</Text>
        <Link href="/listings" asChild><Pressable accessibilityRole="button" className="rounded-button border border-primary px-4 py-3"><Text className="text-body font-semibold text-primary">{words.listings}</Text></Pressable></Link>
      </>}
      {load.kind === "loaded" && (() => { const corrections = load.queue.corrections(load.shopId); return load.items.map((item) => {
        const queued = load.queue.pending(load.shopId, item.packId);
        const correction = corrections[item.packId];
        const failure = load.queue.failed(load.shopId, item.packId);
        return <View key={item.packId} className="gap-3 rounded-card border border-border bg-surface p-4">
          <Text className="text-body font-semibold text-text">{item.name} · {trimDecimal(item.packQuantity)} {item.baseUnit}</Text>
          <Text className="text-secondary text-muted">{item.openingStockRecorded ? `${words.saved} ${stockLine(item.stock, item.held, item.baseUnit)}` : `${words.quantity}: ${item.baseUnit}`}</Text>
          {!item.openingStockRecorded && <>
          <TextInput accessibilityLabel={`${words.quantity} ${item.name}`} editable={!queued || !!failure || editableQueued[item.packId]} keyboardType="decimal-pad" value={queued && !failure && !editableQueued[item.packId] ? trimDecimal(queued.quantity) : quantities[item.packId] ?? trimDecimal(queued?.quantity ?? "")} onChangeText={(value) => setQuantities((current) => ({ ...current, [item.packId]: value }))} onBlur={() => setQuantities((current) => ({ ...current, [item.packId]: trimDecimal(current[item.packId] ?? "") }))} className="h-[52px] rounded-input border border-border bg-bg px-3 text-body text-text" />
            {queued && (!message[item.packId] || message[item.packId] === words.saveOffline) && <Text className="text-secondary text-pending">{words.stockQueued}</Text>}
            <Button label={words.saveStock} onPress={() => void save(item)} busy={saving === item.packId} disabled={load.queue.heldPacks(load.shopId).includes(item.packId)} />
          </>}
          {item.openingStockRecorded && (correcting[item.packId] ? <>
            <TextInput accessibilityLabel={`${words.correctionQuantity} ${item.name}`} keyboardType="decimal-pad" value={quantities[item.packId] ?? ""}
              onChangeText={(value) => setQuantities((current) => ({ ...current, [item.packId]: value }))}
              onBlur={() => setQuantities((current) => ({ ...current, [item.packId]: trimDecimal(current[item.packId] ?? "") }))}
              className="h-[52px] rounded-input border border-border bg-bg px-3 text-body text-text" />
            <Button label={words.saveCorrection} onPress={() => void saveCorrection(item)} busy={saving === item.packId} />
            <Button label={words.cancelCorrection} variant="secondary" onPress={() => setCorrecting((current) => ({ ...current, [item.packId]: false }))} />
          </> : <Button label={words.correct} variant="secondary" onPress={() => {
            setQuantities((current) => ({ ...current, [item.packId]: trimDecimal(correction?.status === "pending" ? correction.quantity : item.openingStock) }));
            setCorrecting((current) => ({ ...current, [item.packId]: true }));
          }} />)}
          {correction?.status === "pending" && <Text className="text-secondary text-pending">{words.correctionQueued(trimDecimal(correction.quantity), item.baseUnit)}</Text>}
          {correction?.status === "rejected" && <>
            <Text className="text-secondary text-danger">{words.correctionFailed(trimDecimal(correction.quantity), item.baseUnit, strings.sync.reasons[SyncActionCode.safeParse(correction.code).data ?? "VALIDATION_FAILED"])}</Text>
            <Text selectable className="text-secondary text-muted">{strings.sync.reference(correction.id)}</Text>
            <SupportEmail address={supportEmail} className="text-secondary" />
          </>}
          {failure && <><Text className="text-secondary text-danger">{words.syncAttention}</Text><Text selectable className="text-secondary text-muted">{queued?.clientId}</Text><SupportEmail address={supportEmail} className="text-secondary" /></>}
          {message[item.packId] && <Text accessibilityLiveRegion="polite" className={`text-secondary ${message[item.packId] === words.saveOffline ? "text-pending" : message[item.packId] === words.stockRecorded || message[item.packId] === words.correctionRecorded ? "text-success" : "text-danger"}`}>{message[item.packId]}</Text>}
          {stockRefreshFailed[item.packId] && <Button label={words.retry} onPress={() => void retryStockRefresh(item, load.shopId)} busy={refreshingStock === item.packId} variant="secondary" />}
        </View>;
      }); })()}
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
    <TextInput accessibilityLabel={words.quantity} value={quantity} keyboardType="decimal-pad" onChangeText={(value) => { setQuantity(value); setChosen(null); }} onBlur={() => setQuantity(trimDecimal(quantity))} className="h-[52px] rounded-input border border-border bg-bg px-3 text-body text-text" />
    <Button label={words.save} disabled={!target} onPress={() => setError(onRecover(target, quantity, chosen))} />
    {error && <Text accessibilityLiveRegion="polite" className="text-secondary text-danger">{error}</Text>}
    <Text className="text-secondary text-muted">{words.support}</Text>
    <SupportEmail address={supportEmail} className="text-secondary" />
  </View>;
}
