import type { Statement, StatementLine } from "@ygo/contracts";
import { formatDateTime, formatDayMonth, formatDayMonthYear } from "@ygo/format";
import { Button, Text, useInFront } from "@ygo/mobile";
import { toPaise } from "@ygo/pricing";
import { Link, useLocalSearchParams } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../../api";
import { money } from "../../lib/money";
import { shareStatement } from "../../lib/share-statement";
import { strings } from "../../strings";

const words = strings.money;

type Load = { kind: "loading" } | { kind: "failed"; message: string } | { kind: "loaded"; statement: Statement };

function Part({ label, amount, minus }: { label: string; amount: string; minus?: boolean }) {
  return <View className="flex-row justify-between"><Text className="text-body text-muted">{label}</Text><Text className="text-body text-text">{minus && toPaise(amount) !== 0n ? `−${money(amount)}` : money(amount)}</Text></View>;
}

/** One completed order of the statement: what is owed on it, and under a tap how that is made up. */
function Line({ line, open, toggle }: { line: StatementLine; open: boolean; toggle: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={toggle} className="min-h-14 gap-2 rounded-2xl border border-border bg-surface p-4">
      <View className="flex-row justify-between gap-3">
        <Text className="text-body font-semibold text-text">{line.late ? `${words.order(line.orderNumber)} · ${words.late}` : words.order(line.orderNumber)}</Text>
        <Text className="text-body font-semibold text-text">{money(line.owed)}</Text>
      </View>
      <Text className="text-body text-muted">{formatDateTime(line.completedAt)}</Text>
      {open && <View className="gap-1 border-t border-border pt-2">
        <Part label={words.orderTotal} amount={line.orderTotal} />
        <Part label={words.commission} amount={line.commission} />
        <Part label={words.feeShare} amount={line.feeShare} />
        <Part label={words.bookingFees} amount={line.bookingFees} />
        <Part label={words.coupon} amount={line.platformCoupon} minus />
      </View>}
    </Pressable>
  );
}

/** One weekly statement (#630, MNY-12): its week, due date, each order and the total, saying it is not a tax invoice; shared as a PDF made on the phone. */
export default function StatementScreen() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [opened, setOpened] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Set before React re-renders, so a second tap never opens a second share sheet.
  const working = useRef(false);

  const read = useCallback(async () => {
    const answer = await api.myStatement(id).catch(() => null);
    if (answer?.ok) return setLoad({ kind: "loaded", statement: answer.data });
    setLoad((now) => now.kind === "loaded" && now.statement.id === id ? now : { kind: "failed", message: answer ? strings.errors[answer.code] : words.loadFailed });
  }, [id]);
  const start = useCallback(() => void read(), [read]);
  const stop = useCallback(() => undefined, []);
  useInFront({ start, stop });

  async function share(statement: Statement) {
    if (working.current) return;
    working.current = true;
    setSharing(true);
    setMessage(null);
    try { await shareStatement(statement); } catch { setMessage(words.shareFailed); }
    working.current = false;
    setSharing(false);
  }

  // A statement left from another id (a tap on a push while one is open) is never shown under this one.
  const statement = load.kind === "loaded" && load.statement.id === id ? load.statement : null;
  return (
    <ScrollView className="flex-1 bg-bg" contentContainerClassName="gap-4 px-4" contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 32 }}>
      <Link href="/money" asChild><Pressable accessibilityRole="button" className="min-h-12 justify-center self-start"><Text className="text-body font-semibold text-primary">‹ {words.title}</Text></Pressable></Link>
      {(load.kind === "loading" || (load.kind === "loaded" && !statement)) && <View className="flex-row items-center gap-2"><ActivityIndicator className="text-primary" /><Text className="text-body text-muted">{words.loading}</Text></View>}
      {load.kind === "failed" && <>
        <Text accessibilityLiveRegion="polite" className="text-body text-danger">{load.message}</Text>
        <Button label={words.retry} onPress={() => { setLoad({ kind: "loading" }); void read(); }} variant="secondary" />
      </>}
      {statement && <>
        <Text accessibilityRole="header" className="text-title-large font-semibold text-text">{words.number(statement.number)}</Text>
        <View className="gap-1">
          <Text className="text-body text-text">{words.week(formatDayMonth(statement.periodStart), formatDayMonthYear(statement.periodEnd))}</Text>
          <Text className="text-body text-muted">{words.due(formatDayMonthYear(statement.dueOn))}</Text>
          <Text className="text-body text-muted">{words.orders(statement.orderCount)}</Text>
        </View>
        <View className="flex-row justify-between rounded-2xl border border-border bg-surface p-4">
          <Text className="text-body font-semibold text-text">{words.total}</Text>
          <Text className="text-body font-semibold text-text">{money(statement.total)}</Text>
        </View>
        <Text className="text-body font-semibold text-text">{words.notTaxInvoice}</Text>
        {message && <Text accessibilityLiveRegion="polite" className="text-body text-danger">{message}</Text>}
        <Button label={sharing ? words.sharing : words.share} onPress={() => share(statement)} disabled={sharing} variant="secondary" />
        {statement.lines.map((line) => <Line key={line.orderId} line={line} open={opened === line.orderId} toggle={() => setOpened(opened === line.orderId ? null : line.orderId)} />)}
        <Text className="text-body text-muted">{words.lateNote}</Text>
      </>}
    </ScrollView>
  );
}
