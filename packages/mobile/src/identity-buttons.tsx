import * as Apple from "expo-apple-authentication";
import { cssInterop, useColorScheme } from "nativewind";
import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import { GoogleOneTapSignIn, GoogleSignInButton } from "react-native-nitro-google-signin";
import type { IdentityProvider } from "@ygo/contracts";

const GoogleButton = cssInterop(GoogleSignInButton, { className: "style" });
const AppleButton = cssInterop(Apple.AppleAuthenticationButton, { className: "style" });

export type IdentityConfig = { googleWebClientId?: string; googleIosClientId?: string };

export function IdentityButtons({ config, busy, start }: {
  config: IdentityConfig;
  busy: "email" | IdentityProvider | null;
  start: (provider: IdentityProvider, token: (nonce: string) => Promise<string | null>) => void;
}) {
  const { colorScheme } = useColorScheme();
  const [appleAvailable, setAppleAvailable] = useState(false);
  useEffect(() => {
    if (Platform.OS === "ios") void Apple.isAvailableAsync().then(setAppleAvailable).catch(() => {});
  }, []);

  async function google(nonce: string) {
    if (!config.googleWebClientId || (Platform.OS === "ios" && !config.googleIosClientId)) throw new Error("Google is not configured");
    GoogleOneTapSignIn.configure({
      webClientId: config.googleWebClientId,
      iosClientId: config.googleIosClientId,
      nonce,
    });
    await GoogleOneTapSignIn.checkPlayServices();
    // Always use the interactive picker: a restored token may carry an old nonce.
    const answer = await GoogleOneTapSignIn.presentExplicitSignIn();
    if (answer.type === "cancelled") return null;
    if (answer.type !== "success" || !answer.data?.idToken) throw new Error("Google did not return an identity token");
    return answer.data.idToken;
  }

  async function apple(nonce: string) {
    try {
      const answer = await Apple.signInAsync({ requestedScopes: [Apple.AppleAuthenticationScope.EMAIL], nonce });
      if (!answer.identityToken) throw new Error("Apple did not return an identity token");
      return answer.identityToken;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ERR_REQUEST_CANCELED") return null;
      throw error;
    }
  }

  return (
    <View className="my-8 gap-3">
      <View className="h-12">
      {busy === "google" ? <ActivityIndicator className="h-12 text-primary" /> : <GoogleButton
        colorScheme={colorScheme === "dark" ? "dark" : "light"}
        size="wide"
        className="h-12 w-full"
        signInBehavior="none"
        disabled={busy !== null}
        onPress={() => start("google", google)}
      />}
      </View>
      {appleAvailable && (
        <View className="h-12" pointerEvents={busy ? "none" : "auto"} accessibilityState={{ disabled: busy !== null, busy: busy === "apple" }}>
          {busy === "apple" ? <ActivityIndicator className="h-12 text-primary" /> : (
            <AppleButton
              buttonType={Apple.AppleAuthenticationButtonType.SIGN_IN}
              buttonStyle={colorScheme === "dark" ? Apple.AppleAuthenticationButtonStyle.WHITE : Apple.AppleAuthenticationButtonStyle.BLACK}
              cornerRadius={8}
              className="h-12 w-full"
              onPress={() => start("apple", apple)}
            />
          )}
        </View>
      )}
    </View>
  );
}
