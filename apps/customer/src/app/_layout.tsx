import { Slot } from "expo-router";
import { useEffect, useState } from "react";
import { api } from "../api";
import { UpdateRequired } from "../components/update-required";
import { applyTheme, savedTheme } from "../theme";
import "../global.css";

// Before the first render, so a saved Light or Dark never flashes the system theme.
applyTheme(savedTheme());

export default function Layout() {
  const [updateRequired, setUpdateRequired] = useState(false);

  useEffect(() => {
    // Only a refused version stops the app: offline or any other answer carries on.
    api.versionCheck().then(
      (result) => setUpdateRequired(!result.ok && result.code === "UPDATE_REQUIRED"),
      () => {},
    );
  }, []);

  return updateRequired ? <UpdateRequired /> : <Slot />;
}
