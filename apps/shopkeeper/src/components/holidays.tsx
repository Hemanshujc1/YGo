import { indiaToday, type ShopHoliday, type ShopHolidaysResponse } from "@ygo/contracts";
import type { ApiResult } from "@ygo/api-client";
import { formatDayMonth, formatDayMonthYear, formatWeekday } from "@ygo/format";
import { Button, Text } from "@ygo/mobile";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { api } from "../api";
import { dateChoices, dateOf, pickFrom, type Draft } from "../lib/holidays";
import { strings } from "../strings";
import { Confirm } from "./confirm";
import { TimeSheet } from "./time-sheet";

const words = strings.holidays;

type Load = { kind: "loading" } | { kind: "failed"; message: string } | { kind: "loaded"; list: ShopHolidaysResponse };

/** "Tue, 12 Nov". */
const dayName = (date: string) => `${formatWeekday(date)}, ${formatDayMonth(date)}`;
const span = ({ starts, ends }: ShopHoliday, show = dayName) => starts === ends ? show(starts) : words.range(show(starts), show(ends));

/**
 * Holidays (#382) under the weekly hours: whole days the shop is closed, each
 * saved on its own. Upcoming ones can be edited or removed; ended ones are a
 * read-only record behind "Past holidays". Owner's answers 1–12 on #382 and
 * 1–4 of the second round.
 */
export function Holidays() {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [picking, setPicking] = useState<keyof ShopHoliday | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [showPast, setShowPast] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  // Set before React re-renders, so a second tap never saves twice.
  const working = useRef(false);
  const today = indiaToday();

  async function fetchList() {
    setLoad({ kind: "loading" });
    const answer = await api.shopHolidays().catch(() => null);
    setLoad(answer?.ok ? { kind: "loaded", list: answer.data } : { kind: "failed", message: answer ? strings.errors[answer.code] : words.loadFailed });
  }

  useEffect(() => {
    void fetchList();
  }, []);

  /** Saves or removes, then shows the server's list. */
  async function send(call: () => Promise<ApiResult<ShopHolidaysResponse>>) {
    if (working.current) return;
    working.current = true;
    setSaving(true);
    setMessage(null);
    const answer = await call().catch(() => null);
    working.current = false;
    setSaving(false);
    setConfirming(false);
    if (!answer?.ok) return setMessage({ text: answer ? strings.errors[answer.code] : words.saveFailed, failed: true });
    setLoad({ kind: "loaded", list: answer.data });
    setDraft(null);
    setMessage({ text: words.saved, failed: false });
  }

  function open(next: Draft | null) {
    setDraft(next);
    setMessage(null);
  }

  if (load.kind === "loading") return <ActivityIndicator className="text-primary" />;

  const editor = draft && (
    <View className="gap-2 rounded-input border border-border-strong p-3">
      <View className="flex-row flex-wrap items-center gap-2">
        <DateButton label={words.from} date={draft.starts} disabled={draft.started} onPress={() => setPicking("starts")} />
        <Text className="text-body text-muted">–</Text>
        <DateButton label={words.to} date={draft.ends} onPress={() => setPicking("ends")} />
      </View>
      {draft.started && <Text className="text-secondary text-muted">{words.started}</Text>}
      <View className="flex-row flex-wrap gap-x-2">
        <Button label={words.save} onPress={() => void send(() => api.saveShopHoliday({ starts: draft.starts, ends: draft.ends }, draft.id))} busy={saving} alignStart />
        {draft.id && <Button label={words.remove} onPress={() => setConfirming(true)} variant="text" alignStart />}
        <Button label={words.cancel} onPress={() => open(null)} variant="text" alignStart />
      </View>
    </View>
  );

  return (
    <View className="gap-3 rounded-card border border-border bg-surface p-4">
      <Text accessibilityRole="header" className="text-headline font-semibold text-text">{words.title}</Text>
      <Text className="text-body text-muted">{words.intro}</Text>
      {load.kind === "failed" && <>
        <Text accessibilityLiveRegion="polite" className="text-body text-danger">{load.message}</Text>
        <Button label={words.retry} onPress={() => void fetchList()} variant="text" alignStart />
      </>}
      {load.kind === "loaded" && <>
        {load.list.upcoming.length === 0 && !draft && <Text className="text-body text-muted">{words.none}</Text>}
        {load.list.upcoming.map((holiday) => draft?.id === holiday.id ? <View key={holiday.id}>{editor}</View> : (
          <Pressable
            key={holiday.id}
            accessibilityRole="button"
            accessibilityLabel={`${words.edit} ${span(holiday)}`}
            onPress={() => open({ ...holiday, started: holiday.starts < today })}
            className="min-h-12 flex-row items-center justify-between gap-2"
          >
            <Text className="flex-1 text-body text-text">{span(holiday)}</Text>
            <Text className="text-body font-semibold text-primary">{words.edit}</Text>
          </Pressable>
        ))}
        {draft && !draft.id && editor}
        {!draft && <Button label={words.add} onPress={() => open({ starts: today, ends: today, started: false })} variant="text" alignStart />}
        {message && <Text accessibilityLiveRegion="polite" className={`text-secondary ${message.failed ? "text-danger" : "text-success"}`}>{message.text}</Text>}
        {load.list.past.length > 0 && (
          <Button label={showPast ? words.hidePast : words.showPast} onPress={() => setShowPast(!showPast)} variant="text" alignStart />
        )}
        {showPast && load.list.past.map((holiday) => (
          <Text key={holiday.id} className="text-body text-muted">{span(holiday, formatDayMonthYear)}</Text>
        ))}
      </>}
      {picking && draft && (
        <TimeSheet
          title={picking === "starts" ? words.pickFrom : words.pickTo}
          times={dateChoices(picking === "starts" ? today : draft.starts, today)}
          selected={Date.parse(draft[picking])}
          label={(at) => dayName(dateOf(at))}
          cancel={words.cancel}
          onPick={(at) => {
            setPicking(null);
            open(picking === "starts" ? pickFrom(draft, dateOf(at)) : { ...draft, ends: dateOf(at) });
          }}
          onCancel={() => setPicking(null)}
        />
      )}
      <Confirm
        visible={confirming}
        title={words.removeTitle}
        body={draft?.started ? words.removeStarted : words.removeBody}
        confirm={words.remove}
        cancel={words.cancel}
        onConfirm={() => {
          const id = draft?.id;
          if (id) void send(() => api.removeShopHoliday(id));
        }}
        onCancel={() => setConfirming(false)}
      />
    </View>
  );
}

function DateButton({ label, date, disabled = false, onPress }: { label: string; date: string; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label} ${dayName(date)}`}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`min-h-12 justify-center rounded-input border px-3 ${disabled ? "border-border bg-disabled-bg" : "border-border-strong bg-surface"}`}
    >
      <Text className={`text-body ${disabled ? "text-disabled-text" : "text-text"}`}>{dayName(date)}</Text>
    </Pressable>
  );
}
