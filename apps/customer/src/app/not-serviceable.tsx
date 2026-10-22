import type { ErrorCode } from "@ygo/contracts";
import { formatPhone } from "@ygo/format";
import { Button, PhoneField, Text, useSession } from "@ygo/mobile";
import { router, useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import { KeyboardAvoidingView, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, session } from "../api";
import { ChevronDown, Map, MapPin } from "../components/icons";
import { joinOutcome, placeLabel, waitlistBody } from "../lib/location-flow";
import { strings } from "../strings";

const words = strings.notServiceable;

/** C03 Not serviceable yet (#216): the pincode is in no Area, or its Area is paused. */
export default function NotServiceable() {
  const insets = useSafeAreaInsets();
  const state = useSession(session);
  const { pincode = "", name } = useLocalSearchParams<{ pincode: string; name?: string }>();
  // The account's number as "98765 43210" (#216 issue); the box puts +91 before it.
  const [phone, setPhone] = useState(() => (state.status === "signed-in" ? formatPhone(state.account.phone ?? "") : ""));
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<"saved" | "invalid" | "offline" | ErrorCode | null>(null);
  // Set before React re-renders, so a second tap never sends twice.
  const working = useRef(false);

  const place = placeLabel(name ? { pincode, name } : { pincode });

  async function leaveNumber() {
    if (working.current) return;
    const body = waitlistBody(pincode, phone);
    if (!body) return setOutcome("invalid");
    working.current = true;
    setOutcome(null);
    setSaving(true);
    const next = await joinOutcome(() => api.joinWaitlist(body));
    working.current = false;
    setSaving(false);
    setOutcome(next);
  }

  const changeLocation = () => router.push("/location");
  const other = outcome === "saved" || outcome === "invalid" ? null : outcome;

  return (
    // Padding on Android too: edge to edge, the window no longer shrinks for the keyboard.
    <KeyboardAvoidingView behavior="padding" className="flex-1 bg-bg" style={{ paddingTop: insets.top }}>
      <View className="min-h-14 flex-row items-center gap-1 p-1">
        <Text className="px-3 text-title font-semibold text-brand">{strings.title}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={words.changeLabel(place)}
          onPress={changeLocation}
          className="min-h-12 flex-1 flex-row items-center gap-2 rounded-button px-4 active:bg-primary-subtle"
        >
          <MapPin size={20} className="text-text" />
          <Text numberOfLines={1} className="shrink text-secondary font-medium tabular-nums text-text">
            {place}
          </Text>
          <ChevronDown size={18} className="text-text" />
        </Pressable>
      </View>

      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-6 p-6"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      >
        <View className="items-center gap-3 pb-2 pt-6">
          <View className="size-[72px] items-center justify-center rounded-full bg-sunken">
            <Map size={32} className="text-muted" />
          </View>
          <Text accessibilityRole="header" className="text-title font-semibold text-text">
            {words.title}
          </Text>
          <Text className="text-center text-body text-muted">{words.body(place)}</Text>
        </View>

        <View className="gap-4 rounded-card border border-border bg-surface p-4">
          <Text className="text-body font-semibold text-text">{words.ask}</Text>
          <View>
            <PhoneField
              label={words.phoneLabel}
              value={phone}
              onChangeText={(text) => {
                setPhone(text);
                setOutcome(null);
              }}
              onSubmitEditing={() => void leaveNumber()}
              editable={!saving && outcome !== "saved"}
              message={outcome === "invalid" ? strings.profile.phoneInvalid : null}
            />
            {outcome !== "invalid" && <Text className="mt-2 text-secondary text-muted">{words.help}</Text>}
          </View>
          {outcome === "saved" ? (
            <Text accessibilityLiveRegion="polite" className="text-body text-text">
              {words.thanks}
            </Text>
          ) : (
            <>
              {other && (
                <Text accessibilityLiveRegion="polite" className="text-secondary text-danger">
                  {other === "offline" ? strings.profile.offline : strings.errors[other]}
                </Text>
              )}
              <Button label={saving ? words.leaving : words.leave} onPress={() => void leaveNumber()} disabled={saving} />
            </>
          )}
        </View>

        <Button label={words.change} onPress={changeLocation} variant="secondary" icon={MapPin} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
