import { overlappingDays, ShopHours } from "@ygo/contracts";
import { formatMinuteOfDay } from "@ygo/format";
import { Button, Text } from "@ygo/mobile";
import { Link } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../api";
import { Holidays } from "../components/holidays";
import { TimeSheet } from "../components/time-sheet";
import { canAdd, copyToAll, nextOpening, TIMES, toRanges, toWeek, type Opening, type Week } from "../lib/hours";
import { strings } from "../strings";

const words = strings.hours;

type Load = { kind: "loading" } | { kind: "failed"; message: string } | { kind: "loaded" };
/** Which time the picker is choosing: a day, one of its openings, and which end. */
type Picking = { day: number; index: number; end: keyof Opening };

/**
 * Opening hours (#371): the Owner's weekly hours, up to 3 openings a day in
 * 30-minute steps, saved as a whole week. Owner's answers 3–6 and 20 on #371.
 * Holidays sit below, saved one at a time (#382).
 */
export default function HoursScreen() {
  const insets = useSafeAreaInsets();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [week, setWeek] = useState<Week>(() => toWeek([]));
  const [picking, setPicking] = useState<Picking | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  // Set before React re-renders, so a second tap never saves twice.
  const working = useRef(false);

  async function fetchHours() {
    setLoad({ kind: "loading" });
    const answer = await api.shopHours().catch(() => null);
    if (!answer?.ok) return setLoad({ kind: "failed", message: answer ? strings.errors[answer.code] : words.loadFailed });
    setWeek(toWeek(answer.data.ranges));
    setLoad({ kind: "loaded" });
  }

  useEffect(() => {
    void fetchHours();
  }, []);

  function change(next: Week) {
    setWeek(next);
    setMessage(null);
  }

  const overlaps = new Set(overlappingDays(toRanges(week)));

  async function save() {
    if (working.current) return;
    const body = { ranges: toRanges(week) };
    // The overlap lines already sit under their days; an empty week needs its own line.
    if (!ShopHours.safeParse(body).success) return setMessage({ text: body.ranges.length ? words.overlap : words.empty, failed: true });
    working.current = true;
    setSaving(true);
    setMessage(null);
    const answer = await api.saveShopHours(body).catch(() => null);
    working.current = false;
    setSaving(false);
    if (!answer?.ok) return setMessage({ text: answer ? strings.errors[answer.code] : words.saveFailed, failed: true });
    setWeek(toWeek(answer.data.ranges));
    setMessage({ text: words.saved, failed: false });
  }

  function pick(minute: number) {
    if (!picking) return;
    change(week.map((day, index) => index !== picking.day ? day : day.map((opening, at) => at === picking.index ? { ...opening, [picking.end]: minute } : opening)));
    setPicking(null);
  }

  return (
    <View className="flex-1 bg-bg">
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-4 px-4"
        contentContainerStyle={{ paddingTop: insets.top + 20, paddingBottom: insets.bottom + 28 }}
      >
        <Link href="/" asChild><Pressable accessibilityRole="button" className="min-h-12 justify-center self-start"><Text className="text-body font-semibold text-primary">‹ {words.back}</Text></Pressable></Link>
        <Text accessibilityRole="header" className="text-title-large font-semibold text-text">{words.title}</Text>
        {load.kind === "loading" && <ActivityIndicator size="large" className="text-primary" />}
        {load.kind === "failed" && <>
          <Text accessibilityLiveRegion="polite" className="text-body text-danger">{load.message}</Text>
          <Button label={words.retry} onPress={() => void fetchHours()} variant="secondary" />
        </>}
        {load.kind === "loaded" && <>
          <Text className="text-body text-muted">{words.intro}</Text>
          {week.map((day, index) => (
            <Day
              key={words.days[index]}
              name={words.days[index] ?? ""}
              day={day}
              overlaps={overlaps.has(index + 1)}
              onChange={(next) => change(week.map((old, at) => at === index ? next : old))}
              onPick={(at, end) => setPicking({ day: index, index: at, end })}
              onCopy={() => change(copyToAll(week, index))}
            />
          ))}
          {message && <Text accessibilityLiveRegion="polite" className={`text-secondary ${message.failed ? "text-danger" : "text-success"}`}>{message.text}</Text>}
          <Button label={words.save} onPress={() => void save()} busy={saving} />
          <Holidays />
        </>}
      </ScrollView>
      {picking && (
        <TimeSheet
          title={picking.end === "opens" ? words.pickOpens : words.pickCloses}
          times={TIMES}
          selected={week[picking.day]?.[picking.index]?.[picking.end] ?? 0}
          label={formatMinuteOfDay}
          cancel={words.cancel}
          onPick={pick}
          onCancel={() => setPicking(null)}
        />
      )}
    </View>
  );
}

function Day({ name, day, overlaps, onChange, onPick, onCopy }: {
  name: string;
  day: Opening[];
  overlaps: boolean;
  onChange: (day: Opening[]) => void;
  onPick: (index: number, end: keyof Opening) => void;
  onCopy: () => void;
}) {
  return (
    <View className={`gap-3 rounded-card border bg-surface p-4 ${overlaps ? "border-danger" : "border-border"}`}>
      <Text accessibilityRole="header" className="text-headline font-semibold text-text">{name}</Text>
      {day.length === 0 && <Text className="text-body text-muted">{words.closed}</Text>}
      {day.map((opening, index) => (
        <View key={index} className="gap-1">
          <View className="flex-row flex-wrap items-center gap-2">
            <Time label={words.opens} minute={opening.opens} onPress={() => onPick(index, "opens")} />
            <Text className="text-body text-muted">–</Text>
            <Time label={words.closes} minute={opening.closes} onPress={() => onPick(index, "closes")} />
            <Button label={words.remove} onPress={() => onChange(day.filter((_, at) => at !== index))} variant="text" />
          </View>
          {opening.closes <= opening.opens && (
            <Text className="text-secondary text-muted">{opening.closes === opening.opens ? words.allDay : words.nextDay}</Text>
          )}
        </View>
      ))}
      {overlaps && <Text accessibilityLiveRegion="polite" className="text-secondary text-danger">{words.overlap}</Text>}
      <View className="flex-row flex-wrap gap-x-2">
        {canAdd(day) && <Button label={words.add} onPress={() => onChange([...day, nextOpening(day)])} variant="text" alignStart />}
        <Button label={words.copy} onPress={onCopy} variant="text" alignStart />
      </View>
    </View>
  );
}

function Time({ label, minute, onPress }: { label: string; minute: number; onPress: () => void }) {
  const time = formatMinuteOfDay(minute);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${label} ${time}`} onPress={onPress} className="min-h-12 justify-center rounded-input border border-border-strong bg-surface px-3">
      <Text className="text-body tabular-nums text-text">{time}</Text>
    </Pressable>
  );
}
