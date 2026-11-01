import { CounterBillLine, CounterBillPayload } from "@ygo/contracts";
import { formatNumber, trimDecimal } from "@ygo/format";
import { Button, SupportEmail, Text } from "@ygo/mobile";
import { counterBillTotal } from "@ygo/pricing";
import { Link, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { access, accountEpoch, session, supportEmail } from "../api";
import { BillCard } from "../components/bill-card";
import { Minus, Plus } from "../components/icons";
import { SyncStatus } from "../components/sync-status";
import { isCurrentAccount } from "../lib/account";
import { startOfToday } from "../lib/bill-status";
import { money } from "../lib/money";
import { openOpeningStock } from "../lib/opening-stock-database";
import type { OpeningStockQueue } from "../lib/opening-stock-queue";
import { stockSync } from "../lib/stock-sync";
import { strings } from "../strings";

const words = strings.bill;
type Item = NonNullable<ReturnType<OpeningStockQueue["cache"]["read"]>>["items"][number];
type Loaded = { kind: "loaded"; accountId: string; epoch: number; shopId: string; queue: OpeningStockQueue };
type Load = { kind: "loading" } | { kind: "failed" } | Loaded;
type Line = { item: Item & { counterPrice: string }; count: string };

/**
 * S06 Counter bill (#468): whole packs from the Stock saved on this phone, at each pack's counter price, paid
 * by cash or UPI. It works offline: the bill is queued, and Today's bills shows its number once it syncs.
 * Owner's answers on #468 (1–9).
 */
export default function BillScreen() {
  const insets = useSafeAreaInsets();
  const view = useSyncExternalStore(access.subscribe, access.get);
  // A sync pass redraws, so Today's bills shows each new number.
  const status = useSyncExternalStore(stockSync.subscribe, stockSync.get);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [search, setSearch] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [payment, setPayment] = useState<"cash" | "upi" | null>(null);
  const [message, setMessage] = useState<{ text: string; saved: boolean } | null>(null);
  const visit = useRef(0);
  // The lines last saved: a second tap before the cleared form redraws must not queue the same bill again.
  const savedLines = useRef<Line[] | null>(null);

  async function open(token: number) {
    const identity = session.get();
    if (!("account" in identity)) return;
    const epoch = accountEpoch(), shopId = access.get().shopId;
    try {
      if (!shopId || !access.allowed(identity.account.id, shopId)) return setLoad({ kind: "failed" });
      const queue = await openOpeningStock(identity.account.id);
      if (isCurrentAccount(identity.account.id, epoch) && visit.current === token) setLoad({ kind: "loaded", accountId: identity.account.id, epoch, shopId, queue });
    } catch {
      if (isCurrentAccount(identity.account.id, epoch) && visit.current === token) setLoad({ kind: "failed" });
    }
  }

  useFocusEffect(useCallback(() => {
    const token = ++visit.current;
    void open(token);
    return () => { ++visit.current; };
  }, []));

  const loaded = load.kind === "loaded" && isCurrentAccount(load.accountId, load.epoch) && access.allowed(load.accountId, load.shopId) ? load : null;
  // Stock and Today's bills are read from the phone on opening, after a save and after each sync pass, not on every keystroke.
  const read = useMemo(() => {
    try {
      return loaded ? { items: loaded.queue.cache.read(loaded.shopId)?.items.filter((item) => !item.unavailable) ?? [], bills: loaded.queue.bills(loaded.shopId, startOfToday()) } : null;
    } catch { return null; }
  }, [loaded, status, message]);

  const counts = lines.map((line) => Number(line.count));
  const ready = lines.length > 0 && counts.every((count) => CounterBillLine.shape.count.safeParse(count).success);
  const total = ready ? counterBillTotal(lines.map((line, i) => ({ unitPrice: line.item.counterPrice, count: counts[i] ?? 0 }))) : null;
  const found = search.trim() ? read?.items.filter((item) => item.name.toLowerCase().includes(search.trim().toLowerCase()) && !lines.some((line) => line.item.packId === item.packId)) ?? [] : [];

  function add(item: Item) {
    if (!item.counterPrice) return;
    if (lines.length >= 100) return setMessage({ text: words.tooMany, saved: false });
    setLines((current) => [...current, { item: { ...item, counterPrice: item.counterPrice as string }, count: "1" }]);
    setSearch("");
  }
  function setCount(packId: string, count: string) {
    setLines((current) => current.map((line) => line.item.packId === packId ? { ...line, count } : line));
  }
  function step(packId: string, by: number) {
    setLines((current) => current.flatMap((line) => {
      if (line.item.packId !== packId) return [line];
      const next = (Number.parseInt(line.count, 10) || 0) + by;
      return next < 1 ? [] : [{ ...line, count: String(next) }];
    }));
  }

  function save() {
    if (!loaded || !total || !payment || savedLines.current === lines) return;
    if (!isCurrentAccount(loaded.accountId, loaded.epoch) || !access.allowed(loaded.accountId, loaded.shopId)) { access.expire(); return; }
    const bill = CounterBillPayload.safeParse({ lines: lines.map((line, i) => ({ packId: line.item.packId, count: counts[i], unitPrice: line.item.counterPrice })), total, payment });
    if (!bill.success) return setMessage({ text: words.checkCounts, saved: false });
    try {
      const saved = loaded.queue.saveBill(loaded.shopId, bill.data);
      if (typeof saved === "string") return setMessage({ text: words[saved], saved: false });
      savedLines.current = lines;
      setLines([]); setPayment(null); setMessage({ text: words.saved(saved.reference), saved: true });
      void stockSync.run();
    } catch { setMessage({ text: words.storageFailed, saved: false }); }
  }

  return (
    <ScrollView className="flex-1 bg-bg" keyboardShouldPersistTaps="handled" contentContainerClassName="gap-4 px-4" contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 32 }}>
      {/* Offline, only Stock, this screen and S08 open (#394). */}
      <Link href={view.mode === "offline" ? "/stock" : "/"} asChild><Pressable accessibilityRole="button" className="py-3"><Text className="text-body text-primary">{words.back}</Text></Pressable></Link>
      <Text accessibilityRole="header" className="text-title-large font-semibold text-text">{words.title}</Text>
      {load.kind === "loading" && <ActivityIndicator className="text-primary" />}
      {(load.kind === "failed" || (load.kind === "loaded" && !read)) && <>
        <Text accessibilityLiveRegion="polite" className="text-body text-danger">{words.loadFailed}</Text>
        <Button label={words.retry} variant="secondary" onPress={() => void open(++visit.current)} />
        <SupportEmail address={supportEmail} className="text-secondary" />
      </>}
      {read && <>
        <SyncStatus />
        {read.items.length === 0 && <Text className="text-body text-muted">{words.empty}</Text>}
        {read.items.length > 0 && <TextInput accessibilityLabel={words.search} placeholder={words.search} value={search} onChangeText={setSearch}
          className="h-[52px] rounded-input border border-border bg-bg px-3 text-body text-text" />}
        {search.trim() !== "" && found.length === 0 && <Text className="text-body text-muted">{words.noMatch}</Text>}
        {found.map((item) => <Pressable key={item.packId} accessibilityRole="button" accessibilityState={{ disabled: !item.counterPrice }} disabled={!item.counterPrice}
          onPress={() => add(item)} className="gap-1 rounded-card border border-border bg-surface p-4">
          <Text className={item.counterPrice ? "text-headline font-semibold text-text" : "text-headline font-semibold text-muted"}>{item.name} · {trimDecimal(item.packQuantity)} {item.baseUnit}</Text>
          <Text className="text-secondary text-muted">{item.counterPrice ? money(item.counterPrice) : words.noPrice}</Text>
        </Pressable>)}

        {lines.length > 0 && <View className="gap-3">
          <Text accessibilityRole="header" className="text-title font-semibold text-text">{words.lines}</Text>
          {lines.map((line) => {
            const name = `${line.item.name} · ${trimDecimal(line.item.packQuantity)} ${line.item.baseUnit}`;
            return <View key={line.item.packId} className="gap-2 rounded-card border border-border bg-surface p-4">
              <Text className="text-headline font-semibold text-text">{name}</Text>
              <Text className="text-secondary text-muted">{words.each(money(line.item.counterPrice))}</Text>
              <View className="flex-row items-center gap-3">
                <Pressable accessibilityRole="button" accessibilityLabel={words.less(name)} onPress={() => step(line.item.packId, -1)} className="h-12 w-12 items-center justify-center rounded-button border border-border"><Minus size={20} className="text-text" /></Pressable>
                <TextInput accessibilityLabel={words.count(name)} keyboardType="number-pad" value={line.count} onChangeText={(value) => setCount(line.item.packId, value.replace(/\D/g, ""))}
                  className="h-12 w-20 rounded-input border border-border bg-bg px-3 text-center text-body text-text" />
                <Pressable accessibilityRole="button" accessibilityLabel={words.more(name)} onPress={() => step(line.item.packId, 1)} className="h-12 w-12 items-center justify-center rounded-button border border-border"><Plus size={20} className="text-text" /></Pressable>
              </View>
            </View>;
          })}
          <Text accessibilityLiveRegion="polite" className="text-title font-semibold text-text">{total ? words.total(money(total)) : words.checkCounts}</Text>
          <Text className="text-body text-text">{words.paidBy}</Text>
          <View className="flex-row gap-3">
            {(["cash", "upi"] as const).map((way) => <Pressable key={way} accessibilityRole="radio" accessibilityState={{ checked: payment === way }} onPress={() => setPayment(way)}
              className={payment === way ? "flex-1 items-center rounded-button bg-primary px-4 py-3" : "flex-1 items-center rounded-button border border-primary px-4 py-3"}>
              <Text className={payment === way ? "text-body font-semibold text-on-primary" : "text-body font-semibold text-primary"}>{words.payments[way]}</Text>
            </Pressable>)}
          </View>
          {!payment && <Text className="text-secondary text-muted">{words.choosePayment}</Text>}
          <Button label={words.save} disabled={!total || !payment} onPress={save} />
        </View>}
        {message && <Text accessibilityLiveRegion="polite" selectable className={message.saved ? "text-body text-success" : "text-body text-danger"}>{message.text}</Text>}

        <Text accessibilityRole="header" className="text-title font-semibold text-text">{words.today} · {formatNumber(read.bills.length)}</Text>
        {read.bills.length === 0 && <Text className="text-body text-muted">{words.none}</Text>}
        {read.bills.map((bill) => <BillCard key={bill.id} bill={bill} />)}
      </>}
    </ScrollView>
  );
}
