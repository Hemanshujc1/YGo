import type { ApiResult } from "@ygo/api-client";
import { NavigationBar } from "expo-navigation-bar";
import { type ReactNode, useEffect, useState } from "react";
import { StatusBar, useColorScheme } from "react-native";
import { UpdateRequired, type UpdateRequiredProps } from "./update-required";

type AppShellProps = {
  /** The app's own `api.versionCheck`. */
  checkVersion: () => Promise<ApiResult<undefined>>;
  update: UpdateRequiredProps;
  children: ReactNode;
};

/** Each app's root layout: system bars, the launch version check, and the update screen. */
export function AppShell({ checkVersion, update, children }: AppShellProps) {
  const scheme = useColorScheme();
  const [updateRequired, setUpdateRequired] = useState(false);

  useEffect(() => {
    // Only a refused version stops the app: offline or any other answer carries on.
    checkVersion().then(
      (result) => setUpdateRequired(!result.ok && result.code === "UPDATE_REQUIRED"),
      () => {},
    );
    // Once at launch, as before the move; a new function on each render must not re-check.
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
