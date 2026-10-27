import { afterEach, describe, expect, it, vi } from "vitest";
import appConfig from "../app.config";
import app from "../app.json";

/** The map plugin's options, as the build would see them. */
function mapsOptions() {
  const config = appConfig({ config: app.expo } as Parameters<typeof appConfig>[0]);
  return config.plugins?.find((plugin) => Array.isArray(plugin) && plugin[0] === "react-native-maps")?.[1];
}

describe("app.config", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("takes each phone's map key from the environment, never from app.json (#255, #307)", () => {
    vi.stubEnv("GOOGLE_MAPS_ANDROID_API_KEY", "key-1");
    vi.stubEnv("GOOGLE_MAPS_IOS_API_KEY", "key-2");
    expect(mapsOptions()).toEqual({ androidGoogleMapsApiKey: "key-1", iosGoogleMapsApiKey: "key-2" });
    expect(JSON.stringify(app)).not.toContain("react-native-maps");
  });

  it("uses a placeholder when a key is missing or empty, so the build still runs with a blank map", () => {
    const placeholders = { androidGoogleMapsApiKey: "placeholder-until-the-real-key", iosGoogleMapsApiKey: "placeholder-until-the-real-key" };
    vi.stubEnv("GOOGLE_MAPS_ANDROID_API_KEY", "");
    vi.stubEnv("GOOGLE_MAPS_IOS_API_KEY", "");
    expect(mapsOptions()).toEqual(placeholders);
    vi.stubEnv("GOOGLE_MAPS_ANDROID_API_KEY", undefined);
    vi.stubEnv("GOOGLE_MAPS_IOS_API_KEY", undefined);
    expect(mapsOptions()).toEqual(placeholders);
  });

  it("keeps app.json's name, slug and other plugins", () => {
    const config = appConfig({ config: app.expo } as Parameters<typeof appConfig>[0]);
    expect(config).toMatchObject({ name: "YGo", slug: "ygo-customer" });
    expect(config.plugins?.slice(0, app.expo.plugins.length)).toEqual(app.expo.plugins);
  });
});
