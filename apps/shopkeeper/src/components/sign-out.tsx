import { Button } from "@ygo/mobile";
import { useState } from "react";
import { View } from "react-native";
import { session } from "../api";
import { strings } from "../strings";
import { Confirm } from "./confirm";

const words = strings.application.signOut;

/**
 * Sign out on the shop application screens until S36 More is built (#294).
 * With changes not yet saved it asks first.
 */
export function SignOut({ unsaved = false, disabled = false }: { unsaved?: boolean; disabled?: boolean }) {
  const [asking, setAsking] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  function signOut() {
    setAsking(false);
    setSigningOut(true);
    void session.signOut();
  }

  return (
    <View className="items-start">
      <Button
        label={strings.profile.signOut}
        onPress={() => (unsaved ? setAsking(true) : signOut())}
        busy={signingOut}
        disabled={disabled}
        variant="secondary"
      />
      <Confirm
        visible={asking}
        title={words.title}
        body={words.body}
        confirm={strings.profile.signOut}
        cancel={words.cancel}
        onConfirm={signOut}
        onCancel={() => setAsking(false)}
      />
    </View>
  );
}
