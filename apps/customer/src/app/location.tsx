import { Button, edgeClass, FieldMessage, findPlace, type Locator, Text, useSession } from "@ygo/mobile";
import type { AddressLabel, AddressPoint, PlaceMatch, SavedAddress } from "@ygo/contracts";
import * as Location from "expo-location";
import { router, useFocusEffect, useNavigation } from "expo-router";
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
import { api, session } from "../api";
import { Briefcase, House, MapPin, Search } from "../components/icons";
import { TopBar } from "../components/top-bar";
import { goHome } from "../lib/go-home";
import { newestOnly, refusedSearch, stale } from "../lib/location-flow";
import { newSession, pickPlace, type PlaceTrouble, searchPlaces } from "../lib/map-place";
import {
  addressLine,
  afterLoad,
  chooseAddress,
  loadAddresses,
  removeSaved,
  type SavedList,
  withoutAddress,
} from "../lib/saved-addresses";
import { savePlace } from "../lib/saved-place";
import { strings } from "../strings";

const words = strings.location;

// While the app is in use only (#216, Q4).
const locator: Locator = {
  askPermission: async () => (await Location.requestForegroundPermissionsAsync()).granted,
  servicesOn: () => Location.hasServicesEnabledAsync(),
  position: async () => (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })).coords,
};

// A saved row's icon; its title is Confirm's word for the label (#243, Q2).
const labelIcon = { home: House, work: Briefcase, other: MapPin } satisfies Record<AddressLabel, unknown>;

/** What C15 shows under the field: a lookup found nothing, a typed pincode broke the rule, or the place search failed (#257). */
type Problem = "invalid" | "not-found" | "phone-off" | "no-results" | PlaceTrouble | "gone";

/**
 * C15 Set location (#216, #242, #243): the phone's current location or a
 * search, each ending on Confirm location; or a saved address, which goes
 * straight Home.
 */
export default function SetLocation() {
  const insets = useSafeAreaInsets();
  const state = useSession(session);
  const navigation = useNavigation();
  const [finding, setFinding] = useState(false);
  const [locationOff, setLocationOff] = useState(false);
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [searching, setSearching] = useState(false);
  // The matches with the Google session that found them; a tapped match ends that session (#257, Q5).
  const [results, setResults] = useState<{ session: string; matches: PlaceMatch[] }>({ session: "", matches: [] });
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

  const [saved, setSaved] = useState<SavedList>({ kind: "loading" });
  const [loads, setLoads] = useState(0);
  const [lists] = useState(newestOnly);
  const [removing, setRemoving] = useState<string | null>(null);
  const [notRemoved, setNotRemoved] = useState<string | null>(null);
  const [notChosen, setNotChosen] = useState(false);
  // Set before React re-renders, so one Remove runs at a time.
  const removingNow = useRef(false);

  // Loaded each time C15 shows (#243, Q5). A list already shown stays while it reloads, and if the reload fails.
  useFocusEffect(
    useCallback(() => {
      setNotChosen(false);
      setSaved((current) => (current.kind === "loaded" ? current : { kind: "loading" }));
      void lists.ask(loadAddresses(api)).then((found) => {
        if (found === stale) return;
        setSaved((current) => afterLoad(current, found));
      });
      return lists.drop;
    }, [lists, loads]),
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
    setResults({ session: "", matches: [] });
    setSearching(true);
    const allowed = Platform.OS === "ios" || (!locationOff && (await asks.ask(locator.askPermission().catch(() => false))));
    if (allowed === stale) return;
    if (!allowed) {
      const refused = refusedSearch(text, locationOff);
      setText(refused.text);
      setLocationOff(true);
      stop(refused.invalid ? "invalid" : null);
      if (refused.place) openConfirm({ pincode: refused.place.pincode });
      return;
    }
    const session = newSession();
    const found = await asks.ask(searchPlaces(api, text, session));
    if (found === stale) return;
    if (typeof found === "string") return stop(found);
    setResults({ session, matches: found });
    stop(found.length ? null : "no-results");
  }

  /** A tapped match: its point from Google, then Confirm opens there and reads the pincode (#257, Q6). */
  async function pick(match: PlaceMatch) {
    if (working.current || leaving.current) return;
    working.current = true;
    setProblem(null);
    setSearching(true);
    const found = await asks.ask(pickPlace(api, match.id, results.session));
    if (found === stale) return;
    if (typeof found === "string") return stop(found);
    stop(null);
    confirmAt(found);
  }

  /** A saved row becomes the chosen place and Home checks it, with no Confirm (#243, Q3). */
  async function choose(address: SavedAddress) {
    if (leaving.current || state.status !== "signed-in") return;
    const accountId = state.account.id;
    leaving.current = true;
    setNotChosen(false);
    const done = await chooseAddress((place) => savePlace(accountId, place), address);
    if (done === "done") return goHome(navigation);
    leaving.current = false;
    setNotChosen(true);
  }

  /**
   * Removes at once, with no confirm and no retry (#243, Q4). The phone's
   * chosen place stays. Not while a row is being chosen, so the place going
   * Home is never one just removed.
   */
  async function remove(id: string) {
    if (removingNow.current || leaving.current) return;
    removingNow.current = true;
    setNotRemoved(null);
    setNotChosen(false);
    setRemoving(id);
    const done = await removeSaved(api, id);
    removingNow.current = false;
    setRemoving(null);
    if (done === "failed") return setNotRemoved(id);
    // A reload still on its way was asked before the remove and would bring the row back.
    lists.drop();
    setSaved((current) => withoutAddress(current, id));
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
            : problem === "offline"
              ? words.searchOffline
              : problem === "too-many"
                ? words.tooManySearches
                : problem === "unavailable"
                  ? words.searchDown
                  : problem === "gone"
                    ? words.placeGone
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

          {results.matches.length > 0 && (
            <View className="overflow-hidden rounded-card border border-border bg-surface">
              {results.matches.map((match, i) => (
                <Pressable
                  key={match.id}
                  accessibilityRole="button"
                  disabled={searching}
                  onPress={() => void pick(match)}
                  className={`min-h-14 flex-row items-center gap-3 px-4 py-3 active:bg-primary-subtle ${i > 0 ? "border-t border-border" : ""}`}
                >
                  <MapPin size={20} className="text-muted" />
                  <View className="flex-1">
                    <Text className="text-body font-medium text-text">{match.title}</Text>
                    {match.detail !== "" && <Text className="text-secondary text-muted">{match.detail}</Text>}
                  </View>
                </Pressable>
              ))}
            </View>
          )}

          {(saved.kind !== "loaded" || saved.addresses.length > 0) && (
            <View className="gap-2">
              {/* The heading waits for the list, so an account with none never shows it (#243, Q5). */}
              {saved.kind === "loaded" && (
                <Text accessibilityRole="header" className="text-label font-semibold text-text">
                  {words.savedTitle}
                </Text>
              )}
              {saved.kind === "loading" ? (
                <View className="min-h-12 flex-row items-center gap-2">
                  <ActivityIndicator className="text-primary" />
                  <Text className="text-body text-muted">{words.savedLoading}</Text>
                </View>
              ) : saved.kind === "failed" ? (
                <View className="items-start">
                  <Text className="text-body text-muted">{words.savedFailed}</Text>
                  <Button label={words.savedRetry} onPress={() => setLoads((n) => n + 1)} variant="text" />
                </View>
              ) : (
                <View className="overflow-hidden rounded-card border border-border bg-surface">
                  {saved.addresses.map((address, i) => {
                    const Icon = labelIcon[address.label];
                    const title = strings.confirm[address.label];
                    const line = addressLine(address);
                    const busy = removing === address.id;
                    return (
                      <View key={address.id} className={i > 0 ? "border-t border-border" : ""}>
                        <View className="min-h-14 flex-row items-center">
                          <Pressable
                            accessibilityRole="button"
                            accessibilityState={{ disabled: busy }}
                            disabled={busy}
                            onPress={() => void choose(address)}
                            className="flex-1 flex-row items-center gap-3 py-3 pl-4 pr-2 active:bg-primary-subtle"
                          >
                            <Icon size={20} className="text-muted" />
                            <View className="flex-1">
                              <Text className="text-body font-medium text-text">{title}</Text>
                              <Text className="text-secondary text-muted">{line}</Text>
                            </View>
                          </Pressable>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={words.removeLabel(`${title}, ${line}`)}
                            accessibilityState={{ disabled: removing !== null, busy }}
                            disabled={removing !== null}
                            onPress={() => void remove(address.id)}
                            className="min-h-12 justify-center px-4 active:bg-danger-subtle"
                          >
                            {busy ? (
                              <ActivityIndicator className="text-danger" />
                            ) : (
                              <Text className={`text-label font-medium ${removing ? "text-disabled-text" : "text-danger"}`}>
                                {words.remove}
                              </Text>
                            )}
                          </Pressable>
                        </View>
                        {notRemoved === address.id && (
                          <View className="px-4 pb-3">
                            <FieldMessage text={words.notRemoved} />
                          </View>
                        )}
                      </View>
                    );
                  })}
                </View>
              )}
              {notChosen && <FieldMessage text={strings.confirm.notSaved} />}
            </View>
          )}
        </ScrollView>
      )}
    </KeyboardAvoidingView>
  );
}
