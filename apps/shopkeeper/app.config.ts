import type { ConfigContext, ExpoConfig } from "expo/config";
import googleMapsKeys from "@ygo/mobile/google-maps-keys";
import app from "./app.json";

/**
 * Both phones draw Google's map (#307, Q5), each with its own key from `.env`
 * or the build's environment, never the repo. Without one, a placeholder keeps
 * the map blank, as the Google map stops the app when the key is missing. A
 * release build (YGO_RELEASE_BUILD=1) stops instead, naming the missing key (#315).
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  const iosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
  return {
    ...config,
    name: config.name ?? app.expo.name,
    slug: config.slug ?? app.expo.slug,
    ios: { ...config.ios, usesAppleSignIn: true },
    plugins: [
      ...(config.plugins ?? []),
      ["react-native-maps", googleMapsKeys(process.env)],
      "expo-apple-authentication",
      // A Google OAuth iOS client is needed before prebuilding Google support.
      ...(iosClientId ? [["react-native-nitro-google-signin", {
        iosUrlScheme: iosClientId.split(".").reverse().join("."),
      }] as [string, Record<string, string>], "@ygo/mobile/google-sign-in-plugin"] : []),
    ],
  };
};
