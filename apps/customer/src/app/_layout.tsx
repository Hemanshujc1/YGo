import { AppShell, applySavedTheme, SessionGate } from "@ygo/mobile";
import { Stack } from "expo-router";
import { api, session, supportEmail } from "../api";
import { strings } from "../strings";
import "../global.css";

applySavedTheme();

// Home sits under every screen, so Back from a link straight to Account still lands on it.
export const unstable_settings = { initialRouteName: "index" };

export default function Layout() {
  return (
    <AppShell
      checkVersion={api.versionCheck}
      update={{
        title: strings.update.title,
        message: strings.errors.UPDATE_REQUIRED,
        button: strings.update.button,
        storeUnavailableMessage: strings.update.storeUnavailableMessage,
        iosStoreUrl: process.env.EXPO_PUBLIC_IOS_STORE_URL,
        androidStoreUrl: process.env.EXPO_PUBLIC_ANDROID_STORE_URL,
      }}
    >
      <SessionGate
        session={session}
        identity={{ googleWebClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID, googleIosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID }}
        api={api}
        supportEmail={supportEmail}
        words={{
          signIn: { ...strings.signIn, errors: strings.errors },
          profile: { ...strings.profile, errors: strings.errors },
          unreachable: strings.session.unreachable,
          notCleared: strings.session.notCleared,
        }}
      >
        {/* A stack, so Account opens over the home screen and Back returns to it (#156, Q5). */}
        <Stack screenOptions={{ headerShown: false }} />
      </SessionGate>
    </AppShell>
  );
}
