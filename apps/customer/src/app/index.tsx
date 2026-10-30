import type { ApiResult } from "@ygo/api-client";
import type { FeedQuery, FeedShop, HealthResponse } from "@ygo/contracts";
import { Button, Text, useSession } from "@ygo/mobile";
import { Link, router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, session } from "../api";
import { Search } from "../components/icons";
import { ShopCard } from "../components/shop-card";
import { feedQuery } from "../lib/feed";
import { askArea, type AreaAnswer, newestOnly, placeLabel, stale } from "../lib/location-flow";
import { savedPlace } from "../lib/saved-place";
import { strings } from "../strings";

// C04 Home (#369): the way to Account, where shops deliver (#216) and the shops
// that can serve that place, with the way into search (#398). The server's health stays until a status screen replaces it.

type AreaState =
  | { kind: "checking" }
  | { kind: "served"; label: string; query: FeedQuery | null }
  | { kind: "failed"; answer: Extract<AreaAnswer, { kind: "offline" | "error" }> };

/**
 * Where shops deliver, asked again each time Home opens (#216, Q3), and the
 * shops there: C15 when no place is saved, C03 when it isn't served. A place
 * with no pin asks for one instead of listing shops (owner's answer 12 on #47). Leaving Home, or another
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
        if (answer.kind === "served") setArea({ kind: "served", label: placeLabel({ ...place, name: answer.areaName }), query: feedQuery(place) });
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
    <>
      <View className="mt-4 items-start">
        <Text className="text-body tabular-nums text-text">{words.delivering(area.label)}</Text>
        <Button label={words.change} onPress={() => router.push("/location")} variant="text" />
      </View>
      {area.query ? (
        <>
          <SearchBox query={area.query} />
          <Shops query={area.query} />
        </>
      ) : (
        <Text className="mt-4 text-body text-muted">{strings.feed.noPin}</Text>
      )}
    </>
  );
}

type ShopsState = { kind: "loading" } | { kind: "loaded"; shops: FeedShop[] } | { kind: "failed"; message: string };

/** The shops that can serve `query`, nearest first, fetched again each time Home opens (DSC-1, DSC-2). */
function Shops({ query }: { query: FeedQuery }) {
  const [state, setState] = useState<ShopsState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    setState({ kind: "loading" });
    api.feed(query).then(
      (result) => current && setState(result.ok ? { kind: "loaded", shops: result.data.shops } : { kind: "failed", message: strings.errors[result.code] }),
      () => current && setState({ kind: "failed", message: strings.area.offline }),
    );
    return () => {
      current = false;
    };
  }, [query, attempt]);

  const words = strings.feed;
  if (state.kind === "loading") {
    return (
      <View className="mt-4 min-h-12 flex-row items-center gap-2">
        <ActivityIndicator className="text-primary" />
        <Text className="text-body text-muted">{words.loading}</Text>
      </View>
    );
  }
  if (state.kind === "failed") {
    return (
      <View className="mt-4 items-start">
        <Text className="text-body font-semibold text-text">{words.failed}</Text>
        <Text className="text-secondary text-muted">{state.message}</Text>
        <Button label={strings.area.retry} onPress={() => setAttempt((n) => n + 1)} variant="text" />
      </View>
    );
  }
  if (!state.shops.length) return <Text className="mt-4 text-body text-muted">{words.none}</Text>;
  const now = Date.now();
  return (
    <View className="mt-4 gap-3">
      {state.shops.map((shop) => <ShopCard key={shop.id} shop={shop} query={query} now={now} />)}
    </View>
  );
}

/** The way into C16 (#398), shown only while Home lists shops, as search needs the same place (owner's answer 4 on #398). */
function SearchBox({ query }: { query: FeedQuery }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={strings.search.box}
      onPress={() => router.push({ pathname: "/search", params: { pincode: query.pincode, latitude: String(query.latitude), longitude: String(query.longitude) } })}
      className="mt-4 h-[52px] flex-row items-center gap-3 rounded-full border border-border-strong bg-surface px-4 active:bg-primary-subtle"
    >
      <Search className="text-muted" size={20} />
      <Text className="text-body text-muted">{strings.search.box}</Text>
    </Pressable>
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
      {/* Orders sits beside Account until the tab bar (owner's answer 5 on #426). */}
      <View className="mt-4 flex-row gap-2">
        {([["/orders", strings.orders.open], ["/account", strings.account.open]] as const).map(([href, label]) => (
          <Link key={href} href={href} asChild>
            <Pressable
              accessibilityRole="button"
              className="min-h-12 items-center justify-center rounded-button border border-border bg-surface px-4"
            >
              <Text className="text-secondary font-medium text-text">{label}</Text>
            </Pressable>
          </Link>
        ))}
      </View>
      <AreaLine />
      <Text className="mt-6 text-secondary text-muted">{strings.health}</Text>
      <Text className="mt-1 text-body text-text">{answer}</Text>

    </ScrollView>
  );
}
