import { AppShell, applySavedTheme, SessionGate } from "@ygo/mobile";
import { Slot } from "expo-router";
import { api, session, supportEmail } from "../api";
import { StockAccess } from "../components/stock-access";
import { SignOut } from "../components/sign-out";
import { strings } from "../strings";
import "../global.css";

applySavedTheme();

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
        profileSignOut={<SignOut />}
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
        <StockAccess><Slot /></StockAccess>
      </SessionGate>
    </AppShell>
  );
}
