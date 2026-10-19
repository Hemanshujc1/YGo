import { NavigationBar } from "expo-navigation-bar";
import { type ReactNode, useEffect, useSyncExternalStore } from "react";
import { AppState, StatusBar, useColorScheme } from "react-native";
import { UpdateRequired, type UpdateRequiredProps } from "./update-required";
import { isUpdateRequired, subscribe } from "./update-signal";

type AppShellProps = {
  /** The app's own `api.versionCheck`; a refusal reaches the shell through `showUpdateRequired`. */
  checkVersion: () => Promise<unknown>;
  update: UpdateRequiredProps;
  children: ReactNode;
};

/** Each app's root layout: system bars, the version check, and the update screen. */
export function AppShell({ checkVersion, update, children }: AppShellProps) {
  const scheme = useColorScheme();
  const updateRequired = useSyncExternalStore(subscribe, isUpdateRequired);

  useEffect(() => {
    // Only a refused version stops the app: offline or any other answer carries on.
    const check = () => {
      if (!isUpdateRequired()) void checkVersion().catch(() => {});
    };
    check();
    // The server may raise its minimum while the app sits in the background.
    // Only a return from the background re-checks, not a dialog or Control Center.
    let previous = AppState.currentState;
    const listener = AppState.addEventListener("change", (state) => {
      if (previous === "background" && state === "active") check();
      previous = state;
    });
    return () => listener.remove();
    // Once on mount; a new function on each render must not re-check.
  }, []);

  return (
    <>
      {/* The system bars' icons follow the theme on screen, not only the phone's. */}
      <StatusBar barStyle={scheme === "dark" ? "light-content" : "dark-content"} />
      <NavigationBar style="auto" />
      {updateRequired ? <UpdateRequired {...update} /> : children}
    </>
  );
}
