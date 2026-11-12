import { Text } from "@ygo/mobile";
import { useEffect, useReducer, useRef } from "react";
import { AccessibilityInfo, View } from "react-native";
import { strings } from "../strings";

const words = strings.order.changedTotal;

/** "7:42". */
export const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/** Whole seconds until `confirmByAt`, never below 0. */
export function secondsUntil(confirmByAt: string | null, now: number = Date.now()): number | null {
  if (!confirmByAt) return null;
  return Math.max(0, Math.ceil((Date.parse(confirmByAt) - now) / 1000));
}

/** Seconds left ticking once a second, until it reaches 0 (ORD-4, C10). */
export function useSecondsLeft(confirmByAt: string | null): number | null {
  const [, tick] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (!confirmByAt) return;
    const timer = setInterval(() => {
      tick();
      if ((secondsUntil(confirmByAt) ?? 0) === 0) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [confirmByAt]);
  // Read at render, so a new `confirmByAt` never meets an older clock reading.
  return secondsUntil(confirmByAt);
}

/** Announces warning once when seconds first drops below 60, not on mount if already below (#612). */
export function useCountdownWarning(seconds: number) {
  const prevRef = useRef<number>(seconds);
  useEffect(() => {
    if (prevRef.current >= 60 && seconds < 60 && seconds > 0) {
      AccessibilityInfo.announceForAccessibility(words.expiringSoon(clock(seconds)));
    }
    prevRef.current = seconds;
  }, [seconds]);
}

function countdownLabel(seconds: number): string {
  if (seconds === 0) return words.timeUp;
  if (seconds < 60) return words.expiringSoon(clock(seconds));
  return words.expiresIn(clock(seconds));
}

/** 20/28 tabular in a bordered pill; under one minute a 2 px warning border, never flashing (design system section 5). */
export function Countdown({ seconds }: { seconds: number }) {
  const low = seconds < 60;
  useCountdownWarning(seconds);
  return (
    <View
      accessible
      accessibilityLabel={countdownLabel(seconds)}
      accessibilityLiveRegion={seconds === 0 ? "polite" : "none"}
      className={`self-start rounded-full px-4 py-1 ${low ? "border-2 border-warning" : "border border-border-strong"}`}
    >
      <Text className="text-title font-semibold tabular-nums text-text">
        {seconds > 0 ? words.expiresIn(clock(seconds)) : words.timeUp}
      </Text>
    </View>
  );
}

/** Compact countdown pill for the persistent top banner (#606, #612). */
export function BannerCountdown({ seconds }: { seconds: number }) {
  const low = seconds < 60;
  useCountdownWarning(seconds);
  return (
    <View
      accessible
      accessibilityLabel={countdownLabel(seconds)}
      accessibilityLiveRegion={seconds === 0 ? "polite" : "none"}
      className={`rounded-full px-2.5 py-0.5 ${low ? "border-2 border-warning" : "border border-border-strong"}`}
    >
      <Text className="text-secondary font-semibold tabular-nums text-text">
        {seconds > 0 ? clock(seconds) : words.timeUp}
      </Text>
    </View>
  );
}

/** Countdown ticking down to `confirmByAt` for the persistent banner (#606). */
export function ExpiryCountdown({ confirmByAt }: { confirmByAt: string | null }) {
  const seconds = useSecondsLeft(confirmByAt);
  if (seconds === null) return null;
  return <BannerCountdown seconds={seconds} />;
}

