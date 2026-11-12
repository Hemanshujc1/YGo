import type { FulfilmentMode, FulfilmentModeState } from "@ygo/contracts";
import { Button, Text } from "@ygo/mobile";
import { Link } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../api";
import { Toggle } from "../components/toggle";
import { backPath } from "../lib/back-path";
import { useAccountRole } from "../lib/account-role";
import { strings } from "../strings";

const words = strings.fulfilment;
const order: FulfilmentMode[] = ["instant", "scheduled", "pickup"];
type Load = { kind: "loading" } | { kind: "failed"; message: string } | { kind: "loaded"; modes: FulfilmentModeState[] };

/**
 * S38 Order types (FUL-1, #65): the Owner's own switch for instant delivery, scheduled delivery and pickup. When YGo has forced a mode off the
 * Owner's switch keeps its position and the screen says so. Pickup refuses to switch on until the rate card has a pickup rule. Online only.
 */
export default function FulfilmentScreen() {
  const insets = useSafeAreaInsets();
  const role = useAccountRole();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  // The position shown while a change saves; a failed save moves it back.
  const [moving, setMoving] = useState<{ mode: FulfilmentMode; on: boolean } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Set before React re-renders, so a second tap never saves twice.
  const working = useRef(false);

  async function fetchModes() {
    setLoad({ kind: "loading" });
    const answer = await api.fulfilmentModes().catch(() => null);
    if (!answer?.ok) return setLoad({ kind: "failed", message: answer ? strings.errors[answer.code] : words.loadFailed });
    setLoad({ kind: "loaded", modes: answer.data.modes });
  }
  useEffect(() => { void fetchModes(); }, []);

  async function flip(mode: FulfilmentMode, on: boolean) {
    if (working.current) return;
    working.current = true;
    setMessage(null);
    setMoving({ mode, on });
    const answer = await api.setFulfilmentMode(mode, on).catch(() => null);
    working.current = false;
    setMoving(null);
    if (answer?.ok) return setLoad({ kind: "loaded", modes: answer.data.modes });
    setMessage(answer ? strings.errors[answer.code] : words.saveFailed);
  }

  return (
    <ScrollView className="flex-1 bg-bg" contentContainerClassName="gap-4 px-4" contentContainerStyle={{ paddingTop: insets.top + 20, paddingBottom: insets.bottom + 28 }}>
      <Link href={backPath()} asChild><Pressable accessibilityRole="button" className="min-h-12 justify-center self-start"><Text className="text-body font-semibold text-primary">‹ {words.back}</Text></Pressable></Link>
      <Text accessibilityRole="header" className="text-title-large font-semibold text-text">{words.title}</Text>
      {load.kind === "loading" && <ActivityIndicator size="large" className="text-primary" accessibilityLabel={words.loading} />}
      {load.kind === "failed" && <><Text accessibilityLiveRegion="polite" className="text-body text-danger">{load.message}</Text><Button label={words.retry} onPress={() => void fetchModes()} variant="secondary" /></>}
      {load.kind === "loaded" && <>
        <Text className="text-body text-muted">{words.intro}</Text>
        {role === "owner" ? null : <Text className="text-secondary text-muted">{words.staffOnly}</Text>}
        {order.map((mode) => {
          const state = load.modes.find((entry) => entry.mode === mode);
          if (!state) return null;
          const on = moving?.mode === mode ? moving.on : state.shopOn;
          return (
            <View key={mode} className="gap-1 rounded-card border border-border bg-surface p-4">
              <View className="flex-row items-center justify-between gap-3">
                <Text className="flex-1 text-body font-semibold text-text">{words.modes[mode]}</Text>
                <Toggle on={on} busy={moving !== null || role !== "owner"} label={words.modes[mode]} onPress={() => void flip(mode, !state.shopOn)} />
              </View>
              <Text className="text-secondary text-muted">{words.notes[mode]}</Text>
              {state.adminForcedOff && <Text accessibilityLiveRegion="polite" className="text-secondary font-medium text-warning-text">{words.forcedOff}</Text>}
            </View>
          );
        })}
        {message && <Text accessibilityLiveRegion="polite" className="text-secondary text-danger">{message}</Text>}
      </>}
    </ScrollView>
  );
}
