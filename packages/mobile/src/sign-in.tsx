import type { ApiResult } from "@ygo/api-client";
import { type Account, Email, type RequestCodeBody, type VerifyCodeBody } from "@ygo/contracts";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from "react-native";
import { EnterCode } from "./enter-code";
import { checkOutcome, type LastSend, needsSend, type Problem, sendOutcome } from "./sign-in-flow";
import { Button, HelpLine } from "./sign-in-parts";
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
};

/**
 * C01 Sign in, and C14 once a code is sent (#155, Q6–Q8). The root layout
 * shows it while signed out; there are no sign-in routes.
 */
export function SignIn({ words, supportEmail, api, onSignedIn }: SignInProps) {
  // The email as typed, kept when C14 goes back to C01.
  const [typed, setTyped] = useState("");
  // The email C14 is open for; C01 while null.
  const [codeFor, setCodeFor] = useState<string | null>(null);
  const [last, setLast] = useState<LastSend | null>(null);

  async function send(email: string): Promise<Problem | null> {
    let answer: ApiResult<undefined> | "offline";
    try {
      answer = await api.requestCode({ email });
    } catch {
      answer = "offline";
    }
    const problem = sendOutcome(answer);
    if (!problem) setLast({ email, at: Date.now() });
    return problem;
  }

  async function check(email: string, code: string) {
    try {
      return checkOutcome(await api.verifyCode({ email, code }));
    } catch {
      return checkOutcome("offline");
    }
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
            sentAt={last?.email === codeFor ? last.at : 0}
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
            setTyped={setTyped}
            send={async (email) => {
              const problem = needsSend(email, last, Date.now()) ? await send(email) : null;
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
  /** Sends a code to the checked email, or goes straight to C14: null, or the problem. */
  send: (email: string) => Promise<Problem | null>;
};

/** C01: the email and "Email me a code". A send that fails stays here, with its message under the email (#155, Q7). */
function EmailStep({ words, supportEmail, typed, setTyped, send }: EmailStepProps) {
  const [focused, setFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit() {
    const email = Email.safeParse(typed);
    if (!email.success) {
      setProblem(words.emailInvalid);
      return;
    }
    setProblem(null);
    setBusy(true);
    const failed = await send(email.data);
    setBusy(false);
    if (failed) setProblem(problemWords(words, failed, "send"));
  }

  const edge = problem ? "border-2 border-danger" : focused ? "border-2 border-primary" : "border border-border-strong";

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
        className={`mt-2 h-[52px] rounded-input bg-surface px-4 font-sans text-body text-text ${edge}`}
      />
      {problem && (
        <Text accessibilityLiveRegion="polite" className="mt-2 text-secondary text-danger">
          {problem}
        </Text>
      )}

      <View className="mt-6">
        <Button label={words.send} onPress={() => void submit()} busy={busy} />
      </View>

      <HelpLine help={words.help} supportEmail={supportEmail} />
    </>
  );
}
