import { Button, Confirm, Text } from "@ygo/mobile";
import { useRef, useState } from "react";
import { Link } from "expo-router";
import { View } from "react-native";
import { session } from "../api";
import { strings } from "../strings";
import { openingStockBeforeSignOut, openingStockFailuresBeforeSignOut } from "../lib/opening-stock-database";

const words = strings.application.signOut;

/**
 * Sign out on the shop application screens until S36 More is built (#294).
 * With changes not yet saved it asks first.
 */
export function SignOut({ unsaved = false, disabled = false, verifiedShopId }: { unsaved?: boolean; disabled?: boolean; verifiedShopId?: string | null }) {
  const [failedWarning, setFailedWarning] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const working = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function signOut(acceptedAccount: string | null = null) {
    if (working.current) return;
    const before = session.get();
    if (!("account" in before)) return;
    working.current = true;
    setAsking(false);
    setSigningOut(true);
    setMessage(null);
    setPending(false);
    try {
      const count = await openingStockBeforeSignOut(before.account.id, verifiedShopId);
      const failures = await openingStockFailuresBeforeSignOut(before.account.id);
      const current = session.get();
      if (!("account" in current) || current.account.id !== before.account.id) return;
      if (count > 0) {
        setMessage(words.pending(count));
        setPending(true);
        return;
      }
      if (failures > 0 && acceptedAccount !== before.account.id) { setFailedWarning(before.account.id); setAsking(true); return; }
      await session.signOut();
    } catch {
      const current = session.get();
      if ("account" in current && current.account.id === before.account.id) setMessage(words.checkFailed);
    } finally {
      working.current = false;
      const current = session.get();
      if ("account" in current && current.account.id === before.account.id) setSigningOut(false);
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
      {pending && <Link href="/opening-stock" className="mt-3 py-3 text-body text-primary">{words.openStock}</Link>}
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
