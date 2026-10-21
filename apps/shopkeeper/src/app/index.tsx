import { Text, useSession } from "@ygo/mobile";
import { useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { session } from "../api";
import { strings } from "../strings";

// Every signed-in person sees this until #40 (shop application) and #58
// (join a shop) link accounts to shops (#157, owner's Q4 on #34).
export default function NotLinked() {
  const state = useSession(session);
  const [signingOut, setSigningOut] = useState(false);

  return (
    <View className="flex-1 justify-center bg-bg px-4">
      <Text accessibilityRole="header" className="text-title-large font-semibold text-text">
        {strings.notLinked.title}
      </Text>
      <Text className="mt-2 text-body text-muted">{strings.notLinked.body}</Text>
      {state.status === "signed-in" && (
        <Text className="mt-4 text-secondary text-muted">{strings.notLinked.signedInAs(state.account.email)}</Text>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ busy: signingOut }}
        disabled={signingOut}
        onPress={() => {
          setSigningOut(true);
          void session.signOut();
        }}
        className="mt-8 min-h-12 items-center justify-center self-start rounded-button border border-border bg-surface px-4"
      >
        {signingOut ? (
          <ActivityIndicator className="text-primary" />
        ) : (
          <Text className="text-secondary font-medium text-text">{strings.profile.signOut}</Text>
        )}
      </Pressable>
    </View>
  );
}
