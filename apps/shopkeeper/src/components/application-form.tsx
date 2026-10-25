import { type SendShopApplicationBody, type ShopApplication, ShopEntityType } from "@ygo/contracts";
import { formatNumber, formatPhone } from "@ygo/format";
import { Button, edgeClass, FieldMessage, findPlace, type Locator, Text, ThemePicker } from "@ygo/mobile";
import * as Location from "expo-location";
import { type ReactNode, useRef, useState } from "react";
import { KeyboardAvoidingView, Linking, Pressable, ScrollView, TextInput, type TextInputProps, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, session } from "../api";
import {
  changed,
  draftBody,
  type Field,
  realDate,
  sendBody,
  shown,
  stepRadius,
  type TextField,
  type Typed,
  typedFrom,
} from "../lib/application-form";
import { strings } from "../strings";
import { Confirm } from "./confirm";
import { MapPin, Minus, Plus } from "./icons";
import { SignOut } from "./sign-out";

const words = strings.application.form;

const locator: Locator = {
  askPermission: async () => (await Location.requestForegroundPermissionsAsync()).granted,
  servicesOn: () => Location.hasServicesEnabledAsync(),
  // The most accurate fix the phone gives, since the pin marks the shop itself (#295, Q2).
  position: async () => (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest })).coords,
};

/** A fix less accurate than this keeps the location and shows a hint to try again (#276, Q9). */
const roughMetres = 100;

/** Why "use this location" found nothing. */
const problems = { off: words.location.off, "phone-off": words.location.phoneOff, "not-found": words.location.notFound };

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
 * S17 Shop application while it is a Draft (#294, #295): one scrolling form
 * in four groups with Send and Save draft. Save draft checks each filled-in
 * field with the server's rule, and an empty one is fine (#276, Q5). Send
 * checks every field with the server's Send rule, then asks first (Q6).
 * `onSent` gets the sent application from this phone, or nothing when it
 * was sent from another phone and must be loaded.
 */
export function ApplicationForm({ application, onSent }: { application: ShopApplication; onSent: (sent?: ShopApplication) => void }) {
  const insets = useSafeAreaInsets();
  const [saved, setSaved] = useState(() => typedFrom(application));
  const [typed, setTyped] = useState(saved);
  // Each marked field's message.
  const [wrong, setWrong] = useState<Partial<Record<Field, string>>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  // The checked body while Send asks first.
  const [asking, setAsking] = useState<SendShopApplicationBody | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [locating, setLocating] = useState(false);
  // This visit's fix: a reopened Draft has only the saved location, with no accuracy (#295, Q3).
  const [fix, setFix] = useState<{ accuracy: number | null } | null>(null);
  const [problem, setProblem] = useState<keyof typeof problems | null>(null);
  // Set before React re-renders, so a second tap never saves, sends or looks twice.
  const working = useRef(false);
  const looking = useRef(false);
  const busy = saving || sending;

  function edit(field: Field | "serviceRadiusMetres", next: Partial<Typed>) {
    setTyped((now) => ({ ...now, ...next }));
    setWrong((now) => Object.fromEntries(Object.entries(now).filter(([named]) => named !== field)));
    setMessage(null);
    setJustSaved(false);
  }

  /**
   * Marks each named field with its message, replacing an old location
   * problem. A real licence date that is refused has passed (#295, Q5).
   */
  function mark(fields: Field[]) {
    setProblem(null);
    setWrong(Object.fromEntries(fields.map((field) => [field, field === "fssaiExpiry" && realDate(typed) ? words.fssaiExpiry.expired : words[field].invalid])));
  }

  async function locate() {
    if (looking.current) return;
    looking.current = true;
    setLocating(true);
    setProblem(null);
    setFix(null);
    const found = await findPlace(locator);
    looking.current = false;
    setLocating(false);
    if (found.kind !== "found") return setProblem(found.kind);
    setFix({ accuracy: found.accuracy });
    edit("location", { location: found.point });
  }

  async function save() {
    if (working.current) return;
    setJustSaved(false);
    setProblem(null);
    const draft = draftBody(typed);
    if (!draft.ok) {
      mark(draft.wrong);
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
      if (answer.code === "SHOP_APPLICATION_SENT") return onSent();
      const named = shown(answer.fields);
      mark(named);
      return setMessage(named.length > 0 ? words.wrong : strings.errors[answer.code]);
    }
    const next = typedFrom(answer.data);
    setSaved(next);
    setTyped(next);
    setWrong({});
    setJustSaved(true);
  }

  /** Send tapped: checks every field first, then asks (#295, Q5). */
  function ask() {
    if (working.current) return;
    setJustSaved(false);
    const checked = sendBody(typed);
    if (!checked.ok) {
      mark(checked.wrong);
      return setMessage(words.wrong);
    }
    setMessage(null);
    setProblem(null);
    setAsking(checked.body);
  }

  async function send(body: SendShopApplicationBody) {
    setAsking(null);
    if (working.current) return;
    working.current = true;
    setSending(true);
    const answer = await api.sendShopApplication(body).catch(() => null);
    working.current = false;
    setSending(false);
    if (!answer) return setMessage(words.sendOffline);
    // The answer is the sent application, so S18 needs no second request (#295 review, Q4).
    if (answer.ok) return onSent(answer.data);
    if (answer.code === "SHOP_APPLICATION_SENT") return onSent();
    if (answer.code === "PINCODE_NOT_IN_AREA") {
      setWrong({ pincode: words.pincode.notInArea });
      return setMessage(words.wrong);
    }
    const named = shown(answer.fields);
    mark(named);
    setMessage(named.length > 0 ? words.wrong : strings.errors[answer.code]);
  }

  function input(field: TextField) {
    return (
      <Input
        label={words[field].label}
        value={typed[field]}
        onChangeText={(value) => edit(field, { [field]: value })}
        message={wrong[field] ?? null}
        editable={!busy}
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
            <Text className="text-label font-medium text-text">{words.location.label}</Text>
            {typed.location && (
              <Text accessibilityLiveRegion="polite" className="text-body text-text">
                {fix === null
                  ? words.location.saved
                  : fix.accuracy === null
                    ? words.location.foundNoAccuracy
                    : words.location.found(formatNumber(Math.round(fix.accuracy)))}
              </Text>
            )}
            {fix !== null && fix.accuracy !== null && fix.accuracy > roughMetres && <Text className="text-secondary text-muted">{words.location.rough}</Text>}
            <View className="mt-1">
              <Button label={words.location.use} onPress={() => void locate()} busy={locating} disabled={busy} variant="secondary" icon={MapPin} alignStart />
            </View>
            {problem ? <FieldMessage text={problems[problem]} /> : wrong.location !== undefined && <FieldMessage text={wrong.location} />}
            {problem === "off" && <Button label={words.location.openSettings} onPress={() => void Linking.openSettings()} variant="text" />}
          </View>
          <View className="gap-1.5">
            <Text className="text-label font-medium text-text">{words.radius.label}</Text>
            <Text className="text-secondary text-muted">{words.radius.hint}</Text>
            <View className="flex-row items-center gap-4">
              <Step label={words.radius.less} onPress={less === null ? null : () => edit("serviceRadiusMetres", { serviceRadiusMetres: less })} disabled={busy}>
                <Minus size={24} className={less === null || busy ? "text-disabled-text" : "text-primary"} />
              </Step>
              <Text accessibilityLiveRegion="polite" className="min-w-16 text-center text-headline font-semibold text-text">
                {words.radius.value(formatNumber(radius / 1000))}
              </Text>
              <Step label={words.radius.more} onPress={more === null ? null : () => edit("serviceRadiusMetres", { serviceRadiusMetres: more })} disabled={busy}>
                <Plus size={24} className={more === null || busy ? "text-disabled-text" : "text-primary"} />
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
                  accessibilityState={{ checked: typed.entityType === type, disabled: busy }}
                  disabled={busy}
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
            {wrong.entityType !== undefined && <FieldMessage text={wrong.entityType} />}
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
          {/* Off while finding the location too, so a save landing after the fix can't replace it. */}
          <Button label={sending ? words.sending : words.send} onPress={ask} disabled={busy || locating} />
          <Button label={saving ? words.saving : words.save} onPress={() => void save()} disabled={busy || locating} variant="secondary" />
          <Confirm
            visible={asking !== null}
            title={strings.application.confirmSend.title}
            body={strings.application.confirmSend.body}
            confirm={strings.application.confirmSend.send}
            cancel={strings.application.confirmSend.cancel}
            onConfirm={() => {
              if (asking) void send(asking);
            }}
            onCancel={() => setAsking(null)}
          />
        </View>

        <View className="gap-8 border-t border-border pt-8">
          <ThemePicker session={session} words={strings.theme} />
          <SignOut unsaved={changed(typed, saved)} disabled={busy} />
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
