import type { ApiResult } from "@ygo/api-client";
import type { JoinShopBody, JoinShopResponse } from "@ygo/contracts";
import { JOIN_CODE_LENGTH } from "@ygo/contracts";
import { useRef, useState } from "react";
import { TextInput, View } from "react-native";
import { cleanCode, type JoinProblem, tryJoin } from "./join-shop-flow";
import { Button, edgeClass, FieldMessage } from "./sign-in-parts";
import { Text } from "./text";

export type JoinShopWords = {
  title: string;
  body: string;
  label: string;
  hint: string;
  button: string;
  checking: string;
  problems: Record<JoinProblem, string>;
  joinedTitle: (shopName: string | null) => string;
  joinedBody: string;
  done: string;
  /** Shown with "Try again" when the app could not take up the new shop link right after joining. */
  refreshButton: string;
};

type JoinShopProps = {
  words: JoinShopWords;
  join: (body: JoinShopBody) => Promise<ApiResult<JoinShopResponse>>;
  /** Runs once the server has linked the account: a message when the app could not take up the new link, else null. */
  onJoined: (shopName: string | null) => Promise<string | null>;
  onDone: () => void;
};

/**
 * S21 Join a shop (#536): the invited person types the one-time code the Owner shows. Built once for the Customer's C23
 * and the Shopkeeper's not-linked screen. States: empty, checking, wrong, expired (and locked, linked, offline), joined.
 */
export function JoinShop({ words, join, onJoined, onDone }: JoinShopProps) {
  const [code, setCode] = useState("");
  const [focused, setFocused] = useState(false);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<JoinProblem | null>(null);
  const [joined, setJoined] = useState<{ shopName: string | null; message: string | null } | null>(null);
  // Set before React re-renders, so a second tap or Enter never sends the code twice.
  const busy = useRef(false);

  async function take(shopName: string | null) {
    setJoined({ shopName, message: await onJoined(shopName).catch(() => words.problems.other) });
  }

  async function send() {
    if (busy.current) return;
    busy.current = true;
    setChecking(true);
    setProblem(null);
    const outcome = await tryJoin(code, join);
    if ("problem" in outcome) setProblem(outcome.problem);
    else await take(outcome.shopName);
    busy.current = false;
    setChecking(false);
  }

  async function again() {
    if (busy.current || !joined) return;
    busy.current = true;
    setChecking(true);
    await take(joined.shopName);
    busy.current = false;
    setChecking(false);
  }

  if (joined) {
    return (
      <View className="gap-4">
        <Text accessibilityRole="header" className="text-title-large font-semibold text-text">{words.joinedTitle(joined.shopName)}</Text>
        {joined.message ? (
          <>
            <Text accessibilityLiveRegion="polite" className="text-body text-danger">{joined.message}</Text>
            <Button label={words.refreshButton} onPress={() => void again()} busy={checking} />
          </>
        ) : (
          <>
            <Text className="text-body text-text">{words.joinedBody}</Text>
            <Button label={words.done} onPress={onDone} />
          </>
        )}
      </View>
    );
  }

  const failed = problem !== null && problem !== "short";
  return (
    <View className="gap-4">
      <Text accessibilityRole="header" className="text-title-large font-semibold text-text">{words.title}</Text>
      <Text className="text-body text-muted">{words.body}</Text>
      <View>
        <Text className="text-label font-medium text-text">{words.label}</Text>
        <TextInput
          value={code}
          onChangeText={(text) => { setCode(cleanCode(text)); setProblem(null); }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onSubmitEditing={() => void send()}
          editable={!checking}
          autoCapitalize="characters"
          autoCorrect={false}
          autoComplete="off"
          returnKeyType="done"
          submitBehavior="submit"
          accessibilityLabel={words.label}
          maxLength={JOIN_CODE_LENGTH * 2}
          className={`mt-2 h-[52px] rounded-input bg-surface px-4 font-sans text-body tabular-nums text-text ${edgeClass(problem !== null, focused)}`}
        />
        {problem === "short" ? <FieldMessage text={words.problems.short} /> : <Text className="mt-2 text-secondary text-muted">{words.hint}</Text>}
      </View>
      {failed && <Text accessibilityLiveRegion="polite" className="text-secondary text-danger">{words.problems[problem]}</Text>}
      <Button label={checking ? words.checking : words.button} onPress={() => void send()} busy={checking} />
    </View>
  );
}
