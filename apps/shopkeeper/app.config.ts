import type { ConfigContext, ExpoConfig } from "expo/config";
import app from "./app.json";

export default ({ config }: ConfigContext): ExpoConfig => {
  const iosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
  return {
    ...config,
    name: config.name ?? app.expo.name,
    slug: config.slug ?? app.expo.slug,
    ios: { ...config.ios, usesAppleSignIn: true },
    plugins: [
      ...(config.plugins ?? []),
      "expo-apple-authentication",
      // A Google OAuth iOS client is needed before prebuilding Google support.
      ...(iosClientId ? [["react-native-nitro-google-signin", {
        iosUrlScheme: iosClientId.split(".").reverse().join("."),
      }] as [string, Record<string, string>], "@ygo/mobile/google-sign-in-plugin"] : []),
    ],
  };
};
