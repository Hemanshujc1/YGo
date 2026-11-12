import { SyncActionCode } from "@ygo/contracts";
import { formatTime, trimDecimal } from "@ygo/format";
import { Button, SupportEmail, Text } from "@ygo/mobile";
import { Link } from "expo-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { access, accountEpoch, api, session, supportEmail } from "../api";
import { isCurrentAccount } from "../lib/account";
import { startOfToday } from "../lib/bill-status";
import { refreshBillVoids } from "../lib/bill-voids";
import { BillCard } from "../components/bill-card";
import { openOpeningStock } from "../lib/opening-stock-database";
import { shareBill } from "../lib/share-bill";
import type { OpeningStockQueue, QueueRow } from "../lib/opening-stock-queue";
import { stockSync } from "../lib/stock-sync";
import { strings } from "../strings";
import { backPath } from "../lib/back-path";

const words = strings.sync;
type Label = NonNullable<QueueRow["label"]>;
type Data = { queue: OpeningStockQueue; overview: ReturnType<OpeningStockQueue["overview"]>; allowance: ReturnType<OpeningStockQueue["allowance"]> };

/** S08 Waiting to sync (design system 5.1): Needs attention, Waiting to sync, Synced today. It never edits; fixes stay on Stock and Opening stock. */
export default function SyncScreen() {
  const insets = useSafeAreaInsets();
  const status = useSyncExternalStore(stockSync.subscribe, stockSync.get);
  const view = useSyncExternalStore(access.subscribe, access.get);
  const [data, setData] = useState<Data | "failed" | null>(null);
  const [names, setNames] = useState<Record<string, Label>>({});
  const [learned, setLearned] = useState(0);

  useEffect(() => {
    if (status.running) return;
    const identity = session.get();
    if (!("account" in identity)) return;
    const id = identity.account.id, epoch = accountEpoch();
    let gone = false;
    openOpeningStock(id).then((queue) => {
      if (!gone && isCurrentAccount(id, epoch)) setData({ queue, overview: queue.overview(startOfToday()), allowance: queue.allowance() });
    }).catch(() => { if (!gone && isCurrentAccount(id, epoch)) setData("failed"); });
    return () => { gone = true; };
  }, [status, learned]);

  // Online, the server's voids are learned once per opening; a new one redraws the cards (#493).
  const queue = data && data !== "failed" ? data.queue : null;
  useEffect(() => {
    if (!queue || view.mode !== "online") return;
    const identity = session.get();
    if (!("account" in identity)) return;
    const id = identity.account.id, epoch = accountEpoch();
    let gone = false;
    void refreshBillVoids(api, queue, () => isCurrentAccount(id, epoch)).then((found) => { if (found && !gone) setLearned((count) => count + 1); });
    return () => { gone = true; };
  }, [queue, view.mode]);

  // An Approved shop has no Stock copy on the phone yet: name its rows from the listings while online.
  const unnamed = data && data !== "failed" && Object.values(data.overview).some((rows) => rows.some((row) => !row.bill && !row.label));
  useEffect(() => {
    if (!unnamed || view.mode !== "online") return;
    let gone = false;
    api.shopListings().then((answer) => {
      if (!gone && answer.ok) setNames(Object.fromEntries(answer.data.items.map((item) => [item.packId, item])));
    }).catch(() => undefined);
    return () => { gone = true; };
  }, [unnamed, view.mode]);

  function card(row: QueueRow, section: keyof Data["overview"], queue: OpeningStockQueue) {
    const bill = row.bill;
    if (bill) return <BillCard key={row.id} bill={bill} syncedAt={section === "synced" ? row.at : null}
      onShare={() => shareBill({ bill, shopName: access.shopName(), shopGstin: access.shopGstin(), label: (packId) => queue.label(row.shopId, packId) })} />;
    if (row.type === "delivery") {
      const reason = SyncActionCode.safeParse(row.code);
      return <View key={row.id} className="gap-1 rounded-card border border-border bg-surface p-4">
        <Text className="text-headline font-semibold text-text">{words.delivery(row.deliveryType ?? "")}</Text>
        {section === "synced" && row.at && <Text className="text-secondary text-muted">{words.syncedAt(formatTime(row.at))}</Text>}
        {section === "attention" && <>
          <Text className="text-secondary text-danger">{reason.success ? words.reasons[reason.data] : words.reasons.VALIDATION_FAILED}</Text>
          <Text selectable className="text-secondary text-muted">{words.reference(row.id)}</Text>
          <Link href={`/orders/${row.packId}`} asChild><Pressable accessibilityRole="button" className="py-3"><Text className="text-body text-primary">{words.openOrder}</Text></Pressable></Link>
        </>}
      </View>;
    }
    const label = row.label ?? names[row.packId];
    const amount = row.quantity && `${trimDecimal(row.quantity)}${label ? ` ${label.baseUnit}` : ""}`;
    const change = row.type === "stock_flag" ? (row.outOfStock ? words.markedOut : words.markedIn) : row.type === "stock_change" ? words.stockChange(strings.stock.reasons[row.reason as keyof typeof strings.stock.reasons] ?? "", amount ?? "") : row.type === "opening_stock_correction" ? words.correction(amount ?? "") : words.opening(amount ?? "");
    const code = SyncActionCode.safeParse(row.code);
    return <View key={row.id} className="gap-1 rounded-card border border-border bg-surface p-4">
      <Text className="text-headline font-semibold text-text">{label ? `${label.name} · ${trimDecimal(label.packQuantity)} ${label.baseUnit}` : words.unknownProduct}</Text>
      <Text className="text-body text-text">{change}</Text>
      {section === "synced" && row.at && <Text className="text-secondary text-muted">{words.syncedAt(formatTime(row.at))}</Text>}
      {section === "attention" && <>
        <Text className="text-secondary text-danger">{row.type === "held" ? words.held : code.success ? words.reasons[code.data] : words.reasons.VALIDATION_FAILED}</Text>
        {row.type !== "held" && <Text selectable className="text-secondary text-muted">{words.reference(row.id)}</Text>}
        {/* Offline, Opening stock is closed (#394). */}
        {row.type === "stock_flag" || row.type === "stock_change" ? <Link href="/stock" asChild><Pressable accessibilityRole="button" className="py-3"><Text className="text-body text-primary">{words.fixStock}</Text></Pressable></Link>
          : view.mode === "offline" ? <Text className="text-secondary text-muted">{words.fixOnline}</Text>
          : <Link href="/opening-stock" asChild><Pressable accessibilityRole="button" className="py-3"><Text className="text-body text-primary">{words.fixOpening}</Text></Pressable></Link>}
      </>}
    </View>;
  }

  return (
    <ScrollView className="flex-1 bg-bg" contentContainerClassName="gap-4 px-4" contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 32 }}>
      {/* Offline, only Stock and this screen open (#394). */}
      <Link href={view.mode === "offline" ? "/stock" : backPath()} asChild><Pressable accessibilityRole="button" className="py-3"><Text className="text-body text-primary">{words.back}</Text></Pressable></Link>
      <Text accessibilityRole="header" className="text-title-large font-semibold text-text">{words.title}</Text>
      {data === null && <ActivityIndicator className="text-primary" />}
      {data === "failed" && <Text accessibilityLiveRegion="polite" className="text-body text-danger">{words.loadFailed}</Text>}
      {data && data !== "failed" && <>
        <Text className="text-body text-text">{words.meter(data.allowance.used, data.allowance.max, data.allowance.hoursLeft)}</Text>
        {(status.outcome === "retry" || status.outcome === "halt") && <Text accessibilityLiveRegion="polite" className="text-body text-pending">{status.outcome === "retry" ? words.offline : words.stopped}</Text>}
        <Button label={words.retry} variant="secondary" busy={status.running} onPress={() => void stockSync.retryNow()} />
        {(["attention", "waiting", "synced"] as const).map((section) => <View key={section} className="gap-3">
          <Text accessibilityRole="header" className="text-title font-semibold text-text">{words.sections[section]} · {data.overview[section].length}</Text>
          {data.overview[section].length === 0 && <Text className="text-body text-muted">{words.none}</Text>}
          {data.overview[section].map((row) => card(row, section, data.queue))}
        </View>)}
        {data.overview.attention.length > 0 && <SupportEmail address={supportEmail} className="text-secondary" />}
      </>}
    </ScrollView>
  );
}
