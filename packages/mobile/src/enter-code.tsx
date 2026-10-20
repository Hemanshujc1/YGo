import type { Account } from "@ygo/contracts";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, BackHandler, Platform, TextInput, View } from "react-native";
import { type CheckOutcome, CODE_LENGTH, codeDigits, type Problem, secondsLeft } from "./sign-in-flow";
import { Button, HelpLine } from "./sign-in-parts";
import { problemWords, type SignInWords } from "./sign-in-words";
import { Text } from "./text";

type EnterCodeProps = {
  words: SignInWords;
  supportEmail: string;
  email: string;
  /** When the last code went to this email; the countdown runs from it. */
  sentAt: number;
  /** Sends a new code: null when sent, or the problem. */
  resend: () => Promise<Problem | null>;
  check: (code: string) => Promise<CheckOutcome>;
  onSignedIn: (account: Account) => void;
  /** "Use a different email" and Android Back: C01, the email kept. */
  back: () => void;
};

/**
 * C14 Enter email code (#155, Q8): six boxes over one hidden field, so paste
 * and code autofill work. The 6th digit checks the code.
 */
export function EnterCode({ words, supportEmail, email, sentAt, resend, check, onSignedIn, back }: EnterCodeProps) {
  const [digits, setDigits] = useState("");
  const [focused, setFocused] = useState(false);
  const [checking, setChecking] = useState(false);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<{ text: string; during: "send" | "check" } | null>(null);
  // Shut after an expired code or a locked email, until a new code is sent.
  const [boxesOpen, setBoxesOpen] = useState(true);
  const [now, setNow] = useState(Date.now);
  const input = useRef<TextInput>(null);
  const left = secondsLeft(sentAt, now);
  const waiting = left > 0;

  // Android Back goes to C01, not out of the app (#155, Q6).
  useEffect(() => {
    const listener = BackHandler.addEventListener("hardwareBackPress", () => {
      back();
      return true;
    });
    return () => listener.remove();
  }, [back]);

  // The clock is read again each second and on every return to the app, so
  // the countdown shows the time really left (#155, S2).
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const listener = AppState.addEventListener("change", () => setNow(Date.now()));
    return () => {
      clearInterval(timer);
      listener.remove();
    };
  }, [waiting]);

  async function typed(text: string) {
    const next = codeDigits(text);
    setDigits(next);
    if (problem?.during === "check") setProblem(null);
    if (next.length < CODE_LENGTH) return;
    setProblem(null);
    setChecking(true);
    const outcome = await check(next);
    setChecking(false);
    if ("signedIn" in outcome) {
      onSignedIn(outcome.signedIn);
      return;
    }
    setDigits("");
    setBoxesOpen(outcome.boxesOpen);
    setProblem({ text: problemWords(words, outcome.problem, "check"), during: "check" });
    if (outcome.boxesOpen) input.current?.focus();
  }

  async function sendAgain() {
    setSending(true);
    setProblem(null);
    const failed = await resend();
    setSending(false);
    setNow(Date.now());
    if (failed) {
      setProblem({ text: problemWords(words, failed, "send"), during: "send" });
      return;
    }
    setDigits("");
    setBoxesOpen(true);
    input.current?.focus();
  }

  const typing = boxesOpen && !checking && !sending;
  const wrong = problem?.during === "check";

  return (
    <>
      <Text accessibilityRole="header" className="text-title-large font-semibold text-text">
        {words.code.title}
      </Text>
      <Text className="mt-2 text-body text-muted">{words.code.sentTo(email)}</Text>

      <Text className="mt-8 text-label font-medium text-text">{words.code.label}</Text>
      <View className="mt-2">
        <View className="flex-row gap-2" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {Array.from({ length: CODE_LENGTH }, (_, i) => {
            const current = focused && typing && i === Math.min(digits.length, CODE_LENGTH - 1);
            const edge = wrong ? "border-2 border-danger" : current ? "border-2 border-primary" : "border border-border-strong";
            return (
              <View
                key={i}
                className={`h-14 flex-1 items-center justify-center rounded-input ${typing ? "bg-surface" : "bg-disabled-bg"} ${edge}`}
              >
                <Text className={`text-title font-semibold tabular-nums ${typing ? "text-text" : "text-disabled-text"}`}>
                  {digits[i] ?? ""}
                </Text>
              </View>
            );
          })}
        </View>
        {/* Invisible, over the boxes: a tap on any box opens the keypad, and paste and autofill land here. */}
        <TextInput
          ref={input}
          value={digits}
          onChangeText={(text) => void typed(text)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          editable={typing}
          autoFocus
          caretHidden
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete={Platform.OS === "ios" ? "one-time-code" : "sms-otp"}
          accessibilityLabel={words.code.label}
          className="absolute inset-0 opacity-0"
        />
      </View>

      {checking && (
        <View className="mt-3 flex-row items-center gap-2" accessibilityLiveRegion="polite">
          <ActivityIndicator className="text-primary" />
          <Text className="text-secondary text-muted">{words.code.checking}</Text>
        </View>
      )}
      {problem && (
        <Text accessibilityLiveRegion="polite" className="mt-3 text-secondary text-danger">
          {problem.text}
        </Text>
      )}

      <View className="mt-8 gap-2">
        <Button
          label={waiting ? words.code.resendIn(left) : words.code.resend}
          onPress={() => void sendAgain()}
          disabled={waiting || checking}
          busy={sending}
        />
        <Button label={words.code.otherEmail} onPress={back} disabled={checking} variant="text" />
      </View>

      <HelpLine before={words.code.spam} help={words.help} supportEmail={supportEmail} />
    </>
  );
}
