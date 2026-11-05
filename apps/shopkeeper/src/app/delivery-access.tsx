import type { ShopStaffResponse } from "@ygo/contracts";
import { Button, Text, useInFront } from "@ygo/mobile";
import { Link } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../api";
import { useAccountRole } from "../lib/account-role";
import { strings } from "../strings";

const words = strings.orders;
export default function DeliveryAccessScreen() {
  const insets = useSafeAreaInsets();
  const owner = useAccountRole() === "owner";
  const [staff, setStaff] = useState<ShopStaffResponse | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const read = useCallback(async () => {
    const result = await api.shopStaff();
    setStaff(result.ok ? result.data : null);
    setMessage(result.ok ? null : strings.errors[result.code]);
  }, []);
  const start = useCallback(() => { void read(); }, [read]);
  const stop = useCallback(() => undefined, []);
  useInFront({ start, stop });
  const rows = staff?.staff ?? [];
  return <ScrollView className="flex-1 bg-bg" contentContainerClassName="gap-4 px-4" contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 32 }} refreshControl={<RefreshControl refreshing={false} onRefresh={() => void read()} progressViewOffset={insets.top} />}>
    <Link href="/" asChild><Pressable accessibilityRole="button" className="py-3"><Text className="text-body text-primary">{words.back}</Text></Pressable></Link>
    <Text accessibilityRole="header" className="text-title-large font-semibold text-text">{words.staffDelivery}</Text>
    {!staff && !message && <View className="flex-row items-center gap-2"><ActivityIndicator className="text-primary"/><Text className="text-body text-muted">{words.loading}</Text></View>}
    {message && <Text accessibilityLiveRegion="polite" className="text-body text-danger">{message}</Text>}
    {staff && rows.length === 0 && <Text className="text-body text-muted">{words.staffDeliveryEmpty}</Text>}
    {rows.map((person) => <View key={person.accountId} className="flex-row items-center justify-between gap-3 rounded-card border border-border bg-surface p-4">
      <Text className="flex-1 text-body font-semibold text-text">{person.name ?? person.accountId}</Text>
      <Button label={person.canDeliver ? words.deliveryEnabled : words.deliveryDisabled} variant={person.canDeliver ? "secondary" : "primary"} busy={busy === person.accountId} disabled={!owner || busy !== null} onPress={() => {
        setBusy(person.accountId);
        void api.setStaffCanDeliver(person.accountId, { canDeliver: !person.canDeliver }).then((result) => {
          setBusy(null);
          if (!result.ok) setMessage(strings.errors[result.code]);
          else { setMessage(words.staffDeliverySaved); void read(); }
        });
      }} />
    </View>)}
  </ScrollView>;
}
