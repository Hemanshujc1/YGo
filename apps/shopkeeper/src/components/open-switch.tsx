import type { ShopOpenChange, ShopOpenStatus } from "@ygo/contracts";
import { formatDayTime } from "@ygo/format";
import { Button, Text } from "@ygo/mobile";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { Toggle } from "./toggle";
import { api } from "../api";
import { settle, untilChoices } from "../lib/open-switch";
import { strings } from "../strings";
import { TimeSheet } from "./time-sheet";

const words = strings.openSwitch;

type Load = { kind: "loading" } | { kind: "failed"; message: string } | { kind: "loaded"; saved: ShopOpenStatus };

/**
 * The Owner's open/closed switch at the top of a Live shop's Home (#380).
 * Closing lasts until the next opening; opening outside hours asks "Open
 * until" first. Owner's answers 14–16 and 22 on #371, and 1–8 on #380.
 */
export function OpenSwitch() {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  // The position shown while a change saves; null shows the saved one.
  const [moving, setMoving] = useState<boolean | null>(null);
  const [picking, setPicking] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  // Set before React re-renders, so a second tap never saves twice.
  const working = useRef(false);

  // A failed refresh keeps what is on screen.
  async function fetchStatus() {
    const answer = await api.shopOpen().catch(() => null);
    if (answer?.ok) setLoad({ kind: "loaded", saved: answer.data });
    else setLoad((old) => old.kind === "loaded" ? old : { kind: "failed", message: answer ? strings.errors[answer.code] : words.loadFailed });
  }

  // Coming back to the Home, say after saving new hours, reads it again.
  useFocusEffect(
    useCallback(() => {
      void fetchStatus();
    }, []),
  );

  if (load.kind === "loading") return <ActivityIndicator className="text-primary" />;
  if (load.kind === "failed") {
    return (
      <View className="gap-2">
        <Text accessibilityLiveRegion="polite" className="text-secondary text-danger">{load.message}</Text>
        <Button label={words.retry} onPress={() => {
          setLoad({ kind: "loading" });
          void fetchStatus();
        }} variant="text" alignStart />
      </View>
    );
  }

  const { saved } = load;
  const now = Date.now();
  const on = moving ?? saved.open;

  async function save(change: ShopOpenChange) {
    if (working.current) return;
    working.current = true;
    setMoving(change.open);
    setFailed(null);
    const answer = await api.setShopOpen(change).catch(() => null);
    working.current = false;
    const next = settle(saved, answer);
    setLoad({ kind: "loaded", saved: next.saved });
    setMoving(null);
    if (next.failed) setFailed(answer && !answer.ok ? strings.errors[answer.code] : words.saveFailed);
  }

  function press() {
    // Opening outside the weekly hours needs an end; anything else just flips.
    if (saved.open || saved.scheduledOpen) void save({ open: !saved.open });
    else setPicking(true);
  }

  const line = saved.until ? (saved.setByOwner ? words.untilByYou : words.until)(formatDayTime(saved.until, now, words.tomorrow)) : null;
  return (
    <View className="gap-2 rounded-card border border-border bg-surface p-4">
      <View className="flex-row items-center gap-3">
        <View className="flex-1 gap-1">
          <Text className="text-headline font-semibold text-text">{on ? words.open : words.closed}</Text>
          {line && moving === null && <Text className="text-secondary text-muted">{line}</Text>}
        </View>
        <Toggle on={on} busy={moving !== null} label={words.open} onPress={press} />
      </View>
      {failed && <Text accessibilityLiveRegion="polite" className="text-secondary text-danger">{failed}</Text>}
      {picking && saved.nextOpening && (
        <TimeSheet
          title={words.pickUntil}
          times={untilChoices(now, saved.nextOpening)}
          label={(at) => formatDayTime(at, now, words.tomorrow)}
          cancel={words.cancel}
          onPick={(at) => {
            setPicking(false);
            void save({ open: true, until: new Date(at).toISOString() });
          }}
          onCancel={() => setPicking(false)}
        />
      )}
    </View>
  );
}
