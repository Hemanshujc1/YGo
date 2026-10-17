// Expo's own monorepo setup, untouched (ADR-0007); NativeWind only adds its
// CSS step. Never add watchFolders or resolver keys here.
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

module.exports = withNativeWind(getDefaultConfig(__dirname), {
  input: "./src/global.css",
  // 1rem = 16, as on the web, so p-4 is the design system's 16 (NativeWind's default is 14).
  inlineRem: 16,
});
