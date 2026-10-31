# @ygo/customer

The Customer app: Expo SDK 57, `expo-router` and NativeWind v4 over `@ygo/tokens` (ADR-0001). Signed out, it shows sign-in: C01 Sign in, C14 Enter email code, then C02 Your name and phone number once. After that it shows, for now, a link to Account (C23), the server's health answer and the Inter review specimens. Account shows the name, which can be changed, the email and phone, the System / Light / Dark theme choice, Help and Sign out.

## Run it locally

Expo Go is not used (ADR-0001). `expo run` makes a local development build and starts Metro.

1. Start the server: see `apps/server/README.md`. It listens on `127.0.0.1:3000`.
2. Copy `apps/customer/.env.example` to `apps/customer/.env` (git-ignored), and set the support email. It points at the server on `127.0.0.1:3000`, which works from the iOS simulator. The Android emulator reaches the Mac at `http://10.0.2.2:3000`. A real phone needs the Mac's LAN address, with the server started with `HOST=0.0.0.0`. For the map, also set `GOOGLE_MAPS_ANDROID_API_KEY` and `GOOGLE_MAPS_IOS_API_KEY` (see [The map keys](#the-map-keys)); without them the map on Confirm location is blank.
3. Build and open it:

   ```sh
   pnpm --filter @ygo/customer ios      # or: android
   ```

   The first run asks for an iOS bundle identifier or Android package name. Use a throwaway one and do not commit it: the store ticket picks the real ones, which cannot change after the first upload.

The screen shows "ok", the words for the error code the server answered (`src/strings.ts`), or "The server cannot be reached." when no answer comes back within 10 seconds. Without `EXPO_PUBLIC_API_BASE_URL`, without an email address in `EXPO_PUBLIC_SUPPORT_EMAIL`, or without a `version` in `app.json`, the app stops at start with an error naming it.

At launch the app asks the server who is signed in (`GET /v1/me`), with a blank screen in the theme colour until it answers. With no answer, "Can't reach YGo" offers Try again and keeps the saved sign-in.

At launch the app calls `GET /v1/version-check`, sending its name and the `app.json` version. If the server answers 426 `UPDATE_REQUIRED` (its `MIN_CUSTOMER_VERSION` is newer), a full screen asks the person to update, with a button to the store link for the platform, or a line naming the stores when no link is set. Offline or any other answer lets the app carry on.

The theme choice is saved on the phone with MMKV and applied before the first screen draws. The status bar and Android's navigation bar follow the theme on screen.

`EXPO_PUBLIC_` variables are written into the bundle at build time, so they are public: never put a secret in one.

## The map keys

Confirm location draws Google's map on both phones (#255, #307), through `PinMap` from `@ygo/mobile`. Each phone has its own key: a Maps SDK for Android key from `GOOGLE_MAPS_ANDROID_API_KEY` and a Maps SDK for iOS key from `GOOGLE_MAPS_IOS_API_KEY`. The Shopkeeper app uses the same two keys for S17's map. `app.config.ts` reads the variables from `apps/customer/.env` or the build's environment, so the keys are never in the repo. A release build sets `YGO_RELEASE_BUILD=1` and then stops with an error naming a missing key, instead of shipping the blank-map placeholder a development build keeps (#315). The build writes each into the app, where anyone can read it, so restrict both in Google Cloud:

- **Android key**: API restrictions to Maps SDK for Android only, and application restrictions to Android apps, each entry a package name with a SHA-1 fingerprint: one per app.
- **iOS key**: API restrictions to Maps SDK for iOS only, and application restrictions to iOS apps, each entry a bundle ID (`PRODUCT_BUNDLE_IDENTIFIER` in the app's `ios/` Xcode project): one per app.

For the Android entries:

- **Package name**: `applicationId` in `apps/customer/android/app/build.gradle`, the throwaway one chosen on the first run.
- **Debug SHA-1**: a local build is signed with `apps/customer/android/app/debug.keystore`, which `expo run:android` writes from React Native's template, not with `~/.android/debug.keystore`. Read its fingerprint with:

  ```sh
  keytool -list -v -keystore apps/customer/android/app/debug.keystore -alias androiddebugkey -storepass android | grep SHA1
  ```

- **Store builds**: Google Play signs them with its own key, so add a second entry with the SHA-1 of Play's app signing key (Play Console, the app's App integrity page). Add the upload key's SHA-1 too if testers install builds you signed yourself.

A wrong package or SHA-1 shows a blank map with no error in the app. `adb logcat | grep -i "authorization failure"` shows Google's refusal; the lines after it name the package and SHA-1 the app sent, and the key, so do not paste them anywhere public.

On iOS a wrong bundle ID also shows a blank map; the Xcode console names Google's refusal. A changed key reaches the app only with a new native build (`expo run:android` or `expo run:ios`).

## Build

`pnpm --filter @ygo/customer build` runs `expo export` for Android and iOS into `dist/`. The gate runs it to prove the JavaScript bundles.

## Native location regression

With a signed-in test account on a connected Android development build, the local API and Customer Metro running, and maps/geocoding configured, run:

```sh
ANDROID_SERIAL=<device> python3 apps/customer/test/device/confirm-location.py --search
```

This checks airport search, map Back/reopen and confirming an Other address outside the service radius (#387). It saves an Other address on the test account. Without `--search`, it opens the airport coordinates directly to isolate map locking on save. This needs a real native map; the Vitest map mock cannot reproduce Android view parenting.

## Native cold-launch regression

The Android screens dependency has a [temporary upstream patch](../../patches/README.md)
for #402. Rebuild the APK after installing dependencies; Metro alone cannot apply it.
With the same signed-in native development app and services as the airport check:

```sh
ANDROID_SERIAL=<device> python3 apps/customer/test/device/cold-start.py --launches 20
```

Each attempt force-stops Customer, opens Confirm location and inspects the native
UI for at least 15 seconds, allowing up to 60 seconds for the map to render.
A pass requires the same process to survive throughout and the native map to render. Run against the unpatched APK until it fails, then repeat at least that
many launches against the patched APK. On process death the script saves
`adb logcat -b crash` to `/tmp/ygo-cold-start-crash.log` (override with `--crash-log`)
and identifies the matching process's MountingCoordinator SIGSEGV. It does not
clear app data. Follow this with the airport `--search` check above and verify the
rebuilt Shopkeeper starts too.

## Styling

NativeWind classes over `@ygo/tokens` roles only, such as `bg-surface` and `text-muted`. `tailwind.config.js` loads the same `@ygo/tokens/tailwind` plugin as the web apps, which replaces Tailwind's palette and switches to the dark values with the theme in use. `metro.config.js` sets 1rem to 16, as on the web, so the spacing scale matches the design system. Inline `style` is only for values known at runtime, such as safe-area insets.

## Google and Apple sign-in

See [provider setup and device checks](../../docs/operations/social-sign-in.md). Both apps need a new native build after installing these sign-in modules.
