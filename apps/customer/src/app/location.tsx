import { Button, edgeClass, FieldMessage, Text } from "@ygo/mobile";
import type { AddressPoint } from "@ygo/contracts";
import * as Location from "expo-location";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MapPin, Search } from "../components/icons";
import { TopBar } from "../components/top-bar";
import { findPlace, type Locator, newestOnly, stale, typedPlace } from "../lib/location-flow";
import { searchPlaces, type Spot } from "../lib/map-place";
import { phoneGeocoder } from "../lib/phone-geocoder";
import { strings } from "../strings";

const words = strings.location;

// While the app is in use only (#216, Q4).
const locator: Locator = {
  askPermission: async () => (await Location.requestForegroundPermissionsAsync()).granted,
  servicesOn: () => Location.hasServicesEnabledAsync(),
  position: async () => (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })).coords,
};

/** What C15 shows under the field: a lookup found nothing, or a typed pincode broke the rule. */
type Problem = "invalid" | "not-found" | "phone-off" | "no-results";

/** C15 Set location (#216, #242): the phone's current location, or a search; each ends on Confirm location. */
export default function SetLocation() {
  const insets = useSafeAreaInsets();
  const [finding, setFinding] = useState(false);
  const [locationOff, setLocationOff] = useState(false);
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<Spot[]>([]);
  const [problem, setProblem] = useState<Problem | null>(null);
  // Set before React re-renders, so a second tap never asks twice.
  const working = useRef(false);
  const [asks] = useState(newestOnly);
  // Set when Confirm opens, cleared back on C15, so a double tap opens one Confirm.
  const leaving = useRef(false);
  useFocusEffect(
    useCallback(() => {
      leaving.current = false;
    }, []),
  );

  // Leaving drops any answer still on its way (#216, Q3).
  useEffect(() => asks.drop, [asks]);

  // Back from the phone's settings with location allowed: offer it again.
  useEffect(() => {
    if (!locationOff) return;
    const listener = AppState.addEventListener("change", (next) => {
      if (next !== "active") return;
      void Location.getForegroundPermissionsAsync().then(({ granted }) => granted && setLocationOff(false));
    });
    return () => listener.remove();
  }, [locationOff]);

  // Android looks places up only with location allowed, so with it refused the field takes a pincode (#217, answer 6).
  const pincodeOnly = Platform.OS === "android" && locationOff;

  /** Opens Confirm location over C15, so Back returns to the results (#242, Q5). */
  function openConfirm(params: { latitude: string; longitude: string } | { pincode: string }) {
    if (leaving.current) return;
    leaving.current = true;
    router.push({ pathname: "/confirm-location", params });
  }

  const confirmAt = (point: AddressPoint) =>
    openConfirm({ latitude: String(point.latitude), longitude: String(point.longitude) });

  function stop(next: Problem | null) {
    working.current = false;
    setFinding(false);
    setSearching(false);
    setProblem(next);
  }

  async function useCurrent() {
    if (working.current) return;
    working.current = true;
    setProblem(null);
    setFinding(true);
    const found = await asks.ask(findPlace(locator));
    if (found === stale) return;
    setLocationOff(found.kind === "off");
    stop(found.kind === "found" || found.kind === "off" ? null : found.kind);
    if (found.kind === "found") confirmAt(found.point);
  }

  async function search() {
    if (working.current || !text.trim()) return;
    working.current = true;
    setProblem(null);
    setResults([]);
    setSearching(true);
    const allowed = Platform.OS === "ios" || (!locationOff && (await asks.ask(locator.askPermission().catch(() => false))));
    if (allowed === stale) return;
    if (!allowed) {
      setLocationOff(true);
      const place = typedPlace(text);
      // Just refused: the field turns into Pincode and the notice asks for one, so no error yet for a place name.
      stop(place || !locationOff ? null : "invalid");
      if (place) openConfirm({ pincode: place.pincode });
      return;
    }
    const found = await asks.ask(searchPlaces(phoneGeocoder, text));
    if (found === stale) return;
    setResults(found);
    stop(found.length ? null : "no-results");
  }

  const message =
    problem === "invalid"
      ? words.pincodeInvalid
      : problem === "not-found"
        ? words.notFound
        : problem === "phone-off"
          ? words.phoneOff
          : problem === "no-results"
            ? words.noResults
            : null;
  const label = pincodeOnly ? words.pincodeLabel : words.searchLabel;

  return (
    // Padding on Android too: edge to edge, the window no longer shrinks for the keyboard.
    <KeyboardAvoidingView behavior="padding" className="flex-1 bg-bg" style={{ paddingTop: insets.top }}>
      <TopBar title={words.title} />

      {finding ? (
        <View className="gap-4 px-4 pt-2">
          <View className="h-[260px] items-center justify-center gap-1.5 rounded-card border border-border bg-sunken">
            <ActivityIndicator size="large" className="text-primary" />
            <Text className="text-secondary text-muted">{words.finding}</Text>
          </View>
          <View className="gap-2">
            <View className="h-4 w-[70%] rounded-lg bg-sunken" />
            <View className="h-3.5 w-1/2 rounded-lg bg-sunken" />
          </View>
        </View>
      ) : (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerClassName="gap-4 px-4 pt-2"
          contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
        >
          {locationOff ? (
            <>
              <View className="flex-row items-start gap-3 rounded-button bg-warning-subtle px-4 py-3">
                <MapPin size={20} className="mt-0.5 text-on-warning-subtle" />
                <View className="flex-1">
                  <Text className="text-body font-semibold text-on-warning-subtle">{words.offTitle}</Text>
                  <Text className="text-secondary text-on-warning-subtle">{Platform.OS === "android" ? words.offBody : words.offBodySearch}</Text>
                </View>
              </View>
              <Button label={words.openSettings} onPress={() => void Linking.openSettings()} variant="secondary" />
            </>
          ) : (
            <Button
              label={words.useCurrent}
              onPress={() => void useCurrent()}
              disabled={searching}
              variant="secondary"
              icon={MapPin}
              alignStart
            />
          )}

          <View>
            <Text className="text-label font-medium text-text">{label}</Text>
            <TextInput
              value={text}
              onChangeText={(next) => {
                setText(next);
                setProblem(null);
              }}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onSubmitEditing={() => void search()}
              editable={!searching}
              keyboardType={pincodeOnly ? "number-pad" : "default"}
              textContentType={pincodeOnly ? "postalCode" : "fullStreetAddress"}
              autoComplete={pincodeOnly ? "postal-code" : "street-address"}
              maxLength={pincodeOnly ? 7 : 100}
              returnKeyType="search"
              accessibilityLabel={label}
              className={`mt-2 h-[52px] rounded-input bg-surface px-4 font-sans text-body text-text ${edgeClass(problem === "invalid", focused)}`}
            />
            {message && <FieldMessage text={message} />}
          </View>

          <Button
            label={searching ? words.searching : words.search}
            onPress={() => void search()}
            disabled={searching}
            icon={Search}
          />

          {results.length > 0 && (
            <View className="overflow-hidden rounded-card border border-border bg-surface">
              {results.map((spot, i) => (
                <Pressable
                  key={`${spot.title}\n${spot.detail}`}
                  accessibilityRole="button"
                  onPress={() => spot.place.point && confirmAt(spot.place.point)}
                  className={`min-h-14 flex-row items-center gap-3 px-4 py-3 active:bg-primary-subtle ${i > 0 ? "border-t border-border" : ""}`}
                >
                  <MapPin size={20} className="text-muted" />
                  <View className="flex-1">
                    <Text className="text-body font-medium text-text">{spot.title}</Text>
                    <Text className="text-secondary text-muted">{spot.detail}</Text>
                  </View>
                </Pressable>
              ))}
            </View>
          )}
        </ScrollView>
      )}
    </KeyboardAvoidingView>
  );
}
