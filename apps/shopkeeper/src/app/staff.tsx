import type { ShopStaff, StaffInvite } from "@ygo/contracts";
import { formatDateTime } from "@ygo/format";
import { Button, Confirm, Text, useInFront } from "@ygo/mobile";
import { Link, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../api";
import { Toggle } from "../components/toggle";
import { codeRanOut, personLabel } from "../lib/staff";
import { strings } from "../strings";

const words = strings.staff;

type Load = { kind: "loading" } | { kind: "failed"; message: string } | { kind: "loaded"; staff: ShopStaff[]; invites: StaffInvite[] };

/**
 * S16 Staff (#535): who works in the shop with the `can deliver` switch and Deactivate, who is invited, and who was
 * deactivated and can be invited again (ACC-6, ACC-7, ACC-11). Reads again each time the screen is in front.
 */
export default function StaffScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [asking, setAsking] = useState<ShopStaff | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Set before React re-renders, so a second tap never starts a second change.
  const working = useRef(false);
  // Only the newest read may draw, so an older answer arriving late never brings back a removed person.
  const newest = useRef(0);

  const read = useCallback(async () => {
    const mine = ++newest.current;
    const [staff, invites] = await Promise.all([api.shopStaff().catch(() => null), api.staffInvites().catch(() => null)]);
    if (mine !== newest.current) return;
    if (!staff?.ok || !invites?.ok) {
      const refused = staff && !staff.ok ? staff : invites && !invites.ok ? invites : null;
      const text = refused ? strings.errors[refused.code] : words.loadFailed;
      // A list already on screen stays, with the reason above it, so the Owner knows it may be old.
      setMessage(text);
      return setLoad((now) => now.kind === "loaded" ? now : { kind: "failed", message: text });
    }
    setLoad({ kind: "loaded", staff: staff.data.staff, invites: invites.data.invites });
  }, []);
  const start = useCallback(() => { setMessage(null); void read(); }, [read]);
  const pull = useCallback(async () => { setRefreshing(true); await read(); setRefreshing(false); }, [read]);
  const stop = useCallback(() => undefined, []);
  useInFront({ start, stop });

  async function change(id: string, run: () => Promise<{ ok: true } | { ok: false; code: keyof typeof strings.errors }>) {
    if (working.current) return;
    working.current = true;
    setBusy(id);
    setMessage(null);
    const answer = await run().catch(() => null);
    working.current = false;
    setBusy(null);
    if (!answer?.ok) setMessage(answer ? strings.errors[answer.code] : words.saveFailed);
    // The server's list is the truth: read it again rather than patching what the screen holds.
    await read();
  }

  const setFlag = (person: ShopStaff) => change(person.accountId, () => api.setStaffCanDeliver(person.accountId, { canDeliver: !person.canDeliver }));
  const deactivate = (person: ShopStaff) => {
    setAsking(null);
    return change(person.accountId, () => api.deactivateStaff(person.accountId));
  };

  const staff = load.kind === "loaded" ? load.staff : [];
  const invited = load.kind === "loaded" ? load.invites.filter((invite) => invite.status === "invited") : [];
  const removed = load.kind === "loaded" ? load.invites.filter((invite) => invite.status === "deactivated") : [];

  return (
    <View className="flex-1 bg-bg">
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-4 px-4"
        contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void pull()} progressViewOffset={insets.top} />}
      >
        <Link href="/" asChild><Pressable accessibilityRole="button" className="min-h-12 justify-center self-start"><Text className="text-body font-semibold text-primary">‹ {words.back}</Text></Pressable></Link>
        <Text accessibilityRole="header" className="text-title-large font-semibold text-text">{words.title}</Text>
        {load.kind === "loading" && <View className="flex-row items-center gap-2"><ActivityIndicator className="text-primary" /><Text className="text-body text-muted">{words.loading}</Text></View>}
        {load.kind === "failed" && <>
          <Text accessibilityLiveRegion="polite" className="text-body text-danger">{load.message}</Text>
          <Button label={words.retry} onPress={() => { setLoad({ kind: "loading" }); void read(); }} variant="secondary" />
        </>}
        {load.kind === "loaded" && <>
          <Button label={words.invite} onPress={() => router.push("/invite-staff")} />
          {message && <Text accessibilityLiveRegion="polite" className="text-body text-danger">{message}</Text>}
          {staff.length === 0 && invited.length === 0 && removed.length === 0 && <Text className="text-body text-muted">{words.empty}</Text>}
          {staff.length > 0 && <Section title={words.working}>
            {staff.map((person) => (
              <View key={person.accountId} className="gap-2 rounded-card border border-border bg-surface p-4">
                <Text className="text-body font-semibold text-text">{personLabel(person)}</Text>
                <View className="flex-row items-center justify-between gap-3">
                  <Text className="flex-1 text-body text-text">{words.canDeliver}</Text>
                  <Toggle on={person.canDeliver} busy={busy !== null} label={words.canDeliverFor(personLabel(person))} onPress={() => void setFlag(person)} />
                </View>
                <Button label={words.deactivate} variant="secondary" busy={busy === person.accountId} disabled={busy !== null} onPress={() => setAsking(person)} />
              </View>
            ))}
          </Section>}
          {invited.length > 0 && <Section title={words.invited}>
            {invited.map((invite) => <PersonRow key={invite.phone} invite={invite}
              note={!invite.expiresAt || codeRanOut(invite.expiresAt, Date.now()) ? words.codeExpired : words.invitedUntil(formatDateTime(invite.expiresAt))} action={words.sendAgain} />)}
          </Section>}
          {removed.length > 0 && <Section title={words.deactivated}>
            {removed.map((invite) => <PersonRow key={invite.phone} invite={invite} note={null} action={words.reinvite} />)}
          </Section>}
        </>}
      </ScrollView>
      <Confirm
        visible={asking !== null}
        title={words.deactivateTitle(asking ? personLabel(asking) : "")}
        body={words.deactivateBody}
        confirm={words.deactivate}
        cancel={words.cancel}
        onConfirm={() => asking && void deactivate(asking)}
        onCancel={() => setAsking(null)}
      />
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <View className="gap-3"><Text accessibilityRole="header" className="text-title font-semibold text-text">{title}</Text>{children}</View>;
}

/** An invited or deactivated person; the button opens S20 with their number and flag filled in. */
function PersonRow({ invite, note, action }: { invite: StaffInvite; note: string | null; action: string }) {
  const router = useRouter();
  return (
    <View className="gap-2 rounded-card border border-border bg-surface p-4">
      <Text className="text-body font-semibold text-text">{personLabel(invite)}</Text>
      {invite.name && <Text className="text-secondary text-muted">{personLabel({ name: null, phone: invite.phone })}</Text>}
      {note && <Text className="text-secondary text-muted">{note}</Text>}
      <Button label={action} variant="secondary" onPress={() => router.push({ pathname: "/invite-staff", params: { phone: invite.phone, canDeliver: invite.canDeliver ? "1" : "0" } })} />
    </View>
  );
}
