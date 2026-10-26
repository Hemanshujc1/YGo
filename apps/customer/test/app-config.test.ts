import { afterEach, describe, expect, it, vi } from "vitest";
import appConfig from "../app.config";
import app from "../app.json";

/** The Android map plugin's options, as the build would see them. */
function mapsOptions() {
  const config = appConfig({ config: app.expo } as Parameters<typeof appConfig>[0]);
  return config.plugins?.find((plugin) => Array.isArray(plugin) && plugin[0] === "react-native-maps")?.[1];
}

describe("app.config", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("takes the Android map key from the environment, never from app.json (#255)", () => {
    vi.stubEnv("GOOGLE_MAPS_ANDROID_API_KEY", "key-1");
    expect(mapsOptions()).toEqual({ androidGoogleMapsApiKey: "key-1" });
    expect(JSON.stringify(app)).not.toContain("react-native-maps");
  });

  it("uses a placeholder when the key is missing or empty, so the build still runs with a blank map", () => {
    vi.stubEnv("GOOGLE_MAPS_ANDROID_API_KEY", "");
    expect(mapsOptions()).toEqual({ androidGoogleMapsApiKey: "placeholder-until-the-real-key" });
    vi.stubEnv("GOOGLE_MAPS_ANDROID_API_KEY", undefined);
    expect(mapsOptions()).toEqual({ androidGoogleMapsApiKey: "placeholder-until-the-real-key" });
  });

  it("keeps app.json's name, slug and other plugins", () => {
    const config = appConfig({ config: app.expo } as Parameters<typeof appConfig>[0]);
    expect(config).toMatchObject({ name: "YGo", slug: "ygo-customer" });
    expect(config.plugins?.slice(0, -1)).toEqual(app.expo.plugins);
  });
});
