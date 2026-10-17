import { createApiClient, type ApiResult } from "@ygo/api-client";
import type { HealthResponse } from "@ygo/contracts";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { strings } from "../strings";

// A phone has no page origin to fall back on, so a missing URL is a setup
// mistake, not an unreachable server. See README.md.
const baseUrl = process.env.EXPO_PUBLIC_API_BASE_URL;
if (!baseUrl) throw new Error("EXPO_PUBLIC_API_BASE_URL is not set");
const api = createApiClient({ baseUrl });

export default function Health() {
  const insets = useSafeAreaInsets();
  const [result, setResult] = useState<ApiResult<HealthResponse> | "unreachable">();

  useEffect(() => {
    // health() rejects only when no answer came back: offline, refused or timed out.
    api.health().then(setResult, () => setResult("unreachable"));
  }, []);

  const answer =
    result === undefined
      ? strings.checking
      : result === "unreachable"
        ? strings.unreachable
        : result.ok
          ? strings.ok
          : strings.errors[result.code];

  return (
    <View className="flex-1 bg-bg px-4" style={{ paddingTop: insets.top + 16 }}>
      <Text className="text-2xl font-semibold text-brand">{strings.title}</Text>
      <Text className="mt-6 text-muted">{strings.health}</Text>
      <Text className="mt-1 text-text">{answer}</Text>
    </View>
  );
}
