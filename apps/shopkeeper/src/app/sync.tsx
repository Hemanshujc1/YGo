import { SyncActionCode } from "@ygo/contracts";
import { formatTime, trimDecimal } from "@ygo/format";
import { Button, SupportEmail, Text } from "@ygo/mobile";
import { Link } from "expo-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { access, accountEpoch, api, session, supportEmail } from "../api";
import { isCurrentAccount } from "../lib/account";
import { openOpeningStock } from "../lib/opening-stock-database";
import type { OpeningStockQueue, QueueRow } from "../lib/opening-stock-queue";
import { stockSync } from "../lib/stock-sync";
import { strings } from "../strings";

const words = strings.sync;
type Label = NonNullable<QueueRow["label"]>;
type Data = { overview: ReturnType<OpeningStockQueue["overview"]>; allowance: ReturnType<OpeningStockQueue["allowance"]> };

function startOfToday(now = new Date()) { return new Date(now.getFullYear(), now.getMonth(), now.getDate()); }

/** S08 Waiting to sync (design system 5.1): Needs attention, Waiting to sync, Synced today. It never edits; fixes stay on Stock and Opening stock. */
export default function SyncScreen() {
  const insets = useSafeAreaInsets();
  const status = useSyncExternalStore(stockSync.subscribe, stockSync.get);
  const view = useSyncExternalStore(access.subscribe, access.get);
  const [data, setData] = useState<Data | "failed" | null>(null);
  const [names, setNames] = useState<Record<string, Label>>({});

  useEffect(() => {
    if (status.running) return;
    const identity = session.get();
    if (!("account" in identity)) return;
    const id = identity.account.id, epoch = accountEpoch();
    let gone = false;
    openOpeningStock(id).then((queue) => {
      if (!gone && isCurrentAccount(id, epoch)) setData({ overview: queue.overview(startOfToday()), allowance: queue.allowance() });
    }).catch(() => { if (!gone && isCurrentAccount(id, epoch)) setData("failed"); });
    return () => { gone = true; };
  }, [status]);

  // An Approved shop has no Stock copy on the phone yet: name its rows from the listings while online.
  const unnamed = data && data !== "failed" && Object.values(data.overview).some((rows) => rows.some((row) => !row.label));
  useEffect(() => {
    if (!unnamed || view.mode !== "online") return;
    let gone = false;
    api.shopListings().then((answer) => {
      if (!gone && answer.ok) setNames(Object.fromEntries(answer.data.items.map((item) => [item.packId, item])));
    }).catch(() => undefined);
    return () => { gone = true; };
  }, [unnamed, view.mode]);

  function card(row: QueueRow, section: keyof Data["overview"]) {
    const label = row.label ?? names[row.packId];
    const amount = row.quantity && `${trimDecimal(row.quantity)}${label ? ` ${label.baseUnit}` : ""}`;
    const change = row.type === "stock_flag" ? (row.outOfStock ? words.markedOut : words.markedIn) : words.opening(amount ?? "");
    const code = SyncActionCode.safeParse(row.code);
    return <View key={row.id} className="gap-1 rounded-card border border-border bg-surface p-4">
      <Text className="text-headline font-semibold text-text">{label ? `${label.name} · ${trimDecimal(label.packQuantity)} ${label.baseUnit}` : words.unknownProduct}</Text>
      <Text className="text-body text-text">{change}</Text>
      {section === "synced" && row.at && <Text className="text-secondary text-muted">{words.syncedAt(formatTime(row.at))}</Text>}
      {section === "attention" && <>
        <Text className="text-secondary text-danger">{row.type === "held" ? words.held : code.success ? words.reasons[code.data] : words.reasons.VALIDATION_FAILED}</Text>
        {row.type !== "held" && <Text selectable className="text-secondary text-muted">{words.reference(row.id)}</Text>}
        <Link href={row.type === "stock_flag" ? "/stock" : "/opening-stock"} className="py-3 text-body text-primary">{row.type === "stock_flag" ? words.fixStock : words.fixOpening}</Link>
      </>}
    </View>;
  }

  return (
    <ScrollView className="flex-1 bg-bg" contentContainerClassName="gap-4 px-4" contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 32 }}>
      {/* Offline, only Stock and this screen open (#394). */}
      <Link href={view.mode === "offline" ? "/stock" : "/"} className="py-3 text-body text-primary">{words.back}</Link>
      <Text accessibilityRole="header" className="text-title-large font-semibold text-text">{words.title}</Text>
      {data === null && <ActivityIndicator className="text-primary" />}
      {data === "failed" && <Text accessibilityLiveRegion="polite" className="text-body text-danger">{words.loadFailed}</Text>}
      {data && data !== "failed" && <>
        <Text className="text-body text-text">{words.meter(data.allowance.used, data.allowance.max, data.allowance.hoursLeft)}</Text>
        {(status.outcome === "retry" || status.outcome === "halt") && <Text accessibilityLiveRegion="polite" className="text-body text-pending">{words.offline}</Text>}
        <Button label={words.retry} variant="secondary" busy={status.running} onPress={() => void stockSync.retryNow()} />
        {(["attention", "waiting", "synced"] as const).map((section) => <View key={section} className="gap-3">
          <Text accessibilityRole="header" className="text-title font-semibold text-text">{words.sections[section]} · {data.overview[section].length}</Text>
          {data.overview[section].length === 0 && <Text className="text-body text-muted">{words.none}</Text>}
          {data.overview[section].map((row) => card(row, section))}
        </View>)}
        {data.overview.attention.length > 0 && <SupportEmail address={supportEmail} className="text-secondary" />}
      </>}
    </ScrollView>
  );
}
