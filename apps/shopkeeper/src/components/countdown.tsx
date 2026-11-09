import { Text } from "@ygo/mobile";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { clock, secondsLeft } from "../lib/shop-orders";
import { strings } from "../strings";

const words = strings.orders;

/** Seconds left by the server's clock, ticking once a second while the order is New, until it reaches 0 (S05, S03). */
export function useSecondsLeft(expiresAt: string | null, offset: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!expiresAt) return;
    setNow(Date.now());
    const tick = setInterval(() => {
      const phone = Date.now();
      setNow(phone);
      if (secondsLeft(expiresAt, offset, phone) === 0) clearInterval(tick);
    }, 1000);
    return () => clearInterval(tick);
  }, [expiresAt, offset]);
  return expiresAt ? secondsLeft(expiresAt, offset, now) : null;
}

/** 20/28 tabular in a bordered pill; under one minute a 2 px warning border, never flashing (design system section 5). */
export function Countdown({ seconds }: { seconds: number }) {
  const low = seconds < 60;
  // Only "Time is up" is read out; a reading every second would drown the buttons.
  return (
    <View accessibilityLiveRegion={seconds === 0 ? "polite" : "none"} className={`self-start rounded-full px-4 py-1 ${low ? "border-2 border-warning" : "border border-border-strong"}`}>
      <Text className="text-title font-semibold tabular-nums text-text">{seconds > 0 ? words.expiresIn(clock(seconds)) : words.timeUp}</Text>
    </View>
  );
}

/** Countdown ticking down to `expiresAt` by the server's clock. */
export function ExpiryCountdown({ expiresAt, offset }: { expiresAt: string | null; offset: number }) {
  const seconds = useSecondsLeft(expiresAt, offset);
  if (seconds === null) return null;
  return <Countdown seconds={seconds} />;
}
