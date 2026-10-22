import { Button, edgeClass, FieldMessage, Text, useSession } from "@ygo/mobile";
import * as Location from "expo-location";
import { router, useNavigation } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, KeyboardAvoidingView, Linking, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, session } from "../api";
import { MapPin } from "../components/icons";
import { TopBar } from "../components/top-bar";
import {
  askArea,
  type AreaAnswer,
  findPlace,
  type Locator,
  newestOnly,
  type Place,
  stale,
  typedPlace,
} from "../lib/location-flow";
import { savePlace } from "../lib/saved-place";
import { strings } from "../strings";

const words = strings.location;

// While the app is in use only (#216, Q4); the phone's own lookup turns the position into an address, with no map key.
const locator: Locator = {
  askPermission: async () => (await Location.requestForegroundPermissionsAsync()).granted,
  servicesOn: () => Location.hasServicesEnabledAsync(),
  addresses: async () => {
    const { coords } = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    return Location.reverseGeocodeAsync(coords);
  },
};

/** What C15 shows under the field: the pincode broke the rule, a lookup or save failed, or no answer came. */
type Problem = "invalid" | "not-found" | "phone-off" | "not-saved" | Exclude<AreaAnswer, { kind: "served" | "not-served" }>;

/** C15 Set location (#216): the phone's current location, or a typed pincode. */
export default function SetLocation() {
  const insets = useSafeAreaInsets();
  const state = useSession(session);
  const [finding, setFinding] = useState(false);
  const [locationOff, setLocationOff] = useState(false);
  const [pincode, setPincode] = useState("");
  const [focused, setFocused] = useState(false);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  // Set before React re-renders, so a second tap never asks twice.
  const working = useRef(false);
  const [asks] = useState(newestOnly);
  const navigation = useNavigation();

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

  // The gate shows the app only when signed in; this tells TypeScript.
  if (state.status !== "signed-in") return null;
  const accountId = state.account.id;

  /**
   * Back to Home alone on the stack, so Back never returns to an old
   * location. Home asks about the new place and shows it, or C03.
   */
  function goHome() {
    const homeFirst = navigation.getState()?.routes[0]?.name === "index";
    if (router.canDismiss()) router.dismissAll();
    if (!homeFirst) router.replace("/");
  }

  /** Asks the server about the place and saves it for this account, then goes Home. */
  async function choose(place: Place) {
    setChecking(true);
    const answer = await asks.ask(askArea(api, place.pincode));
    if (answer === stale) return;
    if (answer.kind === "served" || answer.kind === "not-served") {
      try {
        await savePlace(accountId, place);
      } catch {
        return stop("not-saved");
      }
      return goHome();
    }
    stop(answer);
  }

  function stop(next: Problem | null) {
    working.current = false;
    setFinding(false);
    setChecking(false);
    setProblem(next);
  }

  async function useCurrent() {
    if (working.current) return;
    working.current = true;
    setProblem(null);
    setFinding(true);
    const found = await asks.ask(findPlace(locator));
    if (found === stale) return;
    if (found.kind === "found") return choose(found.place);
    setLocationOff(found.kind === "off");
    stop(found.kind === "off" ? null : found.kind);
  }

  async function submit() {
    if (working.current) return;
    const place = typedPlace(pincode);
    if (!place) return setProblem("invalid");
    working.current = true;
    setProblem(null);
    await choose(place);
  }

  const message =
    problem === null
      ? null
      : problem === "invalid"
        ? words.pincodeInvalid
        : problem === "not-found"
          ? words.notFound
          : problem === "phone-off"
            ? words.phoneOff
            : problem === "not-saved"
            ? words.notSaved
            : problem.kind === "offline"
              ? words.offline
              : strings.errors[problem.code];

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
                  <Text className="text-secondary text-on-warning-subtle">{words.offBody}</Text>
                </View>
              </View>
              <Button label={words.openSettings} onPress={() => void Linking.openSettings()} variant="secondary" />
            </>
          ) : (
            <Button
              label={words.useCurrent}
              onPress={() => void useCurrent()}
              disabled={checking}
              variant="secondary"
              icon={MapPin}
              alignStart
            />
          )}

          <View>
            <Text className="text-label font-medium text-text">{words.pincodeLabel}</Text>
            <TextInput
              value={pincode}
              onChangeText={(text) => {
                setPincode(text);
                setProblem(null);
              }}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onSubmitEditing={() => void submit()}
              editable={!checking}
              keyboardType="number-pad"
              textContentType="postalCode"
              autoComplete="postal-code"
              maxLength={7}
              returnKeyType="done"
              accessibilityLabel={words.pincodeLabel}
              className={`mt-2 h-[52px] rounded-input bg-surface px-4 font-sans text-body tabular-nums text-text ${edgeClass(problem === "invalid", focused)}`}
            />
            {message && <FieldMessage text={message} />}
          </View>

          <Button
            label={checking ? words.checking : words.continue}
            onPress={() => void submit()}
            disabled={checking}
          />
        </ScrollView>
      )}
    </KeyboardAvoidingView>
  );
}
