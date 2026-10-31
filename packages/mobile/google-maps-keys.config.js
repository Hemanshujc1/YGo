const placeholder = "placeholder-until-the-real-key";

// A development build keeps a blank map when a key is missing; a release build must not ship one (#315).
module.exports = function googleMapsKeys(env) {
  const android = env.GOOGLE_MAPS_ANDROID_API_KEY || "";
  const ios = env.GOOGLE_MAPS_IOS_API_KEY || "";
  if (env.YGO_RELEASE_BUILD === "1") {
    if (!android) throw new Error("GOOGLE_MAPS_ANDROID_API_KEY is required for a release build (YGO_RELEASE_BUILD=1)");
    if (!ios) throw new Error("GOOGLE_MAPS_IOS_API_KEY is required for a release build (YGO_RELEASE_BUILD=1)");
  }
  return { androidGoogleMapsApiKey: android || placeholder, iosGoogleMapsApiKey: ios || placeholder };
};
