# Google and Apple sign-in (#36)

Both mobile apps use the existing YGo session and name/phone onboarding. Google runs on Android and iOS; Apple runs on supported iOS devices. No Firebase authentication service is used.

## Configure the providers

1. Keep each app's current local Android package and iOS bundle identifier. The first `expo run` asks for them; they remain local until store identifiers are chosen. Register those exact identifiers with the providers. Changing an identifier or signing key requires updating its registration.
2. In Google Cloud, configure the OAuth consent screen and its test users. Create an Android OAuth client for each app's package plus signing-certificate SHA-1, an iOS OAuth client for each bundle identifier, and a Web OAuth client for the backend audience. Client IDs are public; a client secret is not needed by the apps or this ID-token flow.
3. In each app's git-ignored `.env`, set `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` to the Web client ID and `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` to that app's iOS client ID. Both must be present for iOS. The app config derives its Google return URL scheme from the iOS client ID. Without it the Google plugin is omitted, so email sign-in can still be built before Google setup.
4. Set the server's `GOOGLE_CLIENT_IDS` to the permitted Web client ID(s), comma-separated. Never accept an arbitrary token audience. Configure staging/production in their existing private environment documents in Parameter Store; redeploy to load them.
5. In the Apple developer account, enable Sign in with Apple for both app identifiers and group the two apps under one primary App ID. This keeps their Apple identity and private-relay behavior consistent. Enable the capability on the signing profiles. Set server `APPLE_CLIENT_IDS` to the allowed app bundle identifiers, comma-separated.
6. Register the login email sender/domain with Apple's private email relay if relay users must also use emailed codes. A relay address differs from a person's ordinary email; YGo does not infer that they are the same person or merge accounts using a claimed phone number.
7. Rebuild **both** apps after these changes: `pnpm --filter @ygo/customer android` / `ios`, and `pnpm --filter @ygo/shopkeeper android` / `ios`. Metro refresh cannot add native modules, return URL schemes or Apple entitlements. Apple account/capability setup and a supported Apple device are required for the real Apple check.

No real provider credentials are required for the automated tests. Empty server audience lists refuse provider tokens; the emailed-code flow continues working. Do not commit `.env`, downloaded provider files, signing material or client secrets.

## Check on the phones

Run each check in Customer and Shopkeeper. Use the OPPO for Android and an Apple-supported device for iOS; simulator checks alone do not prove real Apple authorization.

1. Sign out. Check Google is visible on both platforms and Apple on supported iOS only. Check Light and Dark, normal text size and 130% text size.
2. Tap Google. The tapped action shows a spinner; the email field and other actions cannot start another attempt. Cancel the picker: return to sign-in quietly and all actions work again.
3. Sign in with a new Gmail or Google Workspace email. Complete name and phone once. Sign out, sign in again with the same email by emailed code, then Google: the same profile and shop application remain.
4. Use a Google account backed by an external mailbox, without Google Workspace. YGo opens the existing emailed-code screen. Only completing the emailed code grants access; the Google token alone does not create an account/session.
5. On iOS, repeat with Apple sharing the same email: it reaches the same account. With Hide My Email, YGo treats the relay address as a separate account. A phone already claimed by another account remains refused and points to support.
6. Kill and reopen the app: the saved session restores. Sign out: reopening stays signed out. Test cancellation and loss of connection during sign-in; no successful sign-in is announced before the refresh token is saved.
7. Open Help and verify it uses the app's configured support email. Existing emailed-code sign-in still works.

Record the device, OS, app and check results in the PR. Keep #36 open until these real-provider checks pass.

## Verification references

- [Expo Google authentication](https://docs.expo.dev/guides/google-authentication/): native modules and development builds.
- [Nitro Google setup](https://react-native-nitro-google-sign-in.github.io/docs/setup/expo/): explicit client IDs, URL scheme and native plugin.
- [Google backend verification](https://developers.google.com/identity/sign-in/web/backend-auth): signature, issuer, audience, expiry and mailbox authority.
- [Expo Apple authentication](https://docs.expo.dev/versions/latest/sdk/apple-authentication/): capability, native button and device support.
- [Apple authentication](https://developer.apple.com/documentation/signinwithapple/authenticating-users-with-sign-in-with-apple): nonce and signed email claims.
