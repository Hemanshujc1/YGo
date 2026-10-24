import { type AddressLabel, AddressPoint } from "@ygo/contracts";
import { Button, edgeClass, FieldMessage, Text, useSession } from "@ygo/mobile";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { cssInterop } from "nativewind";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, TextInput, View } from "react-native";
import MapView from "react-native-maps";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, session } from "../api";
import { MapPin } from "../components/icons";
import { TopBar } from "../components/top-bar";
import { askArea, newestOnly, stale, typedPlace } from "../lib/location-flow";
import { addressBody, type Confirmed, confirmAddress, readPin, type Spot } from "../lib/map-place";
import { goHome } from "../lib/go-home";
import { phoneGeocoder } from "../lib/phone-geocoder";
import { savePlace } from "../lib/saved-place";
import { strings } from "../strings";

cssInterop(MapView, { className: "style" });

const words = strings.confirm;

// Street level when the map opens (#242, Q6).
const streetLevel = { latitudeDelta: 0.004, longitudeDelta: 0.004 };

// The phone's geocoder limits how often an app may ask, so a read waits until the map has rested this long.
const settle = 600;

/** "Flat, house or floor" broke the rule, or Confirm failed and stays open (#242, review of #249). */
type Problem = "flat" | Exclude<Confirmed, { kind: "done" }>;

/**
 * C15's Confirm location (#242): the map moves under a pin fixed in the
 * middle, and the pincode is read from the spot under it. Opened with a typed
 * pincode (Android with location refused), it shows no map and saves no pin.
 */
export default function ConfirmLocation() {
  const insets = useSafeAreaInsets();
  const state = useSession(session);
  const navigation = useNavigation();
  const params = useLocalSearchParams<{ latitude?: string; longitude?: string; pincode?: string }>();
  const [start] = useState(() => {
    const point = AddressPoint.safeParse({ latitude: Number(params.latitude), longitude: Number(params.longitude) });
    return point.success ? point.data : null;
  });
  const [typed] = useState(() => typedPlace(params.pincode ?? ""));
  const [spot, setSpot] = useState<Spot | null>(null);
  const [reading, setReading] = useState(start !== null);
  const [flat, setFlat] = useState("");
  const [focused, setFocused] = useState(false);
  const [label, setLabel] = useState<AddressLabel>("home");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  // Set before React re-renders, so a second tap never saves twice.
  const working = useRef(false);
  const [reads] = useState(newestOnly);
  const [saves] = useState(newestOnly);
  const wait = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The spot last read: Android reports the opening region too, which needs no second read.
  const last = useRef(start);

  // Leaving drops any answer still on its way (#216, Q3).
  useEffect(
    () => () => {
      clearTimeout(wait.current);
      reads.drop();
      saves.drop();
    },
    [reads, saves],
  );

  /** Reads the spot under the pin; only the newest read counts, as the map may stop again before one lands. */
  async function read(point: AddressPoint) {
    setReading(true);
    const found = await reads.ask(readPin(phoneGeocoder, point));
    if (found === stale) return;
    setSpot(found);
    setReading(false);
  }

  /** The map stopped at a new spot: read it once the map has rested, and drop an old save failure, which was for the last spot. */
  function moved(point: AddressPoint) {
    const before = last.current;
    if (before && Math.abs(before.latitude - point.latitude) < 1e-6 && Math.abs(before.longitude - point.longitude) < 1e-6) return;
    last.current = point;
    clearTimeout(wait.current);
    reads.drop();
    setReading(true);
    setProblem((now) => (now === "flat" ? now : null));
    wait.current = setTimeout(() => void read(point), settle);
  }

  // The first spot, read once when the screen opens, before the map reports where it stopped.
  useEffect(() => {
    if (start) void read(start);
  }, []);

  // The gate shows the app only when signed in; this tells TypeScript.
  if (state.status !== "signed-in") return null;
  const accountId = state.account.id;
  const place = start ? (reading ? null : spot?.place ?? null) : typed;

  async function confirm() {
    if (working.current || !place) return;
    const body = addressBody(place, label, flat);
    if (!body) return setProblem("flat");
    working.current = true;
    setProblem(null);
    setSaving(true);
    const done = await saves.ask(
      confirmAddress(
        {
          askArea: (pincode) => askArea(api, pincode),
          saveAddress: (address) => api.saveAddress(address),
          keep: (kept) => savePlace(accountId, kept),
        },
        place,
        body,
      ),
    );
    if (done === stale) return;
    working.current = false;
    setSaving(false);
    // Any failure stays here with its message; nothing is chosen and nothing retries by itself.
    if (done.kind === "done") return goHome(navigation.getState()?.routes[0]?.name);
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

      {start && (
        <View className="h-[45%]">
          <MapView
            className="flex-1"
            initialRegion={{ ...start, ...streetLevel }}
            onRegionChangeComplete={({ latitude, longitude }) => moved({ latitude, longitude })}
            // Held still while saving, so the spot on screen is the one being saved.
            scrollEnabled={!saving}
            zoomEnabled={!saving}
            rotateEnabled={!saving}
            pitchEnabled={!saving}
            toolbarEnabled={false}
          />
          {/* The pin stays in the middle and its point marks the spot (#242, Q6). */}
          <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
            <MapPin size={40} className="mb-10 text-primary" />
          </View>
        </View>
      )}

      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-4 px-4 pt-4"
        contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
      >
        <View className="min-h-12 justify-center">
          {start && reading ? (
            <View className="flex-row items-center gap-2">
              <ActivityIndicator className="text-primary" />
              <Text className="text-body text-muted">{words.reading}</Text>
            </View>
          ) : place ? (
            <>
              <Text className="text-body font-semibold text-text">{spot?.title ?? place.pincode}</Text>
              {spot && <Text className="text-secondary text-muted">{spot.detail}</Text>}
            </>
          ) : (
            <FieldMessage text={words.noPincode} />
          )}
        </View>

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

        {problem !== null && problem !== "flat" && message && <FieldMessage text={message} />}

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
