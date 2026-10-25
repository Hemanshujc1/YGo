import { type ShopApplication, ShopEntityType } from "@ygo/contracts";
import { formatNumber, formatPhone } from "@ygo/format";
import { Button, edgeClass, FieldMessage, Text, ThemePicker } from "@ygo/mobile";
import { type ReactNode, useRef, useState } from "react";
import { KeyboardAvoidingView, Pressable, ScrollView, TextInput, type TextInputProps, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, session } from "../api";
import { changed, draftBody, type Field, shown, stepRadius, type TextField, type Typed, typedFrom } from "../lib/application-form";
import { strings } from "../strings";
import { Minus, Plus } from "./icons";
import { SignOut } from "./sign-out";

const words = strings.application.form;

/** How each typed field's keyboard behaves. */
const inputs: Record<TextField, TextInputProps> = {
  shopName: { autoCapitalize: "words" },
  address: { multiline: true, textAlignVertical: "top", autoComplete: "street-address", textContentType: "fullStreetAddress" },
  pincode: { keyboardType: "number-pad", autoComplete: "postal-code", textContentType: "postalCode" },
  ownerName: { autoCapitalize: "words", autoComplete: "name", textContentType: "name" },
  pan: { autoCapitalize: "characters", autoCorrect: false },
  fssaiNumber: { keyboardType: "number-pad" },
  fssaiExpiry: { keyboardType: "numbers-and-punctuation", placeholder: words.datePlaceholder },
  upiId: { keyboardType: "email-address", autoCapitalize: "none", autoCorrect: false },
};

/**
 * S17 Shop application while it is a Draft (#294): one scrolling form in four
 * groups with Save draft. Each field is checked with the server's rule on
 * Save draft, and an empty one is fine (#276, Q5). Location and Send join in #295.
 */
export function ApplicationForm({ application }: { application: ShopApplication }) {
  const insets = useSafeAreaInsets();
  const [saved, setSaved] = useState(() => typedFrom(application));
  const [typed, setTyped] = useState(saved);
  const [wrong, setWrong] = useState<Field[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  // Set before React re-renders, so a second tap never saves twice.
  const working = useRef(false);

  function edit(field: Field | "serviceRadiusMetres", next: Partial<Typed>) {
    setTyped((now) => ({ ...now, ...next }));
    setWrong((now) => now.filter((named) => named !== field));
    setMessage(null);
    setJustSaved(false);
  }

  async function save() {
    if (working.current) return;
    const draft = draftBody(typed);
    if (!draft.ok) {
      setWrong(draft.wrong);
      return setMessage(words.wrong);
    }
    working.current = true;
    setSaving(true);
    setMessage(null);
    const answer = await api.saveShopApplication(draft.body).catch(() => null);
    working.current = false;
    setSaving(false);
    if (!answer) return setMessage(words.offline);
    if (!answer.ok) {
      const named = shown(answer.fields);
      setWrong(named);
      return setMessage(named.length > 0 ? words.wrong : strings.errors[answer.code]);
    }
    const next = typedFrom(answer.data);
    setSaved(next);
    setTyped(next);
    setWrong([]);
    setJustSaved(true);
  }

  function input(field: TextField) {
    return (
      <Input
        label={words[field].label}
        value={typed[field]}
        onChangeText={(value) => edit(field, { [field]: value })}
        message={wrong.includes(field) ? words[field].invalid : null}
        editable={!saving}
        {...inputs[field]}
      />
    );
  }

  const radius = typed.serviceRadiusMetres;
  const less = stepRadius(radius, -1);
  const more = stepRadius(radius, 1);

  return (
    // Padding on Android too: edge to edge, the window no longer shrinks for the keyboard.
    <KeyboardAvoidingView behavior="padding" className="flex-1 bg-bg">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-8 px-4"
        contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }}
      >
        <View className="gap-2">
          <Text accessibilityRole="header" className="text-title-large font-semibold text-text">
            {words.title}
          </Text>
          <Text className="text-body text-muted">{words.lead}</Text>
        </View>

        <Group title={words.groups.shop}>
          {input("shopName")}
          {input("address")}
          {input("pincode")}
          <View className="gap-1.5">
            <Text className="text-label font-medium text-text">{words.radius.label}</Text>
            <Text className="text-secondary text-muted">{words.radius.hint}</Text>
            <View className="flex-row items-center gap-4">
              <Step label={words.radius.less} onPress={less === null ? null : () => edit("serviceRadiusMetres", { serviceRadiusMetres: less })} disabled={saving}>
                <Minus size={24} className={less === null || saving ? "text-disabled-text" : "text-primary"} />
              </Step>
              <Text accessibilityLiveRegion="polite" className="min-w-16 text-center text-headline font-semibold text-text">
                {words.radius.value(formatNumber(radius / 1000))}
              </Text>
              <Step label={words.radius.more} onPress={more === null ? null : () => edit("serviceRadiusMetres", { serviceRadiusMetres: more })} disabled={saving}>
                <Plus size={24} className={more === null || saving ? "text-disabled-text" : "text-primary"} />
              </Step>
            </View>
          </View>
        </Group>

        <Group title={words.groups.owner}>
          {input("ownerName")}
          <View className="gap-1">
            <Text className="text-label font-medium text-text">{words.phone}</Text>
            <Text className="text-body text-text">{application.ownerPhone ? formatPhone(application.ownerPhone) : ""}</Text>
            <Text className="mt-3 text-label font-medium text-text">{words.email}</Text>
            <Text className="text-body text-text">{application.ownerEmail}</Text>
            <Text className="mt-1 text-secondary text-muted">{words.fromAccount}</Text>
          </View>
          <View className="gap-1.5">
            <Text className="text-label font-medium text-text">{words.entityType.label}</Text>
            <View accessibilityRole="radiogroup" accessibilityLabel={words.entityType.label}>
              {ShopEntityType.options.map((type) => (
                <Pressable
                  key={type}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: typed.entityType === type, disabled: saving }}
                  disabled={saving}
                  onPress={() => edit("entityType", { entityType: type })}
                  className="min-h-12 flex-row items-center gap-3"
                >
                  <View
                    className={`h-6 w-6 items-center justify-center rounded-full border-2 ${typed.entityType === type ? "border-primary" : "border-border-strong"}`}
                  >
                    {typed.entityType === type && <View className="h-3 w-3 rounded-full bg-primary" />}
                  </View>
                  <Text className="text-body text-text">{words.entityTypes[type]}</Text>
                </Pressable>
              ))}
            </View>
            {wrong.includes("entityType") && <FieldMessage text={words.entityType.invalid} />}
          </View>
        </Group>

        <Group title={words.groups.licences}>
          {input("pan")}
          {input("fssaiNumber")}
          {input("fssaiExpiry")}
        </Group>

        <Group title={words.groups.payments}>{input("upiId")}</Group>

        <View className="gap-2.5">
          {message && (
            <Text accessibilityLiveRegion="polite" className="text-secondary text-danger">
              {message}
            </Text>
          )}
          {justSaved && (
            <Text accessibilityLiveRegion="polite" className="text-secondary text-success">
              {words.saved}
            </Text>
          )}
          <Button label={saving ? words.saving : words.save} onPress={() => void save()} disabled={saving} />
        </View>

        <View className="gap-8 border-t border-border pt-8">
          <ThemePicker session={session} words={strings.theme} />
          <SignOut unsaved={changed(typed, saved)} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View className="gap-5">
      <Text accessibilityRole="header" className="text-title font-semibold text-text">
        {title}
      </Text>
      {children}
    </View>
  );
}

/** A labelled text box with its message under it, as on C15's Confirm location. */
function Input({ label, message, ...props }: TextInputProps & { label: string; message: string | null }) {
  const [focused, setFocused] = useState(false);
  return (
    <View>
      <Text className="text-label font-medium text-text">{label}</Text>
      <TextInput
        {...props}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        accessibilityLabel={label}
        className={`mt-2 rounded-input bg-surface px-4 font-sans text-body text-text ${props.multiline ? "min-h-24 py-3" : "h-[52px]"} ${edgeClass(message !== null, focused)}`}
      />
      {message && <FieldMessage text={message} />}
    </View>
  );
}

/** One side of the service radius stepper: a 48 by 48 button, off at the end of the range. */
function Step({ label, onPress, disabled, children }: { label: string; onPress: (() => void) | null; disabled: boolean; children: ReactNode }) {
  const off = disabled || onPress === null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: off }}
      disabled={off}
      onPress={onPress ?? undefined}
      className="h-12 w-12 items-center justify-center rounded-button border border-border-strong bg-surface active:bg-primary-subtle"
    >
      {children}
    </Pressable>
  );
}
