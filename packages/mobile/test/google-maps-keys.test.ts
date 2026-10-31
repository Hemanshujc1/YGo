import { describe, expect, it } from "vitest";
import googleMapsKeys from "../google-maps-keys.config";

const placeholder = "placeholder-until-the-real-key";

describe("googleMapsKeys (#315)", () => {
  it("passes both keys through", () => {
    expect(googleMapsKeys({ GOOGLE_MAPS_ANDROID_API_KEY: "a", GOOGLE_MAPS_IOS_API_KEY: "i", YGO_RELEASE_BUILD: "1" }))
      .toEqual({ androidGoogleMapsApiKey: "a", iosGoogleMapsApiKey: "i" });
  });

  it("keeps a placeholder in a development build when a key is missing or empty", () => {
    expect(googleMapsKeys({})).toEqual({ androidGoogleMapsApiKey: placeholder, iosGoogleMapsApiKey: placeholder });
    expect(googleMapsKeys({ GOOGLE_MAPS_ANDROID_API_KEY: "", GOOGLE_MAPS_IOS_API_KEY: "i", YGO_RELEASE_BUILD: "0" }))
      .toEqual({ androidGoogleMapsApiKey: placeholder, iosGoogleMapsApiKey: "i" });
  });

  it("stops a release build that lacks either key, naming it, and treats an empty key as missing", () => {
    const release = { YGO_RELEASE_BUILD: "1" };
    expect(() => googleMapsKeys({ ...release, GOOGLE_MAPS_IOS_API_KEY: "i" })).toThrow("GOOGLE_MAPS_ANDROID_API_KEY");
    expect(() => googleMapsKeys({ ...release, GOOGLE_MAPS_ANDROID_API_KEY: "a" })).toThrow("GOOGLE_MAPS_IOS_API_KEY");
    expect(() => googleMapsKeys({ ...release, GOOGLE_MAPS_ANDROID_API_KEY: "", GOOGLE_MAPS_IOS_API_KEY: "i" })).toThrow("GOOGLE_MAPS_ANDROID_API_KEY");
  });
});
