import { AddressLabel, AddressPoint } from "@ygo/contracts";
import { Button, edgeClass, FieldMessage, Text, useSession } from "@ygo/mobile";
import { PinMap, type PinMapHandle } from "@ygo/mobile/pin-map";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, session } from "../api";
import { MapPin } from "../components/icons";
import { TopBar } from "../components/top-bar";
import { askArea, newestOnly, type Place, stale, typedPlace } from "../lib/location-flow";
import { goHome } from "../lib/go-home";
import {
  addressBody,
  type Confirmed,
  confirmAddress,
  newSession,
  type PinView,
  pincodePoint,
  pinSpot,
  type PlaceTrouble,
} from "../lib/map-place";
import { phoneGeocoder } from "../lib/phone-geocoder";
import { savePlace } from "../lib/saved-place";
import { strings } from "../strings";

const words = strings.confirm;

/** "Flat, house or floor" broke the rule, or Confirm failed and stays open (#242, review of #249). */
type Problem = "flat" | Exclude<Confirmed, { kind: "done" }>;

/** Where the map opens for a typed pincode: still looking, found, or why not (#373). */
type Lookup = { kind: "looking" } | { kind: "found"; point: AddressPoint } | { kind: "failed"; why: PlaceTrouble | "not-found" };

const lookupFailed = {
  offline: words.mapOffline,
  "too-many": strings.location.tooManySearches,
  unavailable: words.mapDown,
  "not-found": words.pincodeNotFound,
} satisfies Record<Extract<Lookup, { kind: "failed" }>["why"], string>;

/**
 * C15's Confirm location (#242): the map moves under a pin fixed in the
 * middle, and the pincode is read from the spot under it. Opened with a typed
 * pincode (Android with location refused), the map opens at that pincode and
 * the pincode stays as typed, as the phone can't read the spot then (#373,
 * owner's answers 1–5). Opened for a saved address with no pin, it shows that
 * address's flat and label and puts the pin on it (answer 6).
 */
export default function ConfirmLocation() {
  const insets = useSafeAreaInsets();
  const state = useSession(session);
  const navigation = useNavigation();
  const params = useLocalSearchParams<{
    latitude?: string;
    longitude?: string;
    pincode?: string;
    addressId?: string;
    flat?: string;
    label?: string;
  }>();
  const [start] = useState(() => {
    const point = AddressPoint.safeParse({ latitude: Number(params.latitude), longitude: Number(params.longitude) });
    return point.success ? point.data : null;
  });
  const [typed] = useState(() => typedPlace(params.pincode ?? ""));
  const [saved] = useState(() => {
    const label = AddressLabel.safeParse(params.label);
    return params.addressId && label.success ? { id: params.addressId, flat: params.flat ?? "", label: label.data } : null;
  });
  const [lookup, setLookup] = useState<Lookup>({ kind: "looking" });
  const [looks] = useState(newestOnly);
  const map = useRef<PinMapHandle>(null);
  const [view, setView] = useState<PinView>({ reading: start !== null, spot: null });
  const [pin] = useState(() => pinSpot(phoneGeocoder, setView));
  const [flat, setFlat] = useState("");
  const [focused, setFocused] = useState(false);
  const [label, setLabel] = useState<AddressLabel>("home");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  // Set before React re-renders, so a second tap never saves twice.
  const working = useRef(false);
  const [saves] = useState(newestOnly);

  // Leaving drops any answer still on its way (#216, Q3).
  useEffect(
    () => () => {
      pin.leave();
      saves.drop();
      looks.drop();
    },
    [pin, saves, looks],
  );

  /** Finds where the map opens for the typed pincode, in a Google session of its own. */
  function look() {
    if (!typed) return;
    setLookup({ kind: "looking" });
    void looks.ask(pincodePoint(api, typed.pincode, newSession())).then((found) => {
      if (found === stale) return;
      setLookup(typeof found === "string" ? { kind: "failed", why: found } : { kind: "found", point: found });
    });
  }

  /** The map stopped at a new spot: read it, and drop an old save failure, which was for the last spot. */
  function moved(point: AddressPoint) {
    pin.moved(point);
    setProblem((now) => (now === "flat" ? now : null));
  }

  useEffect(() => {
    if (start) pin.open(start);
    else look();
  }, []);

  // The gate shows the app only when signed in; this tells TypeScript.
  if (state.status !== "signed-in") return null;
  const accountId = state.account.id;
  const mapStart = start ?? (lookup.kind === "found" ? lookup.point : null);
  const place = start ? (view.reading ? null : view.spot?.place ?? null) : lookup.kind === "found" ? typed : null;

  /** The place to save at the moment of the tap; a typed pincode takes the spot under the pin right now. */
  async function placeNow(): Promise<Place | null> {
    // Asked at the tap, not taken from the last render, so a tap as the map starts moving saves nothing (#339).
    if (start) return pin.place();
    return typed && map.current ? { ...typed, point: await map.current.spot() } : null;
  }

  async function confirm() {
    if (working.current || !place) return;
    working.current = true;
    const now = await placeNow();
    const body = now && addressBody(now, saved?.label ?? label, saved?.flat ?? flat);
    if (!now || !body) {
      working.current = false;
      if (now) setProblem("flat");
      return;
    }
    setProblem(null);
    setSaving(true);
    const done = await saves.ask(
      confirmAddress(
        {
          askArea: (pincode) => askArea(api, pincode),
          // A saved address with no pin gets the pin, so no second address is made (#373, answer 6).
          saveAddress: (address) => (saved && address.point ? api.pinAddress(saved.id, { point: address.point }) : api.saveAddress(address)),
          keep: (kept) => savePlace(accountId, kept),
        },
        now,
        body,
      ),
    );
    if (done === stale) return;
    working.current = false;
    setSaving(false);
    // Any failure stays here with its message; nothing is chosen and nothing retries by itself.
    if (done.kind === "done") return goHome(navigation);
    setProblem(done);
  }

  const message =
    problem === null
      ? null
      : problem === "flat"
        ? words.flatInvalid
        : problem.kind === "not-saved"
          ? words.notSaved
          : problem.kind === "offline"
            ? words.offline
            : strings.errors[problem.code];

  return (
    // Padding on Android too: edge to edge, the window no longer shrinks for the keyboard.
    <KeyboardAvoidingView behavior="padding" className="flex-1 bg-bg" style={{ paddingTop: insets.top }}>
      <TopBar title={words.title} />

      {mapStart ? (
        // Held still while saving, so the spot on screen is the one being saved.
        <PinMap
          ref={map}
          className="h-[45%]"
          start={mapStart}
          onMoved={start ? moved : undefined}
          onMoving={start ? pin.moving : undefined}
          locked={saving}
          pin={<MapPin size={40} className="mb-10 text-primary" />}
        />
      ) : (
        typed && <View className="h-[45%] bg-sunken" />
      )}

      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-4 px-4 pt-4"
        contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
      >
        <View className="min-h-12 justify-center">
          {(start ? view.reading : lookup.kind === "looking") ? (
            <View className="flex-row items-center gap-2">
              <ActivityIndicator className="text-primary" />
              <Text className="text-body text-muted">{start ? words.reading : words.findingPincode}</Text>
            </View>
          ) : !start && lookup.kind === "failed" ? (
            <View className="items-start">
              <FieldMessage text={lookupFailed[lookup.why]} />
              <Button label={words.retry} onPress={look} variant="text" />
            </View>
          ) : !start && place ? (
            <>
              <Text className="text-body font-semibold text-text">{place.pincode}</Text>
              <Text className="text-secondary text-muted">{words.moveHint}</Text>
            </>
          ) : place ? (
            <>
              <Text className="text-body font-semibold text-text">{view.spot?.title ?? place.pincode}</Text>
              {view.spot && <Text className="text-secondary text-muted">{view.spot.detail}</Text>}
            </>
          ) : (
            <FieldMessage text={words.noPincode} />
          )}
        </View>

        {saved ? (
          <View>
            <Text className="text-label font-medium text-text">{words[saved.label]}</Text>
            <Text className="text-body text-text">{saved.flat}</Text>
          </View>
        ) : (
          <>
            <View>
              <Text className="text-label font-medium text-text">{words.flatLabel}</Text>
              <TextInput
                value={flat}
                onChangeText={(next) => {
                  setFlat(next);
                  setProblem(null);
                }}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                editable={!saving}
                maxLength={100}
                autoComplete="street-address"
                textContentType="streetAddressLine1"
                accessibilityLabel={words.flatLabel}
                className={`mt-2 h-[52px] rounded-input bg-surface px-4 font-sans text-body text-text ${edgeClass(problem === "flat", focused)}`}
              />
              {problem === "flat" && message && <FieldMessage text={message} />}
            </View>

            <LabelPicker value={label} onChange={setLabel} disabled={saving} />
          </>
        )}

        {/* A saved address's flat has no field, so a flat that breaks today's rule shows here. */}
        {problem !== null && (problem !== "flat" || saved) && message && <FieldMessage text={message} />}

        <Button
          label={saving ? words.saving : words.confirm}
          onPress={() => void confirm()}
          disabled={saving || !place}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const labels: AddressLabel[] = ["home", "work", "other"];

/** "Save as" over Home / Work / Other, Home first chosen (#242, Q8). A new Home or Work replaces the old one on the server. */
function LabelPicker({
  value,
  onChange,
  disabled,
}: {
  value: AddressLabel;
  onChange: (label: AddressLabel) => void;
  disabled: boolean;
}) {
  return (
    <View className="gap-1.5">
      <Text className="text-label font-medium text-text">{words.labelLabel}</Text>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={words.labelLabel}
        className="flex-row overflow-hidden rounded-button border border-border-strong"
      >
        {labels.map((choice, i) => (
          <Pressable
            key={choice}
            accessibilityRole="radio"
            accessibilityState={{ checked: value === choice, disabled }}
            disabled={disabled}
            onPress={() => onChange(choice)}
            className={`min-h-12 flex-1 items-center justify-center ${i > 0 ? "border-l border-border" : ""} ${
              value === choice ? "bg-primary-subtle" : "bg-surface"
            }`}
          >
            <Text className={`text-label font-medium ${value === choice ? "text-on-primary-subtle" : "text-text"}`}>
              {words[choice]}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
