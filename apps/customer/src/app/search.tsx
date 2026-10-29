import { Button, Text } from "@ygo/mobile";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../api";
import { Search as SearchIcon } from "../components/icons";
import { ShopCard } from "../components/shop-card";
import { TopBar } from "../components/top-bar";
import { newestOnly, stale } from "../lib/location-flow";
import { productLine, searchAnswer, searchDelay, searchMaxLength, type SearchState, searchText } from "../lib/search";
import { strings } from "../strings";

// C16 Search (#398, DSC-3): the shops Home lists that match by name or by a product, each opening C05.

type Params = { pincode: string; latitude: string; longitude: string };

const words = strings.search;

export default function Search() {
  const insets = useSafeAreaInsets();
  const { pincode, latitude, longitude } = useLocalSearchParams<Params>();
  const [typed, setTyped] = useState("");
  const [state, setState] = useState<SearchState>({ kind: "idle" });
  const [attempt, setAttempt] = useState(0);
  const [asks] = useState(newestOnly);
  const query = { pincode, latitude: Number(latitude), longitude: Number(longitude) };

  // Searches about 0.3 s after the last letter; only the newest answer shows (owner's answer 11 on #49).
  useEffect(() => {
    const text = searchText(typed);
    if (!text) {
      asks.drop();
      setState({ kind: "idle" });
      return;
    }
    const timer = setTimeout(() => {
      setState({ kind: "searching" });
      void (async () => {
        const answer = await asks.ask(api.search({ pincode, latitude: Number(latitude), longitude: Number(longitude), q: text }).catch(() => "offline" as const));
        if (answer !== stale) setState(searchAnswer(text, answer));
      })();
    }, searchDelay);
    return () => {
      clearTimeout(timer);
      asks.drop();
    };
  }, [typed, attempt, asks, pincode, latitude, longitude]);

  const now = Date.now();
  return (
    <View className="flex-1 bg-bg" style={{ paddingTop: insets.top }}>
      <TopBar title={words.title} />
      <View className="px-4 pb-2">
        <View className="h-[52px] flex-row items-center gap-3 rounded-full border border-border-strong bg-surface px-4">
          <SearchIcon className="text-muted" size={20} />
          <TextInput
            value={typed}
            onChangeText={setTyped}
            autoFocus
            maxLength={searchMaxLength}
            returnKeyType="search"
            autoCorrect={false}
            placeholder={words.box}
            accessibilityLabel={words.box}
            className="h-full flex-1 font-sans text-body text-text placeholder:text-muted"
          />
        </View>
      </View>
      <ScrollView contentContainerClassName="px-4" contentContainerStyle={{ paddingTop: 8, paddingBottom: insets.bottom + 32 }} keyboardShouldPersistTaps="handled">
        {state.kind === "idle" && <Text className="text-body text-muted">{words.hint}</Text>}
        {state.kind === "searching" && (
          <View className="min-h-12 flex-row items-center gap-2">
            <ActivityIndicator className="text-primary" />
            <Text className="text-body text-muted">{words.searching}</Text>
          </View>
        )}
        {state.kind === "none" && <Text className="text-body text-muted">{words.none(state.text)}</Text>}
        {state.kind === "failed" && (
          <View className="items-start">
            <Text className="text-body font-semibold text-text">{words.failed}</Text>
            <Text className="text-secondary text-muted">{state.message}</Text>
            <Button label={strings.area.retry} onPress={() => setAttempt((n) => n + 1)} variant="text" />
          </View>
        )}
        {state.kind === "results" && (
          <View className="gap-3">
            {state.shops.map((shop) => (
              <ShopCard key={shop.id} shop={shop} query={query} now={now}>
                {shop.products.length > 0 && (
                  <View className="mt-3 gap-1 border-t border-border pt-3">
                    {shop.products.map((product) => <Text key={product.id} className="text-body text-text">{productLine(product)}</Text>)}
                    {shop.moreProducts > 0 && <Text className="text-secondary text-muted">{words.more(shop.moreProducts)}</Text>}
                  </View>
                )}
              </ShopCard>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
