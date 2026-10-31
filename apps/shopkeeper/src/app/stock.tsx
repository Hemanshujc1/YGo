import { StockFlagPayload } from "@ygo/contracts";
import { trimDecimal } from "@ygo/format";
import { Button, SupportEmail, Text } from "@ygo/mobile";
import { Cloud } from "../components/icons";
import { Link, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { access, accountEpoch, api, session, supportEmail } from "../api";
import { Toggle } from "../components/toggle";
import { isCurrentAccount } from "../lib/account";
import { stockLine } from "../lib/stock-line";
import { legacyOpeningStock, openOpeningStock } from "../lib/opening-stock-database";
import { type OpeningStockQueue, syncOpeningStockBatch } from "../lib/opening-stock-queue";
import { strings } from "../strings";

const words = strings.stock;
type CachedStock = NonNullable<ReturnType<OpeningStockQueue["cache"]["read"]>>;
type Loaded = { kind: "loaded"; accountId: string; epoch: number; stock: CachedStock; queue: OpeningStockQueue };
type Load = { kind: "loading" } | { kind: "failed"; message: string } | Loaded;

export default function StockScreen() {
  const insets = useSafeAreaInsets();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [message, setMessage] = useState<string | null>(null);
  const [, redraw] = useState(0);
  const visit = useRef(0);

  async function pull(current: Loaded, token: number) {
    const since = current.queue.cache.cursor(current.stock.shopId);
    const answer = await api.syncChanges(since).catch(() => null);
    if (!isCurrentAccount(current.accountId, current.epoch) || visit.current !== token || !access.allowed(current.accountId, current.stock.shopId)) return;
    if (!answer?.ok) { setMessage(words.refreshFailed); return; }
    if (answer.data.shopId !== current.stock.shopId) return;
    current.queue.cache.apply(answer.data, since);
    const stock = current.queue.cache.read(current.stock.shopId);
    if (stock) setLoad({ ...current, stock });
    setMessage(null);
  }

  async function sync(current: Loaded, token = visit.current) {
    try {
      const identity = session.get();
      if (!("account" in identity)) return;
      await access.verify(identity.account);
      if (!isCurrentAccount(current.accountId, current.epoch) || !access.allowed(current.accountId, current.stock.shopId)) return;
      const since = current.queue.cache.cursor(current.stock.shopId);
      const response = await syncOpeningStockBatch(current.queue, current.stock.shopId, (body) => api.syncActions(body), () => isCurrentAccount(current.accountId, current.epoch) && access.allowed(current.accountId, current.stock.shopId));
      if (!isCurrentAccount(current.accountId, current.epoch) || visit.current !== token || !access.allowed(current.accountId, current.stock.shopId)) return;
      if (response) current.queue.cache.confirmFlags(current.stock.shopId, response.results, since);
      // Pull current server state even after a replay: its original result may be superseded.
      await pull(current, token);
      if (!isCurrentAccount(current.accountId, current.epoch)) return;
      await access.verify(identity.account);
      if (!isCurrentAccount(current.accountId, current.epoch) || visit.current !== token || !access.allowed(current.accountId, current.stock.shopId)) return;
      const stock = current.queue.cache.read(current.stock.shopId);
      if (stock) setLoad({ ...current, stock });
      redraw((value) => value + 1);
    } catch {
      if (isCurrentAccount(current.accountId, current.epoch) && visit.current === token) setMessage(words.storageFailed);
    }
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
      if (current) { await sync(current, token); return; }
      const cached = queue.cache.read(permission.shopId);
      if (cached) {
        const loaded: Loaded = { kind: "loaded", accountId: identity.account.id, epoch, stock: cached, queue };
        setLoad(loaded);
        if (permission.mode === "offline") { setMessage(words.refreshFailed); return; }
        await sync(loaded, token);
        return;
      }
      setLoad({ kind: "loading" });
      const answer = await api.syncChanges().catch(() => null);
      if (!isCurrentAccount(identity.account.id, epoch) || visit.current !== token) return;
      if (!answer?.ok) return setLoad({ kind: "failed", message: answer ? strings.errors[answer.code] : words.loadFailed });
      if (answer.data.shopId !== permission.shopId || !access.allowed(identity.account.id, permission.shopId)) return;
      queue.importLegacy(answer.data.shopId, legacyOpeningStock);
      queue.cache.apply(answer.data);
      const stock = queue.cache.read(answer.data.shopId);
      if (!stock) throw new Error("Missing Stock cache");
      const loaded: Loaded = { kind: "loaded", accountId: identity.account.id, epoch, stock, queue };
      setLoad(loaded);
      await sync(loaded, token);
    } catch {
      if (isCurrentAccount(identity.account.id, epoch) && visit.current === token) setLoad({ kind: "failed", message: words.storageFailed });
    }
  }

  useFocusEffect(useCallback(() => {
    const token = ++visit.current;
    void refresh(token);
    return () => { ++visit.current; };
  }, []));

  function save(current: Loaded, packId: string, outOfStock: boolean) {
    if (!isCurrentAccount(current.accountId, current.epoch) || !access.allowed(current.accountId, current.stock.shopId)) { access.expire(); return; }
    try {
      const blocked = current.queue.saveFlag(current.stock.shopId, packId, outOfStock);
      if (blocked) return setMessage(words[blocked]);
      setMessage(null);
      redraw((value) => value + 1);
      void sync(current);
    } catch { setMessage(words.storageFailed); }
  }

  return (
    <ScrollView className="flex-1 bg-bg" contentContainerClassName="gap-4 px-4" contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 32 }}>
      <Link href="/" className="py-3 text-body text-primary">{words.back}</Link>
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
        <Button label={words.retry} variant="secondary" onPress={() => void sync(load)} />
        {load.stock.items.length === 0 && <Text className="text-body text-muted">{words.empty}</Text>}
        {load.stock.items.map((item) => {
          const flag = load.queue.flag(load.stock.shopId, item.packId);
          const desired = flag && flag.status !== "applied" ? StockFlagPayload.parse(flag.action.payload).outOfStock : item.outOfStock;
          return <View key={item.packId} className="gap-2 rounded-card border border-border bg-surface p-4">
            <Text className="text-headline font-semibold text-text">{item.name} · {trimDecimal(item.packQuantity)} {item.baseUnit}</Text>
            <Text className="text-secondary text-muted">{stockLine(item.quantity, item.held, item.baseUnit)}</Text>
            <View className="flex-row items-center justify-between gap-4">
              <Text className="text-body text-text">{words.outOfStock}</Text>
              {item.unavailable ? <Text className="text-body text-muted">{words.unavailable}</Text> : <Toggle on={desired} busy={false} label={`${item.name}: ${words.outOfStock}`} onPress={() => {
                const latest = load.queue.flag(load.stock.shopId, item.packId);
                const value = latest && latest.status !== "applied" ? StockFlagPayload.parse(latest.action.payload).outOfStock : desired;
                save(load, item.packId, !value);
              }} />}
            </View>
            <Text accessibilityLiveRegion="polite" className="text-secondary text-muted">{flag?.status === "pending" ? words.pending : flag?.status === "applied" ? words.saved : ""}</Text>
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
        <Link href="/opening-stock" className="py-3 text-body text-primary">{words.opening}</Link>
      </>}
    </ScrollView>
  );
}
