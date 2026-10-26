# @ygo/customer

The Customer app: Expo SDK 57, `expo-router` and NativeWind v4 over `@ygo/tokens` (ADR-0001). Signed out, it shows sign-in: C01 Sign in, C14 Enter email code, then C02 Your name and phone number once. After that it shows, for now, a link to Account (C23), the server's health answer and the Inter review specimens. Account shows the name, which can be changed, the email and phone, the System / Light / Dark theme choice, Help and Sign out.

## Run it locally

Expo Go is not used (ADR-0001). `expo run` makes a local development build and starts Metro.

1. Start the server: see `apps/server/README.md`. It listens on `127.0.0.1:3000`.
2. Copy `apps/customer/.env.example` to `apps/customer/.env` (git-ignored), and set the support email. It points at the server on `127.0.0.1:3000`, which works from the iOS simulator. The Android emulator reaches the Mac at `http://10.0.2.2:3000`. A real phone needs the Mac's LAN address, with the server started with `HOST=0.0.0.0`. For the Android map, also set `GOOGLE_MAPS_ANDROID_API_KEY` (a Maps SDK for Android key restricted to your package and debug SHA-1); without it the map on Confirm location is blank.
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

## Build

`pnpm --filter @ygo/customer build` runs `expo export` for Android and iOS into `dist/`. The gate runs it to prove the JavaScript bundles.

## Styling

NativeWind classes over `@ygo/tokens` roles only, such as `bg-surface` and `text-muted`. `tailwind.config.js` loads the same `@ygo/tokens/tailwind` plugin as the web apps, which replaces Tailwind's palette and switches to the dark values with the theme in use. `metro.config.js` sets 1rem to 16, as on the web, so the spacing scale matches the design system. Inline `style` is only for values known at runtime, such as safe-area insets.
