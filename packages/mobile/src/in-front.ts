import { useFocusEffect } from "expo-router";
import { useCallback } from "react";
import { AppState } from "react-native";

/** Runs `start` while the screen is in front and the app in the foreground, and `stop` when either ends (#52, #431). */
export function useInFront({ start, stop }: { start(): void; stop(): void }) {
  useFocusEffect(useCallback(() => {
    start();
    const watch = AppState.addEventListener("change", (state) => (state === "active" ? start() : stop()));
    return () => {
      watch.remove();
      stop();
    };
  }, [start, stop]));
}
