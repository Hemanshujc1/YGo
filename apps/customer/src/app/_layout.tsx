import { AppShell, applySavedTheme } from "@ygo/mobile";
import { Slot } from "expo-router";
import { api } from "../api";
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
      <Slot />
    </AppShell>
  );
}
