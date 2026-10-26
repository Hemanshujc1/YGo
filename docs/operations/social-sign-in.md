# Set up Google and Apple sign-in

Follow this guide in the checkout containing PR #308, for issue #36. Start with Google on the Android phone; then finish Apple and the iOS checks. Provider accounts are not configured yet. The passing builds and automated tests do not replace these setup steps.

Run terminal commands from the **repository root**, unless a step says otherwise. Replace values written as `YOUR_...` with your own values; do not paste those placeholders unchanged.

## What you will finish

| Stage | Result |
| --- | --- |
| 1–2 | Both apps have known local identifiers and Android signing fingerprints |
| 3–4 | One Google project contains five OAuth clients; the apps and API have the correct IDs |
| 5 | The local API runs with the sign-in database migration applied |
| 6 | Google works on the OPPO in both apps |
| 7–9 | Apple is configured and the rebuilt iOS apps can be checked |
| 10 | All phone checks are recorded on PR #308 |

You can complete the Android stages while Apple enrollment/setup is pending.

## 1. Prepare the checkout and tools

1. Open the issue #36 checkout and confirm its branch:

   ```sh
   git branch --show-current
   ```

   For the current worktree, expect `36-google-apple-sign-in`. After this PR merges, use an updated `main` checkout instead.

2. Check the installed toolchain and install the pinned dependencies:

   ```sh
   node --version
   pnpm --version
   pnpm install --frozen-lockfile
   ```

   This repo requires Node 26 and pnpm 12.8.2 or later within major version 12.

3. Start Docker Desktop or OrbStack. For Android builds, have Android Studio's SDK installed. For iOS builds, have Xcode and CocoaPods installed.

4. On this Mac, select Java 17 and the Android SDK for this terminal:

   ```sh
   export JAVA_HOME="$(/usr/libexec/java_home -v 17)"
   export ANDROID_HOME="$HOME/Library/Android/sdk"
   export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
   java -version
   adb version
   ```

   These settings apply to this terminal. Repeat them in another terminal if you build Android there.

**Checkpoint:** dependency installation succeeds and `java -version` reports Java 17.

## 2. Record the app identifiers and Android SHA-1 fingerprints

Google needs each Android **package name + signing certificate SHA-1**. Google and Apple need each iOS **bundle identifier**. These values must match the app actually installed on the phone.

1. If native projects already exist, find their identifiers:

   ```sh
   rg 'applicationId' apps/customer/android/app/build.gradle
   rg 'applicationId' apps/shopkeeper/android/app/build.gradle
   rg 'PRODUCT_BUNDLE_IDENTIFIER' apps/customer/ios --glob project.pbxproj
   rg 'PRODUCT_BUNDLE_IDENTIFIER' apps/shopkeeper/ios --glob project.pbxproj
   ```

   A missing directory means that platform has not been generated in this checkout yet. The local validation builds used `dev.local.ygocustomer` and `dev.local.ygoshopkeeper`; use your existing identifiers if they differ.

2. Keep a private setup note with this table. Fill it from your native projects, or choose local test identifiers before generating a fresh project:

   | Value | Customer | Shopkeeper |
   | --- | --- | --- |
   | Android package | `YOUR_CUSTOMER_ANDROID_PACKAGE` | `YOUR_SHOPKEEPER_ANDROID_PACKAGE` |
   | Android debug SHA-1 | fill below | fill below |
   | iOS bundle identifier | `YOUR_CUSTOMER_IOS_BUNDLE_ID` | `YOUR_SHOPKEEPER_IOS_BUNDLE_ID` |

3. Before any `prebuild`, open each app's `app.json` locally. Inside its existing `expo` object, set `android.package` and `ios.bundleIdentifier` to the values in your note. **Merge these properties into the existing objects**; preserve `ios.supportsTablet`, plugins and all other settings.

   For example, the relevant Customer properties for a local test build are:

   ```json
   {
     "android": { "package": "dev.local.ygocustomer" },
     "ios": { "supportsTablet": false, "bundleIdentifier": "dev.local.ygocustomer" }
   }
   ```

   The Shopkeeper example uses `dev.local.ygoshopkeeper`. These are local test identifiers, not a decision about store identifiers. Keep these local `app.json` edits out of commits, as the app READMEs require. Keep the same values for subsequent prebuilds so the provider registrations keep matching.

4. Generate the Android projects if they are missing:

   ```sh
   pnpm --filter @ygo/customer exec expo prebuild --platform android --no-install --no-clean
   pnpm --filter @ygo/shopkeeper exec expo prebuild --platform android --no-install --no-clean
   ```

5. Read **each app's own debug keystore** fingerprint:

   ```sh
   keytool -list -v -keystore apps/customer/android/app/debug.keystore -alias androiddebugkey -storepass android
   keytool -list -v -keystore apps/shopkeeper/android/app/debug.keystore -alias androiddebugkey -storepass android
   ```

   Copy the `SHA1:` value into your note. `android` is the generated development keystore's standard password. If the project uses custom signing, use its actual keystore instead; Android Studio's Gradle `signingReport` shows the certificate for each build variant. [Android signing guide](https://developer.android.com/studio/publish/app-signing#signing-report)

**Checkpoint:** your note contains two Android packages, two SHA-1 values and two iOS bundle identifiers. Do not assume the two debug keystores have the same fingerprint.

## 3. Create the Google project and five OAuth clients

### 3a. Configure the consent screen

1. Open [Google Cloud Console](https://console.cloud.google.com/), select a project you control or create one for YGo, and keep that same project selected for all five clients.
2. Open **Google Auth Platform**. If prompted, select **Get started**. Enter **YGo** as the app name, your user support email and your developer contact email. Choose **External** for the audience and save. [Google's setup walkthrough](https://codelabs.developers.google.com/codelabs/sign-in-with-google-ios?hl=en)
3. In **Audience**, keep development in **Testing** and add the Google accounts you will use on the OPPO and iOS device under **Test users**. [Audience settings](https://support.google.com/cloud/answer/15549945?hl=en)
4. This sign-in flow uses basic identity scopes: `openid`, `email` and `profile`. If **Data Access** asks for scopes, keep it to those basic scopes.

### 3b. Create the shared Web client

Use the [OAuth Clients page](https://console.cloud.google.com/auth/clients); [Google documents each client type here](https://support.google.com/cloud/answer/15549257?hl=en).

1. Open **Google Auth Platform → Clients → Create client**.
2. Choose application type **Web application** and name it **YGo backend**.
3. Leave **Authorized JavaScript origins** and **Authorized redirect URIs** empty for this native ID-token flow, then create it.
4. Copy its **Client ID**, ending in `.apps.googleusercontent.com`, into your private note as `GOOGLE_WEB_CLIENT_ID`. The implementation does not use its client secret.

### 3c. Create the two Android clients

1. Select **Create client → Android**.
2. Name it **YGo Customer Android development**. Enter the Customer package and Customer debug SHA-1 from stage 2. Create it.
3. Repeat for **YGo Shopkeeper Android development**, using the Shopkeeper package and its SHA-1.
4. Keep both registrations in the same project as **YGo backend**. The Android client registrations authorize the installed apps; their client IDs are not copied into the two `EXPO_PUBLIC_` settings below. [Google's Android client setup](https://developer.android.com/identity/authorization)

### 3d. Create the two iOS clients

1. Select **Create client → iOS**.
2. Name it **YGo Customer iOS** and enter the Customer bundle identifier from stage 2. Supply your Apple Team ID if the console requests it, then create it.
3. Copy its Client ID into your note as `CUSTOMER_GOOGLE_IOS_CLIENT_ID`.
4. Repeat for **YGo Shopkeeper iOS**, using its bundle identifier. Record `SHOPKEEPER_GOOGLE_IOS_CLIENT_ID`.

The native app uses its iOS client ID plus the shared Web client ID for backend authentication. YGo's config derives the iOS return URL scheme automatically. [Google's iOS configuration guide](https://developers.google.com/identity/sign-in/ios/start-integrating)

**Checkpoint:** the Clients page lists one Web, two Android and two iOS clients. You have copied the Web ID and the two iOS IDs. All three end in `.apps.googleusercontent.com`.

## 4. Put each Google value in the right file

Create only missing local environment files; preserve any settings already there:

```sh
test -f apps/customer/.env || cp apps/customer/.env.example apps/customer/.env
test -f apps/shopkeeper/.env || cp apps/shopkeeper/.env.example apps/shopkeeper/.env
test -f apps/server/.env || cp apps/server/.env.example apps/server/.env
```

Edit the files in your editor. Values below are placeholders. Paste each complete real client ID after `=`, replacing the **whole** example value, including its example suffix.

**`apps/customer/.env`:**

```dotenv
EXPO_PUBLIC_API_BASE_URL=http://YOUR_MAC_LAN_IP:3000
EXPO_PUBLIC_SUPPORT_EMAIL=YOUR_SUPPORT_EMAIL
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=YOUR_SHARED_WEB_CLIENT_ID.apps.googleusercontent.com
EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=YOUR_CUSTOMER_IOS_CLIENT_ID.apps.googleusercontent.com
```

**`apps/shopkeeper/.env`:**

```dotenv
EXPO_PUBLIC_API_BASE_URL=http://YOUR_MAC_LAN_IP:3000
EXPO_PUBLIC_SUPPORT_EMAIL=YOUR_SUPPORT_EMAIL
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=YOUR_SHARED_WEB_CLIENT_ID.apps.googleusercontent.com
EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=YOUR_SHOPKEEPER_IOS_CLIENT_ID.apps.googleusercontent.com
```

**Add or update these lines in `apps/server/.env`; keep its existing database, mailer and secret settings:**

```dotenv
HOST=0.0.0.0
PORT=3000
GOOGLE_CLIENT_IDS=YOUR_SHARED_WEB_CLIENT_ID.apps.googleusercontent.com
APPLE_CLIENT_IDS=
```

`GOOGLE_CLIENT_IDS` contains the **Web** client ID used by both apps. Later, `APPLE_CLIENT_IDS` will contain Apple **bundle identifiers**, not Google iOS client IDs.

| Where the app runs | `EXPO_PUBLIC_API_BASE_URL` |
| --- | --- |
| OPPO or real iPhone on the Mac's Wi-Fi | `http://YOUR_MAC_LAN_IP:3000` |
| Android emulator | `http://10.0.2.2:3000` |
| iOS simulator | `http://127.0.0.1:3000` |

Find the Mac's Wi-Fi IP in **System Settings → Wi-Fi → Details → TCP/IP**. Use a real email address for `EXPO_PUBLIC_SUPPORT_EMAIL`. The `EXPO_PUBLIC_` values are included in the app bundle; keep client secrets and signing material out of them. `.env` files stay git-ignored.

**Checkpoint:** both apps have the same Web ID, different iOS IDs, a valid support email and an API address reachable from the selected device.

## 5. Start the local database, inbox and API

1. Follow [server local setup](../../apps/server/README.md#run-it-locally) to create PostgreSQL and Mailpit if this is a new machine. If the named containers already exist, start them:

   ```sh
   docker start ygo-postgres ygo-mailpit
   ```

2. If `AUTH_TOKEN_SECRET` in `apps/server/.env` is still the example value, generate a replacement with `openssl rand -hex 32` and put it in that local file. Keep existing working secrets unchanged.
3. Build the API and apply migrations **before** starting it:

   ```sh
   pnpm --filter @ygo/server build
   node --env-file=apps/server/.env apps/server/dist/migrate.js
   ```

   Successful migration exits without an error. Migration `0015_identity_challenges.sql` is required for provider sign-in. The API does not migrate on startup.

4. In a terminal left running, start the API:

   ```sh
   pnpm --filter @ygo/server dev
   ```

5. In another terminal, check it:

   ```sh
   curl --fail http://127.0.0.1:3000/v1/healthz
   ```

   Expect `{"status":"ok"}`. On the phone, open `http://YOUR_MAC_LAN_IP:3000/v1/healthz` in its browser and expect the same response. If that fails, fix Wi-Fi/address/firewall access before testing sign-in.

Local emailed codes appear in [Mailpit](http://localhost:8025); they are not delivered to your real mailbox. Direct Gmail/Workspace sign-in still uses the real Google account picker. No image-storage service is needed just to check sign-in.

**Checkpoint:** the phone reaches the API health URL, and Mailpit opens on the Mac.

## 6. Rebuild and test Google on the OPPO

1. Connect the OPPO by USB, enable USB debugging, and accept its authorization prompt. Confirm it appears as `device`, rather than `unauthorized`:

   ```sh
   adb devices
   ```

2. Apply the provider config to both existing native projects. A rebuild alone does not apply the config plugins. `--no-clean` keeps the native folders rather than recreating them:

   ```sh
   pnpm --filter @ygo/customer exec expo prebuild --platform android --no-install --no-clean
   pnpm --filter @ygo/shopkeeper exec expo prebuild --platform android --no-install --no-clean
   ```

   Rerun the two fingerprint commands from stage 2 afterward. If a fingerprint changed, update its Google Android client registration before testing.

3. Build and run **Customer**:

   ```sh
   pnpm --filter @ygo/customer android --device
   ```

   Choose the OPPO when prompted. Leave Metro running while checking that app.

4. Tap Google, choose a test Gmail account, complete name/phone if prompted, then sign out and repeat. Expect the same account/profile.
5. Stop Customer's Metro with Ctrl-C. Build and run **Shopkeeper**:

   ```sh
   pnpm --filter @ygo/shopkeeper android --device
   ```

   Use the same Google account. Expect the same YGo profile; Shopkeeper then shows that account's shop application or Start screen.

**Checkpoint:** Google works in both Android apps. Apple setup can follow separately.

## 7. Enable Apple for the two iOS app identifiers

Use an Apple developer team that can enable **Sign in with Apple**. If enrollment or capability access is pending, leave this stage and the Apple device checks pending; an unsigned simulator compile does not prove account authorization.

1. Open [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list), select **Identifiers**, and use **+ → App IDs → App** if an identifier is missing. Register each app using its **Explicit** bundle identifier from stage 2. [Register an App ID](https://developer.apple.com/help/account/identifiers/register-an-app-id)
2. Open the Customer App ID. Under **Capabilities**, enable **Sign in with Apple**, then **Configure** and choose **Enable as a primary App ID**. Save the configuration and App ID.
3. Open the Shopkeeper App ID. Enable the same capability, choose **Group with an existing primary App ID**, select Customer, and save both changes. [Apple app grouping](https://developer.apple.com/help/account/capabilities/group-apps-for-sign-in-with-apple/)
4. In `apps/server/.env`, set both bundle identifiers, comma-separated, without spaces:

   ```dotenv
   APPLE_CLIENT_IDS=YOUR_CUSTOMER_IOS_BUNDLE_ID,YOUR_SHOPKEEPER_IOS_BUNDLE_ID
   ```

5. Restart the API so it reads the new value. Apple uses native app identifiers here; this implementation does not require a Services ID or a `.p8` key.

**Checkpoint:** both App IDs have the capability, Shopkeeper is grouped with Customer, and the server allows both bundle identifiers.

## 8. Rebuild and check iOS

1. Verify the local `ios.bundleIdentifier` in each `app.json` still matches stage 2, and each app's `.env` contains its Google iOS client ID.
2. Apply native config and install iOS dependencies. Use `--no-clean` to preserve the existing native project:

   ```sh
   pnpm --filter @ygo/customer exec expo prebuild --platform ios --no-clean
   pnpm --filter @ygo/shopkeeper exec expo prebuild --platform ios --no-clean
   ```

   YGo adds the Google return scheme/URL handler and Apple entitlement automatically. Keep signing changes in Xcode, not manual edits to generated AppDelegate code.

3. For a real iPhone build, open the generated `.xcworkspace` in each app's `ios/` directory. In Xcode, select the app target, then **Signing & Capabilities**. Choose the same developer team used in stage 7, enable automatic signing, and confirm **Sign in with Apple** is present. Let Xcode refresh the provisioning profile with that entitlement. [Expo Apple setup](https://docs.expo.dev/versions/latest/sdk/apple-authentication/)
4. Connect and trust the iPhone; enable Developer Mode if iOS asks. Select the device when running:

   ```sh
   pnpm --filter @ygo/customer ios --device
   ```

5. Check Google and Apple in Customer. Stop its Metro, then repeat in Shopkeeper:

   ```sh
   pnpm --filter @ygo/shopkeeper ios --device
   ```

For simulator layout checks, use the same commands without `--device`. Set the API address for the device you actually selected, and restart Metro after environment changes. Use a real iPhone signed in to an Apple Account for the final Apple authorization check.

**Checkpoint:** both iOS apps open; Google returns to the app; Apple completes authorization and reaches the profile or app screen.

## 9. Set up email delivery for Apple's Hide My Email

Do this before testing emailed-code fallback to a real Apple relay address. Direct Apple sign-in and email delivery are separate checks.

1. Open **Certificates, Identifiers & Profiles → Services**. Under **Sign in with Apple for Email Communication**, select **Configure**.
2. Under **Email Sources**, add the actual outbound sender address or domain used by the deployed API's `MAIL_FROM`, and register it.
3. Configure sender authentication. Apple's relay checks the registered source and SPF and/or DKIM. For an email service whose envelope sender uses a different domain, configure DKIM with the required matching sender domain. Follow [Apple's relay setup and authentication requirements](https://developer.apple.com/help/account/capabilities/configure-private-email-relay-service).
4. Use the real configured sender, sign in with Hide My Email, then test an emailed code to the relay address and confirm delivery. With `MAILER=mailpit`, inspect the local inbox instead; that does not verify Apple's relay or SES delivery.

YGo treats the relay address as a separate email. It does not merge it with a Gmail account by phone number. A phone already claimed by another account remains refused and points to support.

**Checkpoint:** actual delivered relay mail is checked separately from locally captured Mailpit messages.

## 10. Record the final phone checks

Repeat these in **Customer and Shopkeeper**. Record Android/iOS results separately on [PR #308](https://github.com/Hemanshujc1/YGo/pull/308).

- [ ] Google appears on Android and iOS; Apple appears on a supported iOS device only.
- [ ] Light/Dark and 130% text size remain usable.
- [ ] The tapped action shows a spinner and other sign-in actions are disabled. Canceling returns quietly to sign-in.
- [ ] A new account completes name/phone once. Google, Apple sharing the same email, and emailed code for that email reach the same profile.
- [ ] Google with an external mailbox and no Workspace opens the emailed-code screen; it grants access only after the code is entered.
- [ ] Apple Hide My Email follows the separate-address behavior described above.
- [ ] Killing/reopening restores the saved session. Signing out and reopening stays signed out.
- [ ] Offline/provider failures allow retry; Help opens the configured support email.

For each device, record: app, OS, device model, build/check date, and which checks passed or failed. Leave #36 open and PR #308 in draft until the real-provider checks pass.

## Troubleshooting

| What happens | Check this first |
| --- | --- |
| Google shows a developer/configuration error | Compare the installed app's package and SHA-1 with its Android OAuth registration. Check that all Google clients belong to the same project. |
| Google account is refused by consent settings | Add that account under Google Auth Platform → Audience → Test users; confirm the project and audience. |
| Google works in Customer but fails in Shopkeeper | Check Shopkeeper's own Android package/SHA-1 or iOS bundle/client ID. Its iOS client ID differs from Customer's. |
| Google picker returns but YGo refuses sign-in | Server `GOOGLE_CLIENT_IDS` must contain the shared **Web** ID used by the app. Restart the API after editing it. |
| Google cannot return to the iOS app | Check the iOS client ID matches that bundle identifier. Repeat iOS prebuild and rebuild so the scheme and return handler are installed. |
| Apple button is missing | Use supported iOS; it is intentionally absent on Android and when the native API is unavailable. |
| Apple authorization fails | Check the Apple team, explicit bundle identifier, enabled capability and refreshed signing profile. |
| Apple returns to YGo but access is refused | Check both bundle identifiers in server `APPLE_CLIENT_IDS`, then restart the API. |
| A phone shows “Can't reach YGo” | Open the health URL on that phone. Check `HOST=0.0.0.0`, Wi-Fi, API address and firewall. `127.0.0.1` on a real phone points at the phone. |
| Sign-in fails after moving to a fresh database | Build the server and run the migration command in stage 5. Health alone does not prove the auth tables exist. |
| A new native module cannot be found | Run prebuild and install a rebuilt app; Metro refresh cannot add the module. |
| Email code does not arrive in a real mailbox locally | With `MAILER=mailpit`, read http://localhost:8025. Real relay delivery requires stage 9 and a real sender. |
| Android install says signatures differ | The installed package was signed by another key. Use the intended key; coordinate before uninstalling because uninstall removes that app's local data. |
| A Play-installed build fails Google sign-in | Register its package with the **Play app-signing certificate** SHA-1. The local debug registration covers only that debug certificate. |

## Later: staging, production and store signing

1. Use the identifiers and signing certificates for the actual distributed builds when creating their provider registrations. Record any additional permitted Web IDs explicitly.
2. Add `GOOGLE_CLIENT_IDS` and `APPLE_CLIENT_IDS` to the existing private runtime environment documents in SSM Parameter Store: `/ygo/staging/runtime` and `/ygo/production/runtime`. Preserve the other settings. Follow the [provisioning](provisioning.md#iam-and-configuration) and [host deployment](provisioning.md#host-deploy-and-rollback-133) runbooks; editing SSM alone does not update a running API.
3. Build each app with the corresponding public OAuth IDs and deployed HTTPS API URL. Repeat the device checks against that environment.
4. Review Google Audience/publishing settings before inviting users beyond development. Do not treat developer test-user access as launch validation.

Keep secrets, downloaded signing files, runtime environment documents and real identity tokens out of Git and PR comments. Share test outcomes and public client IDs only when needed for setup review.
