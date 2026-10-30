import { Button, Confirm, Text } from "@ygo/mobile";
import { useRef, useState } from "react";
import { Link } from "expo-router";
import { View } from "react-native";
import { accountEpoch, session } from "../api";
import { strings } from "../strings";
import { openingStockBeforeSignOut } from "../lib/opening-stock-database";

const words = strings.application.signOut;

/**
 * Sign out on the shop application screens until S36 More is built (#294).
 * With changes not yet saved it asks first.
 */
export function SignOut({ unsaved = false, disabled = false, verifiedShopId }: { unsaved?: boolean; disabled?: boolean; verifiedShopId?: string | null }) {
  const [failedWarning, setFailedWarning] = useState<{ accountId: string; epoch: number } | null>(null);
  const [asking, setAsking] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const working = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<false | "opening" | "stock">(false);

  async function signOut(accepted: { accountId: string; epoch: number } | null = null) {
    if (working.current) return;
    const before = session.get();
    if (!("account" in before)) return;
    const epoch = accountEpoch();
    working.current = true;
    setAsking(false);
    setSigningOut(true);
    setMessage(null);
    setPending(false);
    try {
      const counts = await openingStockBeforeSignOut(before.account.id, verifiedShopId);
      const current = session.get();
      if (!("account" in current) || current.account.id !== before.account.id || epoch !== accountEpoch()) return;
      if (counts.pending > 0) {
        setMessage(words.pending(counts.pending));
        setPending(counts.stockPending ? "stock" : "opening");
        return;
      }
      if (counts.failed > 0 && (accepted?.accountId !== before.account.id || accepted.epoch !== epoch)) { setFailedWarning({ accountId: before.account.id, epoch }); setAsking(true); return; }
      await session.signOut();
    } catch {
      const current = session.get();
      if ("account" in current && current.account.id === before.account.id && epoch === accountEpoch()) setMessage(words.checkFailed);
    } finally {
      working.current = false;
      const current = session.get();
      if ("account" in current && current.account.id === before.account.id && epoch === accountEpoch()) setSigningOut(false);
    }
  }

  return (
    <View className="items-start">
      <Button
        label={strings.profile.signOut}
        onPress={() => (unsaved ? setAsking(true) : void signOut())}
        busy={signingOut}
        disabled={disabled}
        variant="secondary"
      />
      {message && <Text accessibilityLiveRegion="polite" className="mt-2 text-secondary text-pending">{message}</Text>}
      {pending && <Link href={pending === "stock" ? "/stock" : "/opening-stock"} className="mt-3 py-3 text-body text-primary">{pending === "stock" ? strings.stock.title : words.openStock}</Link>}
      <Confirm
        visible={asking}
        title={failedWarning ? words.failedTitle : words.title}
        body={failedWarning ? words.failedBody : words.body}
        confirm={strings.profile.signOut}
        cancel={words.cancel}
        onConfirm={() => void signOut(failedWarning)}
        onCancel={() => { setAsking(false); setFailedWarning(null); }}
      />
    </View>
  );
}
