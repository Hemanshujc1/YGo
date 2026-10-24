import type { ApiResult } from "@ygo/api-client";
import type { HealthResponse } from "@ygo/contracts";
import { formatDate, formatDateTime, formatMoney, formatNumber, formatTime } from "@ygo/format";
import { Button, Text, useSession } from "@ygo/mobile";
import { Link, router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, session } from "../api";
import { askArea, type AreaAnswer, newestOnly, placeLabel, stale } from "../lib/location-flow";
import { savedPlace } from "../lib/saved-place";
import { strings } from "../strings";

// The scaffold screen: the server's health, the way to Account (C23), where shops deliver (#216), and the
// Inter review specimens (design system, section 10) until real screens replace it.

const prices = [1250, 45.5, 12000, 8];
const now = new Date();

function Heading({ children }: { children: string }) {
  return <Text className="mt-8 text-headline font-semibold text-text">{children}</Text>;
}

/** Counts down from ten minutes, so the review sees tabular digits change each second. */
function Countdown() {
  const [seconds, setSeconds] = useState(600);
  useEffect(() => {
    const timer = setInterval(() => setSeconds((s) => (s > 0 ? s - 1 : 600)), 1000);
    return () => clearInterval(timer);
  }, []);
  const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
  const rest = String(seconds % 60).padStart(2, "0");
  return (
    <Text className="text-display font-semibold tabular-nums text-text">{`${minutes}:${rest}`}</Text>
  );
}

type AreaState =
  | { kind: "checking" }
  | { kind: "served"; label: string }
  | { kind: "failed"; answer: Extract<AreaAnswer, { kind: "offline" | "error" }> };

/**
 * Where shops deliver, asked again each time Home opens (#216, Q3): C15 when
 * no place is saved, C03 when it isn't served. Leaving Home, or another
 * account signing in, drops an answer still on its way.
 */
function AreaLine() {
  const state = useSession(session);
  const accountId = state.status === "signed-in" ? state.account.id : null;
  const [area, setArea] = useState<AreaState>({ kind: "checking" });
  const [attempt, setAttempt] = useState(0);
  const [asks] = useState(newestOnly);

  useFocusEffect(
    useCallback(() => {
      if (!accountId) return;
      setArea({ kind: "checking" });
      void (async () => {
        const place = await asks.ask(savedPlace(accountId));
        if (place === stale) return;
        if (!place) return router.replace("/location");
        const answer = await asks.ask(askArea(api, place.pincode));
        if (answer === stale) return;
        if (answer.kind === "served") setArea({ kind: "served", label: placeLabel({ ...place, name: answer.areaName }) });
        else if (answer.kind === "not-served") router.replace({ pathname: "/not-serviceable", params: { pincode: place.pincode, name: place.name } });
        else setArea({ kind: "failed", answer });
      })();
      return asks.drop;
    }, [accountId, attempt, asks]),
  );

  const words = strings.area;
  if (area.kind === "checking") {
    return (
      <View className="mt-4 min-h-12 flex-row items-center gap-2">
        <ActivityIndicator className="text-primary" />
        <Text className="text-body text-muted">{words.checking}</Text>
      </View>
    );
  }
  if (area.kind === "failed") {
    return (
      <View className="mt-4 items-start">
        <Text className="text-body font-semibold text-text">{words.failed}</Text>
        <Text className="text-secondary text-muted">
          {area.answer.kind === "offline" ? words.offline : strings.errors[area.answer.code]}
        </Text>
        <Button label={words.retry} onPress={() => setAttempt((n) => n + 1)} variant="text" />
      </View>
    );
  }
  return (
    <View className="mt-4 items-start">
      <Text className="text-body tabular-nums text-text">{words.delivering(area.label)}</Text>
      <Button label={words.change} onPress={() => router.push("/location")} variant="text" />
    </View>
  );
}

export default function Home() {
  const insets = useSafeAreaInsets();
  const [result, setResult] = useState<ApiResult<HealthResponse> | "unreachable">();

  useEffect(() => {
    // health() rejects only when no answer came back: offline, refused or timed out.
    api.health().then(setResult, () => setResult("unreachable"));
  }, []);

  const answer =
    result === undefined
      ? strings.checking
      : result === "unreachable"
        ? strings.unreachable
        : result.ok
          ? strings.ok
          : strings.errors[result.code];

  return (
    <ScrollView
      className="flex-1 bg-bg"
      contentContainerClassName="px-4"
      contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 32 }}
    >
      <Text className="text-title-large font-semibold text-brand">{strings.title}</Text>
      <Link href="/account" asChild>
        <Pressable
          accessibilityRole="button"
          className="mt-4 min-h-12 items-center justify-center self-start rounded-button border border-border bg-surface px-4"
        >
          <Text className="text-secondary font-medium text-text">{strings.account.open}</Text>
        </Pressable>
      </Link>
      <AreaLine />
      <Text className="mt-6 text-secondary text-muted">{strings.health}</Text>
      <Text className="mt-1 text-body text-text">{answer}</Text>

      <Heading>{strings.review.sizes}</Heading>
      <Text className="mt-3 text-display font-semibold text-text">{strings.review.display}</Text>
      <Text className="text-title-large font-semibold text-text">{strings.review.titleLarge}</Text>
      <Text className="text-title font-semibold text-text">{strings.review.titleText}</Text>
      <Text className="text-headline font-semibold text-text">{strings.review.headline}</Text>
      <Text className="text-body text-text">{strings.review.body}</Text>
      <Text className="text-label font-medium text-text">{strings.review.label}</Text>
      <Text className="text-secondary text-muted">{strings.review.secondary}</Text>
      <Text className="text-small-label font-medium text-text">{strings.review.smallLabel}</Text>
      <Text className="text-caption text-muted">{strings.review.caption}</Text>

      <Heading>{strings.review.weights}</Heading>
      <Text className="mt-3 text-body font-normal text-text">{strings.review.regular}</Text>
      <Text className="text-body font-medium text-text">{strings.review.medium}</Text>
      <Text className="text-body font-semibold text-text">{strings.review.semibold}</Text>

      <Heading>{strings.review.formats}</Heading>
      <View className="mt-3 gap-1">
        <Text className="text-body tabular-nums text-text">{formatMoney(125000)}</Text>
        <Text className="text-body tabular-nums text-text">{formatMoney(-20)}</Text>
        <Text className="text-body tabular-nums text-text">{formatNumber(1234567)}</Text>
        <Text className="text-body tabular-nums text-text">{formatDate(now)}</Text>
        <Text className="text-body tabular-nums text-text">{formatTime(now)}</Text>
        <Text className="text-body tabular-nums text-text">{formatDateTime(now)}</Text>
      </View>

      <Heading>{strings.review.prices}</Heading>
      <View className="mt-3 self-start rounded-card border border-border bg-surface p-4">
        {prices.map((price) => (
          <Text key={price} className="text-right text-body tabular-nums text-text">
            {formatMoney(price)}
          </Text>
        ))}
      </View>

      <Heading>{strings.review.countdown}</Heading>
      <View className="mt-3">
        <Countdown />
      </View>

      <Heading>{strings.review.tabs}</Heading>
      <View className="-mx-4 mt-3 flex-row border-y border-border bg-surface">
        {strings.review.tabLabels.map((label) => (
          <View key={label} className="min-h-12 flex-1 items-center justify-center">
            <Text numberOfLines={1} className="text-small-label font-medium text-text">
              {label}
            </Text>
          </View>
        ))}
      </View>

      <Heading>{strings.review.hindi}</Heading>
      <View className="mt-3 rounded-card border border-border bg-surface p-4">
        <Text className="text-body text-text">{strings.review.hindiSample}</Text>
        <Text className="text-secondary text-muted">{strings.review.hindiSample}</Text>
      </View>
    </ScrollView>
  );
}
