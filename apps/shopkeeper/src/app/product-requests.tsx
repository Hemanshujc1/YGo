import { CreateProductRequestBody, invalidFields, type ProductRequest, type ProductRequestsResponse } from "@ygo/contracts";
import { formatMoney, trimDecimal } from "@ygo/format";
import { Button, StatusChip, Text, type Treatment } from "@ygo/mobile";
import { Link } from "expo-router";
import { randomUUID } from "expo-crypto";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../api";
import { backPath } from "../lib/back-path";
import { strings } from "../strings";

const words = strings.productRequests;
type Load = { kind: "loading" } | { kind: "offline" } | { kind: "failed"; message: string } | { kind: "loaded"; data: ProductRequestsResponse };
type Form = { name: string; brand: string; categoryId: string; baseUnit: "each" | "kg" | "l"; packQuantity: string; barcode: string; counterPrice: string; mrp: string };
const emptyForm: Form = { name: "", brand: "", categoryId: "", baseUnit: "kg", packQuantity: "", barcode: "", counterPrice: "", mrp: "" };
const treatment: Record<ProductRequest["status"], Treatment> = { pending: "waiting", approved: "completed", mapped: "completed", rejected: "ended" };

/**
 * S38 Product request (CAT-3, #62): the Owner asks for a product the catalog lacks and can bill it at the counter at once. Customers see it only
 * once Admin approves. The Request button is off while the phone can't reach the server, with the reason shown. One `clientId` per form, so a
 * retry after a lost answer is the same request.
 */
export default function ProductRequestsScreen() {
  const insets = useSafeAreaInsets();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [form, setForm] = useState<Form>(emptyForm);
  const [wrong, setWrong] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const clientId = useRef(randomUUID());

  async function refresh() {
    const answer = await api.productRequests().catch(() => null);
    if (answer?.ok) { setOffline(false); setLoad({ kind: "loaded", data: answer.data }); }
    else if (answer) setLoad({ kind: "failed", message: strings.errors[answer.code] });
    else { setOffline(true); setLoad((current) => current.kind === "loaded" ? current : { kind: "offline" }); }
  }
  useEffect(() => { void refresh(); }, []);

  function edit(field: keyof Form, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
    setWrong((current) => current.filter((name) => name !== field));
    setMessage(null);
  }

  async function send() {
    if (busy || offline) return;
    const checked = CreateProductRequestBody.safeParse({
      clientId: clientId.current, name: form.name, brand: form.brand.trim() || undefined, categoryId: form.categoryId, baseUnit: form.baseUnit,
      packQuantity: form.packQuantity, barcode: form.barcode.trim() || undefined, counterPrice: form.counterPrice, mrp: form.mrp,
    });
    if (!checked.success) { setWrong(invalidFields(checked.error)); setMessage(words.invalid); return; }
    setBusy(true);
    const answer = await api.createProductRequest(checked.data).catch(() => null);
    setBusy(false);
    if (!answer) { setOffline(true); setMessage(words.offline); return; }
    if (!answer.ok) { setMessage(strings.errors[answer.code]); return; }
    clientId.current = randomUUID();
    setForm(emptyForm);
    setMessage(words.sent);
    await refresh();
  }

  return (
    <ScrollView className="flex-1 bg-bg" contentContainerClassName="gap-4 px-4" contentContainerStyle={{ paddingTop: insets.top + 20, paddingBottom: insets.bottom + 28 }} keyboardShouldPersistTaps="handled">
      <Link href={backPath()} asChild><Pressable accessibilityRole="button"><Text className="text-body font-semibold text-primary">‹ {words.back}</Text></Pressable></Link>
      <Text accessibilityRole="header" className="text-title-large font-semibold text-text">{words.title}</Text>
      <Text className="text-body text-muted">{words.intro}</Text>
      {load.kind === "loading" && <ActivityIndicator size="large" className="text-primary" accessibilityLabel={words.loading} />}
      {load.kind === "failed" && <><Text className="text-body text-danger">{load.message}</Text><Button label={words.retry} onPress={() => void refresh()} variant="secondary" /></>}
      {load.kind === "offline" && <><Text className="text-body text-danger">{words.loadFailed}</Text><Text className="text-secondary text-muted">{words.offline}</Text>
        <Button label={words.request} onPress={() => undefined} disabled /><Button label={words.retry} onPress={() => void refresh()} variant="secondary" /></>}
      {load.kind === "loaded" && <>
        <Text accessibilityRole="header" className="text-title font-semibold text-text">{words.newRequest}</Text>
        <Field label={words.name} value={form.name} onChange={(value) => edit("name", value)} error={wrong.includes("name")} keyboardType="default" />
        <Field label={words.brand} value={form.brand} onChange={(value) => edit("brand", value)} error={wrong.includes("brand")} keyboardType="default" />
        <Choices label={words.category} error={wrong.includes("categoryId")} options={load.data.categories.map((category) => ({ value: category.id, label: category.parentName ? `${category.parentName} › ${category.name}` : category.name }))} value={form.categoryId} onChange={(value) => edit("categoryId", value)} />
        <Choices label={words.unit} error={wrong.includes("baseUnit")} options={(["each", "kg", "l"] as const).map((unit) => ({ value: unit, label: words.units[unit] }))} value={form.baseUnit} onChange={(value) => edit("baseUnit", value)} />
        <Field label={words.packQuantity} value={form.packQuantity} onChange={(value) => edit("packQuantity", value)} error={wrong.includes("packQuantity")} numeric />
        <Field label={words.barcode} value={form.barcode} onChange={(value) => edit("barcode", value)} error={wrong.includes("barcode")} keyboardType="number-pad" />
        <Field label={words.counterPrice} value={form.counterPrice} onChange={(value) => edit("counterPrice", value)} error={wrong.includes("counterPrice")} numeric />
        <Field label={words.mrp} value={form.mrp} onChange={(value) => edit("mrp", value)} error={wrong.includes("mrp")} numeric />
        {wrong.map((field) => <Text key={field} className="text-secondary text-danger">{words.fields[field] ?? words.invalid}</Text>)}
        {message && <Text accessibilityLiveRegion="polite" className={`text-secondary ${message === words.sent ? "text-success" : "text-danger"}`}>{message}</Text>}
        {offline && <Text className="text-secondary text-muted">{words.offline}</Text>}
        <Button label={words.request} onPress={() => void send()} busy={busy} disabled={offline} />
        {offline && <Button label={words.retry} onPress={() => void refresh()} variant="secondary" />}
        {load.data.requests.length === 0 && <Text className="text-body text-muted">{words.none}</Text>}
        {load.data.requests.map((request) => <View key={request.id} className="gap-1 rounded-card border border-border bg-surface p-4">
          <Text className="text-body font-semibold text-text">{request.name}{request.brand ? ` · ${request.brand}` : ""}</Text>
          <Text className="text-secondary text-muted">{trimDecimal(request.packQuantity)} {request.baseUnit} · {formatMoney(request.counterPrice)} · MRP {formatMoney(request.mrp)}</Text>
          <StatusChip word={words.status[request.status]} treatment={treatment[request.status]} />
          {request.reason && <Text className="text-secondary text-muted">{words.reason(request.reason)}</Text>}
        </View>)}
      </>}
    </ScrollView>
  );
}

function Field({ label, value, onChange, error = false, numeric = false, keyboardType }: { label: string; value: string; onChange: (value: string) => void; error?: boolean; numeric?: boolean; keyboardType?: "default" | "number-pad" }) {
  return <View className="gap-1">
    <Text className="text-secondary font-semibold text-text">{label}</Text>
    <TextInput accessibilityLabel={label} keyboardType={numeric ? "decimal-pad" : keyboardType ?? "default"} value={value} onChangeText={onChange} onBlur={numeric ? () => onChange(trimDecimal(value)) : undefined}
      className={`h-[52px] rounded-input border bg-surface px-3 text-body text-text ${error ? "border-danger" : "border-border"}`} />
  </View>;
}

function Choices<T extends string>({ label, options, value, onChange, error }: { label: string; options: { value: T; label: string }[]; value: string; onChange: (value: T) => void; error: boolean }) {
  return <View className="gap-1">
    <Text className="text-secondary font-semibold text-text">{label}</Text>
    <View className="flex-row flex-wrap gap-2">
      {options.map((option) => <Pressable key={option.value} accessibilityRole="radio" accessibilityState={{ selected: option.value === value }} onPress={() => onChange(option.value)}
        className={`min-h-[44px] justify-center rounded-button border px-4 ${option.value === value ? "border-primary bg-primary-subtle" : error ? "border-danger" : "border-border"}`}>
        <Text className="text-body text-text">{option.label}</Text>
      </Pressable>)}
    </View>
  </View>;
}
