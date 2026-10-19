import { NavigationBar } from "expo-navigation-bar";
import { Slot } from "expo-router";
import { useEffect, useState } from "react";
import { StatusBar, useColorScheme } from "react-native";
import { api } from "../api";
import { UpdateRequired } from "../components/update-required";
import { applyTheme, savedTheme } from "../theme";
import "../global.css";

// Before the first render, so a saved Light or Dark never flashes the system theme.
applyTheme(savedTheme());

export default function Layout() {
  const scheme = useColorScheme();
  const [updateRequired, setUpdateRequired] = useState(false);

  useEffect(() => {
    // Only a refused version stops the app: offline or any other answer carries on.
    api.versionCheck().then(
      (result) => setUpdateRequired(!result.ok && result.code === "UPDATE_REQUIRED"),
      () => {},
    );
  }, []);

  return (
    <>
      {/* The system bars' icons follow the theme on screen, not only the phone's. */}
      <StatusBar barStyle={scheme === "dark" ? "light-content" : "dark-content"} />
      <NavigationBar style="auto" />
      {updateRequired ? <UpdateRequired /> : <Slot />}
    </>
  );
}
