import { formatDayMonth, formatDayMonthYear } from "@ygo/format";
import { Button, Text, useInFront } from "@ygo/mobile";
import { Link } from "expo-router";
import { useState, useSyncExternalStore } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../../api";
import { createMoney } from "../../lib/statements";
import { money } from "../../lib/money";
import { strings } from "../../strings";

const words = strings.money;

/**
 * S15 Money (#630, MNY-8, MNY-11, MNY-12): what the shop owes YGo in two parts, and its weekly statements, newest first, a page at a time.
 * Only the Owner reaches it (More shows the row to them alone, and the server refuses everyone else). Sales and amounts owed, never profit.
 */
export default function MoneyScreen() {
  const insets = useSafeAreaInsets();
  const [store] = useState(() => createMoney(api));
  const view = useSyncExternalStore(store.subscribe, store.get);
  useInFront(store);
  const { balance } = view;

  const header = (
    <View className="gap-4 pb-2">
      <Link href="/more" asChild><Pressable accessibilityRole="button" className="min-h-12 justify-center self-start"><Text className="text-body font-semibold text-primary">‹ {words.back}</Text></Pressable></Link>
      <Text accessibilityRole="header" className="text-title-large font-semibold text-text">{words.title}</Text>
      {view.state === "loading" && <View className="flex-row items-center gap-2"><ActivityIndicator className="text-primary" /><Text className="text-body text-muted">{words.loading}</Text></View>}
      {view.state === "failed" && <>
        <Text accessibilityLiveRegion="polite" className="text-body text-danger">{view.message}</Text>
        <Button label={words.retry} onPress={() => void store.load()} variant="secondary" />
      </>}
      {view.refreshFailed && <Text accessibilityLiveRegion="polite" className="text-body text-danger">{words.refreshFailed}</Text>}
      {balance && (
        <View className="gap-2 rounded-2xl border border-border bg-surface p-4">
          <Text className="text-body text-muted">{words.balance}</Text>
          <View className="flex-row justify-between"><Text className="text-body text-text">{words.onStatements}</Text><Text className="text-body text-text">{money(balance.onStatements)}</Text></View>
          <View className="flex-row justify-between"><Text className="text-body text-text">{words.thisWeek}</Text><Text className="text-body text-text">{money(balance.thisWeek)}</Text></View>
          <View className="flex-row justify-between border-t border-border pt-2"><Text className="text-body font-semibold text-text">{words.total}</Text><Text className="text-body font-semibold text-text">{money(balance.total)}</Text></View>
        </View>
      )}
      {view.state === "loaded" && view.statements.length > 0 && <Text accessibilityRole="header" className="text-title font-semibold text-text">{words.statements}</Text>}
    </View>
  );

  return (
    <FlatList
      className="flex-1 bg-bg"
      contentContainerClassName="gap-2.5 px-4"
      contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 32 }}
      data={view.statements}
      keyExtractor={(statement) => statement.id}
      refreshControl={<RefreshControl refreshing={view.refreshing} onRefresh={() => void store.refresh()} progressViewOffset={insets.top} />}
      onEndReached={() => void store.more()}
      onEndReachedThreshold={0.5}
      ListHeaderComponent={header}
      ListEmptyComponent={view.state === "loaded" ? <View className="gap-1"><Text className="text-body font-semibold text-text">{words.none}</Text><Text className="text-body text-muted">{words.noneBody}</Text></View> : null}
      ListFooterComponent={view.loadingMore ? <ActivityIndicator className="text-primary" /> : view.moreFailed
        ? <View className="gap-2"><Text accessibilityLiveRegion="polite" className="text-body text-danger">{words.moreFailed}</Text><Button label={words.loadMore} onPress={() => void store.more()} variant="secondary" /></View> : null}
      renderItem={({ item }) => (
        <Link href={{ pathname: "/money/[id]", params: { id: item.id } }} asChild>
          <Pressable accessibilityRole="button" className="min-h-14 gap-1 rounded-2xl border border-border bg-surface p-4">
            <View className="flex-row justify-between gap-3">
              <Text className="text-body font-semibold text-text">{words.week(formatDayMonth(item.periodStart), formatDayMonth(item.periodEnd))}</Text>
              <Text className="text-body font-semibold text-text">{money(item.total)}</Text>
            </View>
            <Text className="text-body text-muted">{`${words.number(item.number)} · ${words.orders(item.orderCount)} · ${words.due(formatDayMonthYear(item.dueOn))}`}</Text>
          </Pressable>
        </Link>
      )}
    />
  );
}
