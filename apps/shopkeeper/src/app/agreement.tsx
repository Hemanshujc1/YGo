import type { ShopAgreementResponse } from "@ygo/contracts";
import { formatDate } from "@ygo/format";
import { Button, Text } from "@ygo/mobile";
import { Link } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../api";
import { commissionText, rateCardLines } from "../lib/agreement";
import { strings } from "../strings";

const words = strings.agreement;

type Load = { kind: "loading" } | { kind: "failed"; message: string } | { kind: "loaded"; agreement: ShopAgreementResponse };

/**
 * S19 Agreement and rate card (ONB-5, #362): the agreement, the shop's card
 * and each category whose commission differs. Accepting stores both versions;
 * a newer card or agreement asks again. Owner's answers on #46.
 */
export default function AgreementScreen() {
  const insets = useSafeAreaInsets();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Set before React re-renders, so a second tap never accepts twice.
  const working = useRef(false);

  async function fetchAgreement(refresh = false) {
    if (refresh) setRefreshing(true);
    else setLoad({ kind: "loading" });
    const answer = await api.shopAgreement().catch(() => null);
    setRefreshing(false);
    if (answer?.ok) return setLoad({ kind: "loaded", agreement: answer.data });
    // A refresh keeps the agreement on screen and says why it didn't update.
    const failed = answer ? strings.errors[answer.code] : words.loadFailed;
    if (refresh && load.kind === "loaded") setMessage(failed);
    else setLoad({ kind: "failed", message: failed });
  }

  useEffect(() => {
    void fetchAgreement();
  }, []);

  async function accept(agreement: ShopAgreementResponse) {
    if (working.current || agreement.rateCardVersion === "0") return;
    working.current = true;
    setAccepting(true);
    setMessage(null);
    const answer = await api.acceptShopAgreement({ agreementVersion: agreement.agreementVersion, rateCardVersion: agreement.rateCardVersion }).catch(() => null);
    working.current = false;
    setAccepting(false);
    if (answer?.ok) return setLoad({ kind: "loaded", agreement: answer.data });
    setMessage(answer ? strings.errors[answer.code] : words.acceptFailed);
    // What the Owner read is no longer current: show the new one.
    if (answer && ["RATE_CARD_CHANGED", "AGREEMENT_OUTDATED", "RATE_CARD_INCOMPLETE"].includes(answer.code)) void fetchAgreement(true);
  }

  return (
    <ScrollView
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setMessage(null); void fetchAgreement(true); }} progressViewOffset={insets.top} />}
      className="flex-1 bg-bg"
      contentContainerClassName="gap-4 px-4"
      contentContainerStyle={{ paddingTop: insets.top + 20, paddingBottom: insets.bottom + 28 }}
    >
      <Link href="/" asChild><Pressable accessibilityRole="button"><Text className="text-body font-semibold text-primary">‹ {words.back}</Text></Pressable></Link>
      <Text accessibilityRole="header" className="text-title-large font-semibold text-text">{words.title}</Text>
      {load.kind === "loading" && <ActivityIndicator size="large" className="text-primary" />}
      {load.kind === "failed" && <>
        <Text accessibilityLiveRegion="polite" className="text-body text-danger">{load.message}</Text>
        <Button label={words.retry} onPress={() => void fetchAgreement()} variant="secondary" />
      </>}
      {load.kind === "loaded" && <Agreement agreement={load.agreement} accepting={accepting} message={message} onAccept={() => void accept(load.agreement)} />}
    </ScrollView>
  );
}

function Agreement({ agreement, accepting, message, onAccept }: { agreement: ShopAgreementResponse; accepting: boolean; message: string | null; onAccept: () => void }) {
  const ready = agreement.missing.length === 0 && agreement.rateCardVersion !== "0";
  return <>
    <Text className="text-body text-muted">{words.intro}</Text>
    {words.sections.map((section) => (
      <View key={section.title} className="gap-1">
        <Text accessibilityRole="header" className="text-title font-semibold text-text">{section.title}</Text>
        <Text className="text-body text-text">{section.body}</Text>
      </View>
    ))}
    <View className="gap-3 rounded-card border border-border bg-surface p-4">
      <Text accessibilityRole="header" className="text-title font-semibold text-text">{words.rateCardTitle}</Text>
      {ready ? <>
        <Text className="text-secondary text-muted">{words.rateCardIntro}</Text>
        {rateCardLines(agreement.rateCard).map((line) => (
          <View key={line.key} accessible className="gap-1">
            <Text className="text-secondary font-semibold text-text">{line.label}</Text>
            <Text className="text-body text-text">{line.value}</Text>
          </View>
        ))}
        {agreement.categoryCommissions.length > 0 && <View className="gap-2">
          <Text className="text-secondary font-semibold text-text">{words.categoryTitle}</Text>
          {agreement.categoryCommissions.map((category) => (
            <Text key={category.categoryId} className="text-body text-text">{category.name}: {commissionText(category.commission)}</Text>
          ))}
        </View>}
      </> : <Text className="text-body text-pending">{words.notReady}</Text>}
    </View>
    {agreement.accepted && agreement.current && <Text accessibilityLiveRegion="polite" className="text-body text-success">{words.acceptedOn(formatDate(agreement.accepted.acceptedAt))}</Text>}
    {agreement.accepted && !agreement.current && <Text className="text-body text-pending">{words.acceptAgain}</Text>}
    {message && <Text accessibilityLiveRegion="polite" className="text-secondary text-danger">{message}</Text>}
    {ready && !agreement.current && <Button label={words.accept} onPress={onAccept} busy={accepting} />}
  </>;
}
