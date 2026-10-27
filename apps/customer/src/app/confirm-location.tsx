import { type AddressLabel, AddressPoint } from "@ygo/contracts";
import { Button, edgeClass, FieldMessage, Text, useSession } from "@ygo/mobile";
import { PinMap } from "@ygo/mobile/pin-map";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, session } from "../api";
import { MapPin } from "../components/icons";
import { TopBar } from "../components/top-bar";
import { askArea, newestOnly, stale, typedPlace } from "../lib/location-flow";
import { goHome } from "../lib/go-home";
import { addressBody, type Confirmed, confirmAddress, type PinView, pinSpot } from "../lib/map-place";
import { phoneGeocoder } from "../lib/phone-geocoder";
import { savePlace } from "../lib/saved-place";
import { strings } from "../strings";

const words = strings.confirm;

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
    },
    [pin, saves],
  );

  /** The map stopped at a new spot: read it, and drop an old save failure, which was for the last spot. */
  function moved(point: AddressPoint) {
    pin.moved(point);
    setProblem((now) => (now === "flat" ? now : null));
  }

  useEffect(() => {
    if (start) pin.open(start);
  }, []);

  // The gate shows the app only when signed in; this tells TypeScript.
  if (state.status !== "signed-in") return null;
  const accountId = state.account.id;
  const place = start ? (view.reading ? null : view.spot?.place ?? null) : typed;

  async function confirm() {
    // Asked at the tap, not taken from the last render, so a tap as the map starts moving saves nothing (#339).
    const now = start ? pin.place() : typed;
    if (working.current || !now) return;
    const body = addressBody(now, label, flat);
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

      {start && (
        // Held still while saving, so the spot on screen is the one being saved.
        <PinMap className="h-[45%]" start={start} onMoved={moved} onMoving={pin.moving} locked={saving} pin={<MapPin size={40} className="mb-10 text-primary" />} />
      )}

      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-4 px-4 pt-4"
        contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
      >
        <View className="min-h-12 justify-center">
          {start && view.reading ? (
            <View className="flex-row items-center gap-2">
              <ActivityIndicator className="text-primary" />
              <Text className="text-body text-muted">{words.reading}</Text>
            </View>
          ) : place ? (
            <>
              <Text className="text-body font-semibold text-text">{view.spot?.title ?? place.pincode}</Text>
              {view.spot && <Text className="text-secondary text-muted">{view.spot.detail}</Text>}
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
