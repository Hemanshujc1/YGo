import { Button, Text } from "@ygo/mobile";
import { useState } from "react";
import { Modal, View } from "react-native";
import { session } from "../api";
import { strings } from "../strings";

const words = strings.application.signOut;

/**
 * Sign out on the shop application screens until S36 More is built (#294).
 * With changes not yet saved it asks first, in the YGo design rather than
 * the phone's own alert.
 */
export function SignOut({ unsaved = false }: { unsaved?: boolean }) {
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
        variant="secondary"
      />
      <Modal transparent visible={asking} animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={() => setAsking(false)}>
        <View className="flex-1 justify-center bg-scrim px-4">
          <View accessibilityViewIsModal className="gap-4 rounded-dialog bg-raised p-4">
            <Text accessibilityRole="header" className="text-headline font-semibold text-text">
              {words.title}
            </Text>
            <Text className="text-body text-text">{words.body}</Text>
            <View className="gap-2.5">
              <Button label={strings.profile.signOut} onPress={signOut} />
              <Button label={words.cancel} onPress={() => setAsking(false)} variant="text" />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}
