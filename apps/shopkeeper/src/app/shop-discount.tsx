import type { ShopDiscountResponse } from "@ygo/contracts";
import { Button, Text } from "@ygo/mobile";
import { Link } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, Switch, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { trimDecimal } from "@ygo/format";
import { api } from "../api";
import { backPath } from "../lib/back-path";
import { type DiscountForm, toBody, toForm, worstPercent } from "../lib/shop-discount";
import { strings } from "../strings";

const words = strings.shopDiscount;
// `retry` only when trying again can help: no answer or a server fault. A refusal (Staff 403, no shop 404) leaves the Back link.
type Load = { kind: "loading" } | { kind: "failed"; message: string; retry: boolean } | { kind: "loaded"; data: ShopDiscountResponse };

/**
 * S34 Shop discount (MNY-5, CRT-3, NOT-6, #63): the Owner's one shop-wide discount, a percentage with an optional cap or a flat amount over a
 * minimum order. The server refuses one whose worst case is over the maximum; a rule YGo paused when the maximum was lowered says so and is
 * never reduced. Until customers can see a discount (#571) the switch stays off and says why. Online only. Coupons join this screen with #70.
 */
export default function ShopDiscountScreen() {
  const insets = useSafeAreaInsets();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [form, setForm] = useState<DiscountForm>(() => toForm(null, false));
  const [wrong, setWrong] = useState<string[]>([]);
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);

  async function fetchRule() {
    setLoad({ kind: "loading" });
    const answer = await api.shopDiscount().catch(() => null);
    if (!answer?.ok) return setLoad({ kind: "failed", message: answer ? strings.errors[answer.code] : words.loadFailed, retry: !answer || answer.status >= 500 });
    setForm(toForm(answer.data.rule, answer.data.available));
    setLoad({ kind: "loaded", data: answer.data });
  }
  useEffect(() => { void fetchRule(); }, []);

  function edit(patch: Partial<DiscountForm>) {
    setForm((current) => ({ ...current, ...patch }));
    setWrong([]);
    setMessage(null);
  }

  async function save() {
    if (working.current) return;
    const checked = toBody(form);
    if (!checked.ok) { setWrong(checked.fields); setMessage({ text: words.invalid, failed: true }); return; }
    working.current = true;
    setBusy(true);
    const answer = await api.saveShopDiscount(checked.body).catch(() => null);
    working.current = false;
    setBusy(false);
    if (!answer) return setMessage({ text: words.saveFailed, failed: true });
    if (!answer.ok) {
      return setMessage({ text: answer.code === "DISCOUNT_ABOVE_MAXIMUM" && answer.maximumPercentage ? words.above(trimDecimal(answer.maximumPercentage)) : strings.errors[answer.code], failed: true });
    }
    setLoad({ kind: "loaded", data: answer.data });
    setForm(toForm(answer.data.rule, answer.data.available));
    setMessage({ text: words.saved, failed: false });
  }

  const worst = worstPercent(form);
  return (
    // Padding on Android too: edge to edge, the window no longer shrinks for the keyboard, which would cover the field being typed in.
    <KeyboardAvoidingView behavior="padding" className="flex-1 bg-bg">
    <ScrollView className="flex-1 bg-bg" contentContainerClassName="gap-4 px-4" contentContainerStyle={{ paddingTop: insets.top + 20, paddingBottom: insets.bottom + 28 }} keyboardShouldPersistTaps="handled">
      <Link href={backPath()} asChild><Pressable accessibilityRole="button" className="min-h-12 justify-center self-start"><Text className="text-body font-semibold text-primary">‹ {words.back}</Text></Pressable></Link>
      <Text accessibilityRole="header" className="text-title-large font-semibold text-text">{words.title}</Text>
      {load.kind === "loading" && <ActivityIndicator size="large" className="text-primary" accessibilityLabel={words.loading} />}
      {load.kind === "failed" && <><Text accessibilityLiveRegion="polite" className="text-body text-danger">{load.message}</Text>{load.retry && <Button label={words.retry} onPress={() => void fetchRule()} variant="secondary" />}</>}
      {load.kind === "loaded" && <>
        <Text className="text-body text-muted">{words.intro}</Text>
        <Text className="text-secondary text-muted">{words.maximum(trimDecimal(load.data.maximumPercentage))}</Text>
        {!load.data.available && <Text className="rounded-card border border-border p-3 text-body text-text">{words.notYet}</Text>}
        {load.data.available && load.data.rule?.status === "paused" && <Text accessibilityLiveRegion="polite" className="rounded-card border border-danger p-3 text-body text-danger">{words.paused(trimDecimal(load.data.maximumPercentage))}</Text>}
        <View className="flex-row gap-2">
          {(["percentage", "flat"] as const).map((kind) => <Pressable key={kind} accessibilityRole="radio" accessibilityState={{ selected: form.form === kind }} onPress={() => edit({ form: kind })}
            className={`min-h-[44px] justify-center rounded-button border px-4 ${form.form === kind ? "border-primary bg-primary-subtle" : "border-border"}`}>
            <Text className="text-body text-text">{kind === "percentage" ? words.percentageForm : words.flatForm}</Text>
          </Pressable>)}
        </View>
        {form.form === "percentage"
          ? <><Field label={words.percentage} value={form.percentage} error={wrong.includes("percentage")} onChange={(value) => edit({ percentage: value })} />
            <Field label={words.cap} value={form.cap} error={wrong.includes("cap")} onChange={(value) => edit({ cap: value })} /></>
          : <><Field label={words.amount} value={form.amount} error={wrong.includes("amount")} onChange={(value) => edit({ amount: value })} />
            <Field label={words.minimumOrder} value={form.minimumOrder} error={wrong.includes("minimumOrder")} onChange={(value) => edit({ minimumOrder: value })} /></>}
        {worst && <Text className="text-secondary text-muted">{words.worst(worst)}</Text>}
        <View className="flex-row items-center justify-between">
          <Text className="text-body text-text">{words.on}</Text>
          <Switch accessibilityLabel={words.on} value={form.active} disabled={!load.data.available} onValueChange={(active) => edit({ active })} />
        </View>
        {load.data.rule && !form.active && load.data.rule.status === "off" && <Text className="text-secondary text-muted">{words.off}</Text>}
        {message && <Text accessibilityLiveRegion="polite" className={`text-secondary ${message.failed ? "text-danger" : "text-success"}`}>{message.text}</Text>}
        <Button label={words.save} onPress={() => void save()} busy={busy} />
      </>}
    </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({ label, value, onChange, error }: { label: string; value: string; onChange: (value: string) => void; error: boolean }) {
  return <View className="gap-1">
    <Text className="text-secondary font-semibold text-text">{label}</Text>
    <TextInput accessibilityLabel={label} keyboardType="decimal-pad" value={value} onChangeText={onChange} onBlur={() => onChange(trimDecimal(value))}
      className={`h-[52px] rounded-input border bg-surface px-3 text-body text-text ${error ? "border-danger" : "border-border"}`} />
  </View>;
}
