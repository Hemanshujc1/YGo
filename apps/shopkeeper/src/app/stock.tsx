import { StockFlagPayload, type ShopStockResponse } from "@ygo/contracts";
import { trimDecimal } from "@ygo/format";
import { Button, SupportEmail, Text } from "@ygo/mobile";
import { Link, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, session, supportEmail } from "../api";
import { Toggle } from "../components/toggle";
import { isCurrentAccount } from "../lib/account";
import { legacyOpeningStock, openOpeningStock } from "../lib/opening-stock-database";
import { type OpeningStockQueue, syncOpeningStockBatch } from "../lib/opening-stock-queue";
import { strings } from "../strings";

const words = strings.stock;
type Loaded = { kind: "loaded"; accountId: string; stock: ShopStockResponse; queue: OpeningStockQueue };
type Load = { kind: "loading" } | { kind: "failed"; message: string } | Loaded;

export default function StockScreen() {
  const insets = useSafeAreaInsets();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [message, setMessage] = useState<string | null>(null);
  const [, redraw] = useState(0);
  const visit = useRef(0);

  async function sync(current: Loaded, token = visit.current) {
    const response = await syncOpeningStockBatch(current.queue, current.stock.shopId, (body) => api.syncActions(body));
    if (!isCurrentAccount(current.accountId) || visit.current !== token) return;
    // A replay returns its original result, which another phone may since have superseded.
    const refreshed = response?.results.some((row) => row.status === "applied") ? await api.shopStock().catch(() => null) : null;
    if (!isCurrentAccount(current.accountId) || visit.current !== token) return;
    if (refreshed?.ok && refreshed.data.shopId === current.stock.shopId) {
      setLoad((old) => old.kind === "loaded" ? { ...old, stock: refreshed.data } : old);
      redraw((value) => value + 1);
      return;
    }
    setLoad((old) => old.kind === "loaded" ? { ...old, stock: { ...old.stock, items: old.stock.items.map((item) => {
      const applied = response?.results.findLast((row) => row.status === "applied" && row.result?.listingId === item.listingId && "outOfStock" in row.result);
      return applied?.result && "outOfStock" in applied.result ? { ...item, outOfStock: applied.result.outOfStock } : item;
    }) } } : old);
    redraw((value) => value + 1);
  }

  async function refresh(token: number) {
    const identity = session.get();
    if (!("account" in identity)) return;
    setLoad({ kind: "loading" });
    const answer = await api.shopStock().catch(() => null);
    if (!isCurrentAccount(identity.account.id) || visit.current !== token) return;
    if (!answer?.ok) return setLoad({ kind: "failed", message: answer ? strings.errors[answer.code] : words.loadFailed });
    try {
      const queue = await openOpeningStock(identity.account.id);
      if (!isCurrentAccount(identity.account.id) || visit.current !== token) return;
      queue.importLegacy(answer.data.shopId, legacyOpeningStock);
      const current: Loaded = { kind: "loaded", accountId: identity.account.id, stock: answer.data, queue };
      setLoad(current);
      await sync(current, token);
    } catch {
      if (isCurrentAccount(identity.account.id) && visit.current === token) setLoad({ kind: "failed", message: words.storageFailed });
    }
  }

  useFocusEffect(useCallback(() => {
    const token = ++visit.current;
    void refresh(token);
    return () => { ++visit.current; };
  }, []));

  function save(current: Loaded, packId: string, outOfStock: boolean) {
    if (!isCurrentAccount(current.accountId)) return;
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
      {message && <Text accessibilityLiveRegion="polite" className="text-body text-danger">{message}</Text>}
      {load.kind === "loaded" && <>
        {load.stock.state === "suspended" && <Text className="text-body text-danger">{words.suspended}</Text>}
        <Button label={words.retry} variant="secondary" onPress={() => void sync(load)} />
        {load.stock.items.length === 0 && <Text className="text-body text-muted">{words.empty}</Text>}
        {load.stock.items.map((item) => {
          const flag = load.queue.flag(load.stock.shopId, item.packId);
          const desired = flag && flag.status !== "applied" ? StockFlagPayload.parse(flag.action.payload).outOfStock : item.outOfStock;
          return <View key={item.packId} className="gap-2 rounded-card border border-border bg-surface p-4">
            <Text className="text-headline font-semibold text-text">{item.name} · {trimDecimal(item.packQuantity)} {item.baseUnit}</Text>
            <Text className="text-secondary text-muted">{trimDecimal(item.quantity)} {item.baseUnit}</Text>
            <View className="flex-row items-center justify-between gap-4">
              <Text className="text-body text-text">{words.outOfStock}</Text>
              <Toggle on={desired} busy={false} label={`${item.name}: ${words.outOfStock}`} onPress={() => {
                const latest = load.queue.flag(load.stock.shopId, item.packId);
                const value = latest && latest.status !== "applied" ? StockFlagPayload.parse(latest.action.payload).outOfStock : desired;
                save(load, item.packId, !value);
              }} />
            </View>
            <Text accessibilityLiveRegion="polite" className="text-secondary text-muted">{flag?.status === "pending" ? words.pending : flag?.status === "applied" ? words.saved : ""}</Text>
            {flag?.status === "rejected" && <>
              <Text selectable className="text-secondary text-danger">{words.failed(flag.action.id)}</Text>
              <Text className="text-secondary text-muted">{words.corrected}</Text>
              <Button label={words.retry} variant="secondary" onPress={() => save(load, item.packId, desired)} />
              <SupportEmail address={supportEmail} className="text-secondary" />
            </>}
          </View>;
        })}
        <Link href="/opening-stock" className="py-3 text-body text-primary">{words.opening}</Link>
      </>}
    </ScrollView>
  );
}
