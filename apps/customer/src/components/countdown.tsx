import { Text } from "@ygo/mobile";
import { useEffect, useState } from "react";
import { View } from "react-native";
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
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!confirmByAt) return;
    setNow(Date.now());
    const tick = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if ((secondsUntil(confirmByAt, current) ?? 0) === 0) clearInterval(tick);
    }, 1000);
    return () => clearInterval(tick);
  }, [confirmByAt]);
  return secondsUntil(confirmByAt, now);
}

/** 20/28 tabular in a bordered pill; under one minute a 2 px warning border, never flashing (design system section 5). */
export function Countdown({ seconds }: { seconds: number }) {
  const low = seconds < 60;
  return (
    <View
      accessibilityLiveRegion={seconds === 0 ? "polite" : "none"}
      className={`self-start rounded-full px-4 py-1 ${low ? "border-2 border-warning" : "border border-border-strong"}`}
    >
      <Text className="text-title font-semibold tabular-nums text-text">
        {seconds > 0 ? words.expiresIn(clock(seconds)) : words.timeUp}
      </Text>
    </View>
  );
}

/** Countdown ticking down to `confirmByAt`. */
export function ExpiryCountdown({ confirmByAt }: { confirmByAt: string | null }) {
  const seconds = useSecondsLeft(confirmByAt);
  if (seconds === null) return null;
  return <Countdown seconds={seconds} />;
}

