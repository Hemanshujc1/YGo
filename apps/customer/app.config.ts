import type { ConfigContext, ExpoConfig } from "expo/config";
import app from "./app.json";

/**
 * Both phones draw Google's map (#307, Q5), each with its own key from `.env`
 * or the build's environment, never the repo (#255, Q1). Without one, a
 * placeholder keeps the map blank, as the Google map stops the app when the
 * key is missing.
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
      ["react-native-maps", {
        androidGoogleMapsApiKey: process.env.GOOGLE_MAPS_ANDROID_API_KEY || "placeholder-until-the-real-key",
        iosGoogleMapsApiKey: process.env.GOOGLE_MAPS_IOS_API_KEY || "placeholder-until-the-real-key",
      }],
      "expo-apple-authentication",
      // A Google OAuth iOS client is needed before prebuilding Google support.
      ...(iosClientId ? [["react-native-nitro-google-signin", {
        iosUrlScheme: iosClientId.split(".").reverse().join("."),
      }] as [string, Record<string, string>], "@ygo/mobile/google-sign-in-plugin"] : []),
    ],
  };
};
