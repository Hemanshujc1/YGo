import type { ConfigContext, ExpoConfig } from "expo/config";
import app from "./app.json";

/**
 * The Android map key comes from `.env` or the build's environment, never the
 * repo (#255, Q1). Without one, a placeholder keeps the map blank, as the
 * Google map stops the app when the key is missing. iOS draws Apple Maps,
 * which needs no key (Q2).
 */
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: config.name ?? app.expo.name,
  slug: config.slug ?? app.expo.slug,
  plugins: [
    ...(config.plugins ?? []),
    ["react-native-maps", { androidGoogleMapsApiKey: process.env.GOOGLE_MAPS_ANDROID_API_KEY || "placeholder-until-the-real-key" }],
  ],
});
