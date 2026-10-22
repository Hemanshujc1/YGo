import type { ApiResult } from "@ygo/api-client";
import type { Account, ErrorCode, SetProfileBody } from "@ygo/contracts";
import { useEffect, useRef, useState } from "react";
import { Keyboard, KeyboardAvoidingView, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PhoneField } from "./phone-field";
import { checkProfile, firstWrong, type ProfileProblems, saveOutcome } from "./profile-flow";
import { Button, edgeClass, FieldMessage, SupportEmail } from "./sign-in-parts";
import { Text } from "./text";

/** Every word C02 shows, from the app's `strings.ts`: the package holds none (ADR-0009). */
export type ProfileWords = {
  /** "Your name and phone number", in the top bar. */
  title: string;
  /** Who uses the name and phone, and one account per phone. */
  lead: string;
  nameLabel: string;
  /** Under the name when `PersonName` refuses it. */
  nameInvalid: string;
  phoneLabel: string;
  /** Under the phone when `Phone` refuses it. */
  phoneInvalid: string;
  /** The card under a phone in use: "Is it your number?" and what to do, before the support email. */
  inUse: { title: string; body: string };
  /** "Continue", and "Saving…" while it saves. */
  save: string;
  saving: string;
  signOut: string;
  /** Under the button when no answer came back. */
  offline: string;
  /** The app's words for each code the server answers; PHONE_IN_USE shows under the phone. */
  errors: Record<ErrorCode, string>;
};

/** The call C02 makes: the app's own client. */
interface ProfileApi {
  setProfile(body: SetProfileBody): Promise<ApiResult<Account>>;
}

export type ProfileProps = {
  words: ProfileWords;
  /** The address the phone-in-use card opens a new email to. */
  supportEmail: string;
  api: ProfileApi;
  /** The session's `signedIn`: the root layout then shows the app. */
  onSaved: (account: Account) => void;
  /**
   * The session's `signOut`: the root layout then shows C01, with the
   * failed-clear message when it resolves false (#155, Q5). It never
   * rejects; C02 only waits for it.
   */
  onSignOut: () => Promise<unknown>;
};

/**
 * C02 Your name and phone number (#155, Q4 and Q5): asked once after the
 * first sign-in, before anything else. The only other way off it is Sign out.
 * Both boxes start empty: the server saves the name and phone together, and
 * changes a name only once both are set, so an account here has neither.
 */
export function Profile({ words, supportEmail, api, onSaved, onSignOut }: ProfileProps) {
  const insets = useSafeAreaInsets();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [nameFocused, setNameFocused] = useState(false);
  const [problems, setProblems] = useState<ProfileProblems | null>(null);
  const [busy, setBusy] = useState<"saving" | "signing-out" | null>(null);
  // Set before React re-renders, so a second tap never saves or signs out twice.
  const working = useRef(false);
  const nameInput = useRef<TextInput>(null);
  const phoneInput = useRef<TextInput>(null);
  // The first wrong field, focused once the boxes take typing again: focus() on a locked box does nothing.
  const refocus = useRef<"name" | "phone" | null>(null);
  // While the keyboard is up, the footer sits on it, not on the home indicator.
  const [keyboardUp, setKeyboardUp] = useState(false);

  useEffect(() => {
    const shown = Keyboard.addListener("keyboardDidShow", () => setKeyboardUp(true));
    const hidden = Keyboard.addListener("keyboardDidHide", () => setKeyboardUp(false));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  useEffect(() => {
    if (busy || !refocus.current) return;
    (refocus.current === "name" ? nameInput : phoneInput).current?.focus();
    refocus.current = null;
  }, [busy, problems]);

  function show(next: ProfileProblems) {
    refocus.current = firstWrong(next);
    setProblems(next);
  }

  async function save() {
    if (working.current) return;
    const checked = checkProfile(name, phone);
    if ("problems" in checked) {
      show(checked.problems);
      return;
    }
    setProblems(null);
    working.current = true;
    setBusy("saving");
    let answer: ApiResult<Account> | "offline";
    try {
      answer = await api.setProfile(checked.body);
    } catch {
      answer = "offline";
    }
    const outcome = saveOutcome(answer);
    // Saved: the layout shows the app, so the screen stays locked until it goes.
    if ("saved" in outcome) {
      onSaved(outcome.saved);
      return;
    }
    working.current = false;
    setBusy(null);
    show(outcome.problems);
  }

  async function signOut() {
    if (working.current) return;
    working.current = true;
    setBusy("signing-out");
    await onSignOut();
    working.current = false;
    setBusy(null);
  }

  const phoneWrong = problems?.phone ?? null;
  const other = problems?.other ?? null;

  return (
    // Padding on Android too: edge to edge, the window no longer shrinks for the keyboard.
    <KeyboardAvoidingView behavior="padding" className="flex-1 bg-bg">
      <View style={{ paddingTop: insets.top }}>
        <View className="min-h-14 justify-center px-6">
          <Text accessibilityRole="header" className="text-headline font-semibold text-text">
            {words.title}
          </Text>
        </View>
      </View>

      <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="gap-6 px-6 py-4">
        <Text className="text-body text-muted">{words.lead}</Text>

        <View>
          <Text className="text-label font-medium text-text">{words.nameLabel}</Text>
          <TextInput
            ref={nameInput}
            value={name}
            onChangeText={(text) => {
              setName(text);
              setProblems((p) => p && { ...p, name: false, other: null });
            }}
            onFocus={() => setNameFocused(true)}
            onBlur={() => setNameFocused(false)}
            onSubmitEditing={() => phoneInput.current?.focus()}
            submitBehavior="submit"
            editable={!busy}
            textContentType="name"
            autoComplete="name"
            autoCapitalize="words"
            autoCorrect={false}
            returnKeyType="next"
            accessibilityLabel={words.nameLabel}
            className={`mt-2 h-[52px] rounded-input bg-surface px-4 font-sans text-body text-text ${edgeClass(problems?.name === true, nameFocused)}`}
          />
          {problems?.name && <FieldMessage text={words.nameInvalid} />}
        </View>

        <PhoneField
          ref={phoneInput}
          label={words.phoneLabel}
          value={phone}
          onChangeText={(text) => {
            setPhone(text);
            setProblems((p) => p && { ...p, phone: null, other: null });
          }}
          onSubmitEditing={() => void save()}
          editable={!busy}
          message={phoneWrong && (phoneWrong === "in-use" ? words.errors.PHONE_IN_USE : words.phoneInvalid)}
        />

        {phoneWrong === "in-use" && (
          <View className="gap-2 rounded-card border border-border bg-surface p-4">
            <Text className="text-body font-semibold text-text">{words.inUse.title}</Text>
            <Text className="text-secondary text-muted">{words.inUse.body}</Text>
            <SupportEmail address={supportEmail} className="text-label" />
          </View>
        )}
      </ScrollView>

      <View className="gap-2.5 border-t border-border bg-surface px-4 pt-3" style={{ paddingBottom: (keyboardUp ? 0 : insets.bottom) + 12 }}>
        {other && (
          <Text accessibilityLiveRegion="polite" className="text-secondary text-danger">
            {other === "offline" ? words.offline : words.errors[other]}
          </Text>
        )}
        <Button
          label={busy === "saving" ? words.saving : words.save}
          onPress={() => void save()}
          disabled={busy !== null}
        />
        <Button
          label={words.signOut}
          onPress={() => void signOut()}
          disabled={busy === "saving"}
          busy={busy === "signing-out"}
          variant="text"
        />
      </View>
    </KeyboardAvoidingView>
  );
}
