import { formatDateTime } from "@ygo/format";
import { Button, FieldMessage, PhoneField, Text } from "@ygo/mobile";
import { Link, useLocalSearchParams, useRouter } from "expo-router";
import { useRef, useState } from "react";
import { Pressable, ScrollView, Share, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { access, api } from "../api";
import { Toggle } from "../components/toggle";
import { personLabel, readInvitePhone } from "../lib/staff";
import { strings } from "../strings";

const words = strings.staff;

/** The code is kept only here, in memory: the server stores a digest and never shows it again. */
type Sent = { code: string; expiresAt: string; phone: string };

/**
 * S20 Invite staff (#535): the number, `can deliver`, then the one-time join code. Opened from S16 with a number and
 * flag filled in to send a new code or invite a deactivated person again (ACC-7). A number linked to another shop is
 * refused by the server with its own message (ACC-4).
 */
export default function InviteStaffScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ phone?: string; canDeliver?: string }>();
  const [phone, setPhone] = useState(() => (params.phone ?? "").replace(/^\+91/, ""));
  const [canDeliver, setCanDeliver] = useState(params.canDeliver === "1");
  const [tried, setTried] = useState(false);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  // Set before React re-renders, so a second tap never asks for a second code.
  const working = useRef(false);
  const read = readInvitePhone(phone);

  async function send() {
    if (working.current) return;
    setTried(true);
    if (!read) return;
    working.current = true;
    setSending(true);
    setProblem(null);
    const answer = await api.inviteStaff({ phone: read, canDeliver }).catch(() => null);
    working.current = false;
    setSending(false);
    if (!answer?.ok) return setProblem(answer ? strings.errors[answer.code] : words.saveFailed);
    setSent({ code: answer.data.code, expiresAt: answer.data.expiresAt, phone: read });
  }

  return (
    <ScrollView
      className="flex-1 bg-bg"
      contentContainerClassName="gap-4 px-4"
      contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 32 }}
      keyboardShouldPersistTaps="handled"
    >
      <Link href="/staff" replace asChild><Pressable accessibilityRole="button" className="min-h-12 justify-center self-start"><Text className="text-body font-semibold text-primary">‹ {words.back}</Text></Pressable></Link>
      <Text accessibilityRole="header" className="text-title-large font-semibold text-text">{words.inviteTitle}</Text>
      {sent ? <>
        <Text accessibilityRole="header" className="text-headline font-semibold text-text">{words.codeTitle(personLabel({ name: null, phone: sent.phone }))}</Text>
        <View className="items-center rounded-card border border-border bg-surface px-4 py-6">
          <Text accessibilityLabel={sent.code.split("").join(" ")} className="text-display font-semibold tabular-nums text-text">{sent.code}</Text>
        </View>
        <Text className="text-body text-text">{words.codeRule(formatDateTime(sent.expiresAt))}</Text>
        <Text className="text-secondary text-muted">{words.codeLost}</Text>
        <Button label={words.shareButton} onPress={() => void Share.share({ message: words.share(sent.code, access.shopName() ?? words.shopFallback) }).catch(() => undefined)} />
        <Button label={words.done} variant="secondary" onPress={() => router.replace("/staff")} />
      </> : <>
        <PhoneField label={words.phone} value={phone} editable={!sending} autofill={false} onSubmitEditing={() => void send()}
          onChangeText={(text) => { setPhone(text); setProblem(null); }} message={tried && !read ? words.phoneWrong : null} />
        <View className="flex-row items-center justify-between gap-3">
          <View className="flex-1"><Text className="text-body text-text">{words.canDeliver}</Text><Text className="text-secondary text-muted">{words.canDeliverHint}</Text></View>
          <Toggle on={canDeliver} busy={sending} label={words.canDeliver} onPress={() => setCanDeliver((now) => !now)} />
        </View>
        {problem && <FieldMessage text={problem} />}
        <Button label={sending ? words.sending : words.send} onPress={() => void send()} busy={sending} />
      </>}
    </ScrollView>
  );
}
