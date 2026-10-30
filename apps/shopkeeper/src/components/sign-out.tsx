import { Button, Text } from "@ygo/mobile";
import { useRef, useState } from "react";
import { Link } from "expo-router";
import { View } from "react-native";
import { session } from "../api";
import { strings } from "../strings";
import { openingStockBeforeSignOut } from "../lib/opening-stock-database";
import { Confirm } from "./confirm";

const words = strings.application.signOut;

/**
 * Sign out on the shop application screens until S36 More is built (#294).
 * With changes not yet saved it asks first.
 */
export function SignOut({ unsaved = false, disabled = false, verifiedShopId }: { unsaved?: boolean; disabled?: boolean; verifiedShopId?: string | null }) {
  const [asking, setAsking] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const working = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function signOut() {
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
      if (session.get() !== before) return;
      if (count > 0) {
        setMessage(words.pending(count));
        setPending(true);
        return;
      }
      await session.signOut();
    } catch {
      setMessage(words.checkFailed);
    } finally {
      working.current = false;
      setSigningOut(false);
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
        title={words.title}
        body={words.body}
        confirm={strings.profile.signOut}
        cancel={words.cancel}
        onConfirm={() => void signOut()}
        onCancel={() => setAsking(false)}
      />
    </View>
  );
}
