import { StockFlagPayload, type StockChangePayload } from "@ygo/contracts";
import { trimDecimal } from "@ygo/format";
import { Button, SupportEmail, Text } from "@ygo/mobile";
import { Cloud } from "../components/icons";
import { Link, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { access, accountEpoch, session, supportEmail } from "../api";
import { StockChangeForm } from "../components/stock-change-form";
import { SyncStatus } from "../components/sync-status";
import { Toggle } from "../components/toggle";
import { isCurrentAccount } from "../lib/account";
import { stockLine } from "../lib/stock-line";
import { openOpeningStock } from "../lib/opening-stock-database";
import type { OpeningStockQueue } from "../lib/opening-stock-queue";
import { stockSync } from "../lib/stock-sync";
import { strings } from "../strings";

const words = strings.stock;
type CachedStock = NonNullable<ReturnType<OpeningStockQueue["cache"]["read"]>>;
type Loaded = { kind: "loaded"; accountId: string; epoch: number; stock: CachedStock; queue: OpeningStockQueue };
type Load = { kind: "loading" } | { kind: "failed"; message: string } | Loaded;

/** Nothing left to sell, or switched off: the Stock list says "Out of stock" in words (S11). */
const isOut = (item: CachedStock["items"][number]) => item.outOfStock || Number(item.quantity) <= 0;
const isRunningLow = (item: CachedStock["items"][number]) => !isOut(item) && item.lowStock === true;

export default function StockScreen() {
  const insets = useSafeAreaInsets();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [message, setMessage] = useState<string | null>(null);
  const [, redraw] = useState(0);
  const [pulling, setPulling] = useState(false);
  /** The pack whose change form is open, and whether only low stock shows (S11, #67). */
  const [changing, setChanging] = useState<string | null>(null);
  const [lowOnly, setLowOnly] = useState(false);
  const visit = useRef(0);

  const shown = useRef<Loaded | null>(null);
  shown.current = load.kind === "loaded" ? load : null;

  // The one sync loop sends and pulls; this screen only re-reads what it stored.
  function reread(current: Loaded) {
    if (!isCurrentAccount(current.accountId, current.epoch) || !access.allowed(current.accountId, current.stock.shopId)) return;
    const stock = current.queue.cache.read(current.stock.shopId);
    if (stock) setLoad({ ...current, stock });
    setMessage(stockSync.get().outcome === "done" ? null : words.refreshFailed);
    redraw((value) => value + 1);
  }

  // The redraw comes from the loop's subscription below.
  function sync(manual = false) { void (manual ? stockSync.retryNow() : stockSync.run()); }

  // Pulling the list down is the manual sync; the spinner stays until the pass ends.
  async function pull() {
    if (pulling) return;
    setPulling(true);
    try { await stockSync.retryNow(); } finally { setPulling(false); }
  }

  async function refresh(token: number) {
    const identity = session.get();
    if (!("account" in identity)) return;
    const epoch = accountEpoch();
    try {
      await access.verify(identity.account);
      if (!isCurrentAccount(identity.account.id, epoch) || visit.current !== token) return;
      const permission = access.get();
      if (!permission.shopId || !access.allowed(identity.account.id, permission.shopId)) return setLoad({ kind: "failed", message: strings.offlineAccess.expired });
      const queue = await openOpeningStock(identity.account.id);
      if (!isCurrentAccount(identity.account.id, epoch) || visit.current !== token) return;
      const current = load.kind === "loaded" && load.accountId === identity.account.id ? load : null;
      if (current) { sync(); return; }
      const cached = queue.cache.read(permission.shopId);
      if (cached) {
        const loaded: Loaded = { kind: "loaded", accountId: identity.account.id, epoch, stock: cached, queue };
        setLoad(loaded);
        if (permission.mode === "offline") setMessage(words.refreshFailed);
        sync();
        return;
      }
      setLoad({ kind: "loading" });
      await stockSync.run();
      if (!isCurrentAccount(identity.account.id, epoch) || visit.current !== token || !access.allowed(identity.account.id, permission.shopId)) return;
      const stock = queue.cache.read(permission.shopId);
      const code = stockSync.get().code;
      if (!stock) return setLoad({ kind: "failed", message: code ? strings.errors[code] : words.loadFailed });
      setLoad({ kind: "loaded", accountId: identity.account.id, epoch, stock, queue });
    } catch {
      if (isCurrentAccount(identity.account.id, epoch) && visit.current === token) setLoad({ kind: "failed", message: words.storageFailed });
    }
  }

  useFocusEffect(useCallback(() => {
    const token = ++visit.current;
    void refresh(token);
    // Passes the loop starts on its own (every 30 s, retries) redraw too.
    const unsubscribe = stockSync.subscribe(() => {
      if (stockSync.get().running || !shown.current || visit.current !== token) return;
      try { reread(shown.current); } catch { setMessage(words.storageFailed); }
    });
    return () => { ++visit.current; unsubscribe(); };
  }, []));

  function save(current: Loaded, packId: string, outOfStock: boolean) {
    if (!isCurrentAccount(current.accountId, current.epoch) || !access.allowed(current.accountId, current.stock.shopId)) { access.expire(); return; }
    try {
      const blocked = current.queue.saveFlag(current.stock.shopId, packId, outOfStock);
      if (blocked) return setMessage(words[blocked]);
      setMessage(null);
      redraw((value) => value + 1);
      sync();
    } catch { setMessage(words.storageFailed); }
  }

  function saveChange(current: Loaded, change: StockChangePayload) {
    if (!isCurrentAccount(current.accountId, current.epoch) || !access.allowed(current.accountId, current.stock.shopId)) { access.expire(); return; }
    try {
      const stop = current.queue.saveChange(current.stock.shopId, change);
      if (stop) return setMessage(words[stop]);
      setMessage(null);
      setChanging(null);
      redraw((value) => value + 1);
      sync();
    } catch { setMessage(words.storageFailed); }
  }

  return (
    <ScrollView className="flex-1 bg-bg" contentContainerClassName="gap-4 px-4" contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 32 }}
      refreshControl={load.kind === "loaded" ? <RefreshControl refreshing={pulling} onRefresh={() => void pull()} progressViewOffset={insets.top} /> : undefined}>
      {/* No tab bar yet (a shop that doesn't answer orders): Back to Home (#550). */}
      {!access.answersOrders() && <Link href="/" asChild><Pressable accessibilityRole="button" className="py-3"><Text className="text-body text-primary">{words.back}</Text></Pressable></Link>}
      <Text accessibilityRole="header" className="text-title-large font-semibold text-text">{words.title}</Text>
      {load.kind === "loading" && <ActivityIndicator className="text-primary" />}
      {load.kind === "failed" && <>
        <Text accessibilityLiveRegion="polite" className="text-body text-danger">{load.message}</Text>
        <Button label={words.retry} variant="secondary" onPress={() => void refresh(++visit.current)} />
        <SupportEmail address={supportEmail} className="text-secondary" />
      </>}
      {message && <View className="flex-row items-center gap-2">
        {message === words.refreshFailed && <Cloud size={20} className="text-pending" />}
        <Text accessibilityLiveRegion="polite" className={message === words.refreshFailed ? "flex-1 text-body text-pending" : "flex-1 text-body text-danger"}>{message}</Text>
      </View>}
      {load.kind === "loaded" && <>
        {load.stock.state === "suspended" && <Text className="text-body text-danger">{words.suspended}</Text>}
        <SyncStatus />
        {/* Offline too: a Live or Suspended shop bills at the counter from here (owner's answer 1 on #468). */}
        <Link href="/bill" asChild>
          <Pressable accessibilityRole="button" className="rounded-button bg-primary px-4 py-3">
            <Text className="text-body font-semibold text-on-primary">{strings.bill.open}</Text>
          </Pressable>
        </Link>
        {["retry", "halt"].includes(stockSync.get().outcome ?? "") && <Button label={words.retry} variant="secondary" onPress={() => sync(true)} />}
        {load.stock.items.length === 0 && <Text className="text-body text-muted">{words.empty}</Text>}
        {load.stock.items.length > 0 && <Button label={lowOnly ? words.showAll : words.lowOnly} variant="secondary" onPress={() => setLowOnly((value) => !value)} />}
        {lowOnly && !load.stock.items.some(isRunningLow) && <Text className="text-body text-muted">{words.noLow}</Text>}
        {load.stock.items.filter((item) => !lowOnly || isRunningLow(item)).map((item) => {
          const flag = load.queue.flag(load.stock.shopId, item.packId);
          const desired = flag && flag.status !== "applied" ? StockFlagPayload.parse(flag.action.payload).outOfStock : item.outOfStock;
          return <View key={item.packId} className="gap-2 rounded-card border border-border bg-surface p-4">
            <Text className="text-headline font-semibold text-text">{item.name} · {trimDecimal(item.packQuantity)} {item.baseUnit}</Text>
            <Text className="text-secondary text-muted">{stockLine(item.quantity, item.held, item.baseUnit)}</Text>
            {isOut(item) ? <Text className="text-secondary font-semibold text-danger">{words.out}</Text> : item.lowStock ? <Text className="text-secondary font-semibold text-pending">{words.low}</Text> : null}
            <View className="flex-row items-center justify-between gap-4">
              <Text className="text-body text-text">{words.outOfStock}</Text>
              {item.unavailable ? <Text className="text-body text-muted">{words.unavailable}</Text> : <Toggle on={desired} busy={false} label={`${item.name}: ${words.outOfStock}`} onPress={() => {
                const latest = load.queue.flag(load.stock.shopId, item.packId);
                const value = latest && latest.status !== "applied" ? StockFlagPayload.parse(latest.action.payload).outOfStock : desired;
                save(load, item.packId, !value);
              }} />}
            </View>
            <Text accessibilityLiveRegion="polite" className="text-secondary text-muted">{flag?.status === "pending" ? words.pending : flag?.status === "applied" ? words.saved : ""}</Text>
            {!item.unavailable && (changing === item.packId
              ? <StockChangeForm packId={item.packId} name={item.name} baseUnit={item.baseUnit} onSave={(change) => saveChange(load, change)} onCancel={() => setChanging(null)} />
              : <Button label={words.change} variant="secondary" onPress={() => setChanging(item.packId)} />)}
            {(() => {
              const lastChange = load.queue.change(load.stock.shopId, item.packId);
              if (lastChange?.status === "pending") return <Text accessibilityLiveRegion="polite" className="text-secondary text-muted">{words.changePending}</Text>;
              if (lastChange?.status === "rejected") return <>
                <Text selectable className="text-secondary text-danger">{words.changeFailed(lastChange.action.id)}</Text>
                <SupportEmail address={supportEmail} className="text-secondary" />
              </>;
              return null;
            })()}
            {flag?.status === "rejected" && !item.unavailable && <>
              <Text selectable className="text-secondary text-danger">{words.failed(flag.action.id)}</Text>
              <Text className="text-secondary text-muted">{words.corrected}</Text>
              <Button label={words.retry} variant="secondary" onPress={() => save(load, item.packId, desired)} />
              <SupportEmail address={supportEmail} className="text-secondary" />
            </>}
          </View>;
        })}
        {load.queue.cache.removedFailures(load.stock.shopId).map((id) => <View key={id} className="gap-2">
          <Text selectable className="text-secondary text-danger">{words.failed(id)}</Text>
          <SupportEmail address={supportEmail} className="text-secondary" />
        </View>)}
        <Link href="/opening-stock" asChild><Pressable accessibilityRole="button" className="py-3"><Text className="text-body text-primary">{words.opening}</Text></Pressable></Link>
      </>}
    </ScrollView>
  );
}
