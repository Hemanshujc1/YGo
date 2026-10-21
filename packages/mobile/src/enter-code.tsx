import type { Account } from "@ygo/contracts";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, BackHandler, Platform, TextInput, View } from "react-native";
import {
  aboutField,
  type CheckOutcome,
  CODE_LENGTH,
  codeDigits,
  type Moment,
  moment,
  type Problem,
  secondsLeft,
  wholeCode,
} from "./sign-in-flow";
import { Button, edgeClass, HelpLine } from "./sign-in-parts";
import { problemWords, type SignInWords } from "./sign-in-words";
import { Text } from "./text";

type EnterCodeProps = {
  words: SignInWords;
  supportEmail: string;
  email: string;
  /** When the last code went to this email; the countdown runs from it. Null when none did. */
  sentAt: Moment | null;
  /** False after an expired code, a locked email or a spent code, until a new code is sent. */
  boxesOpen: boolean;
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
export function EnterCode(props: EnterCodeProps) {
  const { words, supportEmail, email, sentAt, boxesOpen, resend, check, onSignedIn, back } = props;
  const [digits, setDigits] = useState("");
  const [focused, setFocused] = useState(false);
  const [checking, setChecking] = useState(false);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<{ text: string; onField: boolean } | null>(null);
  const [now, setNow] = useState(moment);
  const input = useRef<TextInput>(null);
  // Set at once, before React re-renders: paste and autofill can bring two
  // changes in a row, and a code is checked or sent only once at a time.
  const busy = useRef(false);
  // Open the keypad again once a new code opens the boxes.
  const refocus = useRef(false);
  const left = secondsLeft(sentAt, now);
  const waiting = left > 0;
  const typing = boxesOpen && !checking && !sending;

  // Android Back goes to C01, not out of the app (#155, Q6), and waits while a
  // code is checked or sent, as "Use a different email" does.
  const leave = useRef(back);
  leave.current = back;
  useEffect(() => {
    const listener = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!busy.current) leave.current();
      return true;
    });
    return () => listener.remove();
  }, []);

  // focus() on a field that is not editable yet does nothing, so it waits for
  // the render that opens the boxes.
  useEffect(() => {
    if (typing && refocus.current) {
      refocus.current = false;
      input.current?.focus();
    }
  }, [typing]);

  // The clocks are read again each second and on every return to the app, so
  // the countdown shows the time really left (#155, S2).
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNow(moment()), 1000);
    const listener = AppState.addEventListener("change", () => setNow(moment()));
    return () => {
      clearInterval(timer);
      listener.remove();
    };
  }, [waiting]);

  async function typed(text: string) {
    if (busy.current) return;
    const next = codeDigits(text, digits);
    setDigits(next);
    setProblem(null);
    const code = wholeCode(next);
    if (!code) return;
    busy.current = true;
    setChecking(true);
    const outcome = await check(code);
    // Still busy once signed in: the field takes typing until C14 goes, and the spent code must not be checked again.
    if ("signedIn" in outcome) {
      onSignedIn(outcome.signedIn);
      return;
    }
    busy.current = false;
    // A closed field lets go of its focus, so focus() opens the keypad after a new code.
    if (!outcome.boxesOpen) input.current?.blur();
    setChecking(false);
    setDigits("");
    setProblem({ text: problemWords(words, outcome.problem, "check"), onField: aboutField(outcome.problem) });
  }

  async function sendAgain() {
    if (busy.current) return;
    busy.current = true;
    setSending(true);
    setProblem(null);
    const failed = await resend();
    busy.current = false;
    refocus.current = !failed;
    setSending(false);
    setNow(moment());
    if (failed) {
      setProblem({ text: problemWords(words, failed, "send"), onField: aboutField(failed) });
      return;
    }
    setDigits("");
  }

  const wrong = problem?.onField === true;

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
            const edge = edgeClass(wrong, current);
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
          // Editable while a code is checked or sent, so the keypad stays open
          // (#186); typing then is dropped. A field made not editable keeps its
          // focus but hides the keypad, and focus() then does nothing.
          editable={boxesOpen}
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
        <Button label={words.code.otherEmail} onPress={back} disabled={checking || sending} variant="text" />
      </View>

      <HelpLine before={words.code.spam} help={words.help} supportEmail={supportEmail} />
    </>
  );
}
