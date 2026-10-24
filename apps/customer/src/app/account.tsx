import type { ApiResult } from "@ygo/api-client";
import { type Account, ChangeNameBody, type ErrorCode } from "@ygo/contracts";
import { formatPhone } from "@ygo/format";
import { Button, edgeClass, FieldMessage, SupportEmail, Text, ThemePicker, useSession } from "@ygo/mobile";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, session, supportEmail } from "../api";
import { LogOut, Mail, Phone, User } from "../components/icons";
import { TopBar } from "../components/top-bar";
import { strings } from "../strings";

const words = strings.account;

/** One row of a list card: an icon, then what it shows. */
function Row({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <View className="min-h-14 flex-row items-center gap-3 px-4 py-3">{icon}{children}</View>;
}

/** A row's label over its value: "Name" over the name. */
function Field({ label, value, numbers }: { label: string; value: string; numbers?: boolean }) {
  return (
    <View className="flex-1">
      <Text className="text-secondary text-muted">{label}</Text>
      <Text className={`text-body text-text ${numbers ? "tabular-nums" : ""}`}>{value}</Text>
    </View>
  );
}

/**
 * C23 Account (#156): the name, which can be changed, the email and phone,
 * which only support changes, the theme, Help and Sign out.
 */
export default function AccountScreen() {
  const insets = useSafeAreaInsets();
  const state = useSession(session);
  const [changing, setChanging] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  // Set before React re-renders, so a second tap never signs out twice.
  const leaving = useRef(false);

  // The gate shows the app only when signed in; this tells TypeScript.
  if (state.status !== "signed-in") return null;
  const { account } = state;

  return (
    <View className="flex-1 bg-bg" style={{ paddingTop: insets.top }}>
      <TopBar title={words.title} />

      <ScrollView
        contentContainerClassName="gap-4 px-4 pt-2"
        contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
      >
        <View className="overflow-hidden rounded-card border border-border bg-surface">
          <Row icon={<User size={20} className="text-muted" />}>
            <Field label={words.name} value={account.name ?? ""} />
            <Button label={words.changeName} onPress={() => setChanging(true)} disabled={signingOut} variant="text" />
          </Row>
          <View className="border-t border-border">
            <Row icon={<Mail size={20} className="text-muted" />}>
              <Field label={words.email} value={account.email} />
            </Row>
          </View>
          <View className="border-t border-border">
            <Row icon={<Phone size={20} className="text-muted" />}>
              <Field label={words.phone} value={formatPhone(account.phone ?? "")} numbers />
            </Row>
          </View>
        </View>
        <Text className="text-caption text-muted">
          {`${words.changeContact} `}
          <SupportEmail address={supportEmail} className="text-caption" />
          {words.changeContactEnd}
        </Text>

        <ThemePicker session={session} words={strings.theme} />

        <View className="overflow-hidden rounded-card border border-border bg-surface">
          <Row icon={<Mail className="text-muted" />}>
            <View className="flex-1">
              <Text className="text-body text-text">{words.help}</Text>
              <SupportEmail address={supportEmail} className="text-secondary" />
            </View>
          </Row>
        </View>

        <View className="overflow-hidden rounded-card border border-border bg-surface">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={strings.profile.signOut}
            accessibilityState={{ disabled: signingOut, busy: signingOut }}
            disabled={signingOut}
            onPress={() => {
              if (leaving.current) return;
              leaving.current = true;
              setSigningOut(true);
              // The gate shows C01 once it settles, with a notice if the phone could not clear it.
              void session.signOut();
            }}
            className="active:bg-primary-subtle"
          >
            <Row icon={<LogOut className="text-muted" />}>
              <Text className="flex-1 text-body text-text">{strings.profile.signOut}</Text>
              {signingOut && <ActivityIndicator className="text-primary" />}
            </Row>
          </Pressable>
        </View>
      </ScrollView>

      {changing && <ChangeName account={account} onClose={() => setChanging(false)} />}
    </View>
  );
}

type Problem = "invalid" | "offline" | ErrorCode;

/**
 * The Change name sheet: the current name to edit, checked with the
 * server's own rule. It stays open until the name is saved or the person
 * cancels.
 */
function ChangeName({ account, onClose }: { account: Account; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const [name, setName] = useState(account.name ?? "");
  const [focused, setFocused] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [saving, setSaving] = useState(false);
  // Set before React re-renders, so a second tap never saves twice.
  const working = useRef(false);
  // While the keyboard is up, the sheet sits on it, not on the home indicator.
  const [keyboardUp, setKeyboardUp] = useState(false);
  const input = useRef<TextInput>(null);

  // After a refusal the box takes typing again; put the cursor back in it.
  useEffect(() => {
    if (!saving && problem) input.current?.focus();
  }, [saving, problem]);

  useEffect(() => {
    const shown = Keyboard.addListener("keyboardDidShow", () => setKeyboardUp(true));
    const hidden = Keyboard.addListener("keyboardDidHide", () => setKeyboardUp(false));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  function close() {
    if (!working.current) onClose();
  }

  async function save() {
    if (working.current) return;
    const checked = ChangeNameBody.safeParse({ name });
    if (!checked.success) {
      setProblem("invalid");
      return;
    }
    working.current = true;
    setSaving(true);
    setProblem(null);
    let answer: ApiResult<Account> | "offline";
    try {
      answer = await api.changeName(checked.data);
    } catch {
      answer = "offline";
    }
    working.current = false;
    setSaving(false);
    if (answer === "offline") {
      setProblem("offline");
    } else if (answer.ok) {
      session.signedIn(answer.data);
      onClose();
    } else {
      // The server checks only the name, so a refusal of the request is a refusal of the name.
      setProblem(answer.code === "VALIDATION_FAILED" ? "invalid" : answer.code);
    }
  }

  const message =
    problem === null || problem === "invalid"
      ? null
      : problem === "offline"
        ? strings.profile.offline
        : strings.errors[problem];

  return (
    <Modal transparent visible animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={close}>
      {/* Padding on Android too: edge to edge, the window no longer shrinks for the keyboard. */}
      <KeyboardAvoidingView behavior="padding" className="flex-1 justify-end bg-scrim">
        <Pressable accessibilityRole="button" accessibilityLabel={words.sheet.cancel} onPress={close} className="flex-1" />
        <View
          className="gap-4 rounded-t-sheet bg-raised px-4 pt-2"
          style={{ paddingBottom: (keyboardUp ? 0 : insets.bottom) + 16 }}
        >
          <View className="my-1 h-1 w-9 self-center rounded-full bg-border-strong" />
          <Text accessibilityRole="header" className="text-headline font-semibold text-text">
            {words.sheet.title}
          </Text>
          <View>
            <Text className="text-label font-medium text-text">{words.sheet.label}</Text>
            <TextInput
              ref={input}
              value={name}
              onChangeText={(text) => {
                setName(text);
                setProblem(null);
              }}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onSubmitEditing={() => void save()}
              autoFocus
              submitBehavior="submit"
              editable={!saving}
              textContentType="name"
              autoComplete="name"
              autoCapitalize="words"
              autoCorrect={false}
              returnKeyType="done"
              accessibilityLabel={words.sheet.label}
              className={`mt-2 h-[52px] rounded-input bg-surface px-4 font-sans text-body text-text ${edgeClass(problem === "invalid", focused)}`}
            />
            {problem === "invalid" ? (
              <FieldMessage text={strings.profile.nameInvalid} />
            ) : (
              <Text className="mt-2 text-secondary text-muted">{words.sheet.hint}</Text>
            )}
          </View>
          {message && (
            <Text accessibilityLiveRegion="polite" className="text-secondary text-danger">
              {message}
            </Text>
          )}
          <View className="gap-2.5">
            <Button label={saving ? words.sheet.saving : words.sheet.save} onPress={() => void save()} disabled={saving} />
            <Button label={words.sheet.cancel} onPress={close} disabled={saving} variant="text" />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
