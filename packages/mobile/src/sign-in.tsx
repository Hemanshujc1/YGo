import type { ApiResult } from "@ygo/api-client";
import { type Account, Email, type RequestCodeBody, type VerifyCodeBody } from "@ygo/contracts";
import { useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from "react-native";
import { EnterCode } from "./enter-code";
import {
  aboutField,
  checkOutcome,
  moment,
  needsSend,
  type Problem,
  rejected,
  type Sends,
  sendOutcome,
  withSend,
  withShut,
} from "./sign-in-flow";
import { Button, edgeClass, FieldMessage, HelpLine } from "./sign-in-parts";
import { problemWords, type SignInWords } from "./sign-in-words";
import { Text } from "./text";

/** The calls sign-in makes: the app's own client. */
interface SignInApi {
  requestCode(body: RequestCodeBody): Promise<ApiResult<undefined>>;
  verifyCode(body: VerifyCodeBody): Promise<ApiResult<Account>>;
}

export type SignInProps = {
  words: SignInWords;
  /** The address Help opens a new email to. */
  supportEmail: string;
  api: SignInApi;
  /** The session's `signedIn`: the root layout then shows C02 or the app. */
  onSignedIn: (account: Account) => void;
  /** A message C01 shows under the email until the person types (#155, Q5). */
  notice?: string;
};

/**
 * The last code sent to each email, kept outside the screen, so a remount
 * (the layout showing another state for a moment, Fast Refresh) keeps each
 * countdown and the shut boxes, and C01 never sends again into the server's
 * 30-second refusal. A sign-in clears it: that code is used.
 */
let memory: Sends = new Map();

/**
 * C01 Sign in, and C14 once a code is sent (#155, Q6–Q8). The root layout
 * shows it while signed out; there are no sign-in routes.
 */
export function SignIn({ words, supportEmail, api, onSignedIn, notice }: SignInProps) {
  // The email as typed, kept when C14 goes back to C01.
  const [typed, setTyped] = useState("");
  // The notice goes at the first keystroke, so C14 going back to C01 never shows it again.
  const [noticeGone, setNoticeGone] = useState(false);
  // The email C14 is open for; C01 while null.
  const [codeFor, setCodeFor] = useState<string | null>(null);
  const [sends, setSends] = useState(memory);
  const sent = codeFor ? sends.get(codeFor) : undefined;

  function remember(next: Sends) {
    memory = next;
    setSends(next);
  }

  async function send(email: string): Promise<Problem | null> {
    let answer: ApiResult<undefined> | "offline";
    try {
      answer = await api.requestCode({ email });
    } catch {
      answer = "offline";
    }
    const problem = sendOutcome(answer);
    if (!problem) remember(withSend(memory, email, moment()));
    return problem;
  }

  async function check(email: string, code: string) {
    let outcome;
    try {
      outcome = checkOutcome(await api.verifyCode({ email, code }));
    } catch (error) {
      outcome = checkOutcome(rejected(error));
    }
    if ("signedIn" in outcome) remember(new Map());
    else if (!outcome.boxesOpen) remember(withShut(memory, email));
    return outcome;
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} className="flex-1 bg-bg">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="grow justify-center px-4 py-16"
      >
        {codeFor ? (
          <EnterCode
            words={words}
            supportEmail={supportEmail}
            email={codeFor}
            sentAt={sent?.at ?? null}
            boxesOpen={!sent?.shut}
            resend={() => send(codeFor)}
            check={(code) => check(codeFor, code)}
            onSignedIn={onSignedIn}
            back={() => setCodeFor(null)}
          />
        ) : (
          <EmailStep
            words={words}
            supportEmail={supportEmail}
            typed={typed}
            setTyped={(text) => {
              setTyped(text);
              setNoticeGone(true);
            }}
            notice={noticeGone ? undefined : notice}
            send={async (email) => {
              const problem = needsSend(email, memory, moment()) ? await send(email) : null;
              if (!problem) setCodeFor(email);
              return problem;
            }}
          />
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

type EmailStepProps = {
  words: SignInWords;
  supportEmail: string;
  typed: string;
  setTyped: (text: string) => void;
  notice: string | undefined;
  /** Sends a code to the checked email, or goes straight to C14: null, or the problem. */
  send: (email: string) => Promise<Problem | null>;
};

/** C01: the email and "Email me a code". A send that fails stays here, with its message under the email (#155, Q7). */
function EmailStep({ words, supportEmail, typed, setTyped, notice, send }: EmailStepProps) {
  const [focused, setFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  // Set before React re-renders, so the return key and the button never send twice.
  const sending = useRef(false);
  const [problem, setProblem] = useState<{ text: string; onField: boolean } | null>(null);

  async function submit() {
    if (sending.current) return;
    const email = Email.safeParse(typed);
    if (!email.success) {
      setProblem({ text: words.emailInvalid, onField: true });
      return;
    }
    setProblem(null);
    sending.current = true;
    setBusy(true);
    const failed = await send(email.data);
    sending.current = false;
    setBusy(false);
    if (failed) setProblem({ text: problemWords(words, failed, "send"), onField: aboutField(failed) });
  }

  return (
    <>
      <Text accessibilityRole="header" className="text-display font-semibold text-text">
        {words.title}
      </Text>
      {words.heading && <Text className="mt-2 text-title font-semibold text-text">{words.heading}</Text>}
      <Text className="mt-2 text-body text-muted">{words.lead}</Text>

      {/* Google and Apple go here (#36). */}
      <View className="mt-8" />

      <Text className="text-label font-medium text-text">{words.emailLabel}</Text>
      <TextInput
        value={typed}
        onChangeText={(text) => {
          setTyped(text);
          setProblem(null);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onSubmitEditing={() => void submit()}
        editable={!busy}
        keyboardType="email-address"
        textContentType="emailAddress"
        autoComplete="email"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="send"
        accessibilityLabel={words.emailLabel}
        className={`mt-2 h-[52px] rounded-input bg-surface px-4 font-sans text-body text-text ${edgeClass(problem?.onField === true, focused)}`}
      />
      {problem ? (
        <FieldMessage text={problem.text} />
      ) : (
        notice && (
          <Text accessibilityLiveRegion="polite" className="mt-2 text-secondary text-text">
            {notice}
          </Text>
        )
      )}

      <View className="mt-6">
        <Button label={words.send} onPress={() => void submit()} busy={busy} />
      </View>

      <HelpLine help={words.help} supportEmail={supportEmail} />
    </>
  );
}
