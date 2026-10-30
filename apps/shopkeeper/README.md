# @ygo/shopkeeper

The Shopkeeper app (Owner and Staff; delivery is a tab inside it, CONTEXT.md): Expo SDK 57, `expo-router` and NativeWind v4 over `@ygo/tokens` (ADR-0001). Signed out, it shows sign-in: C01 Sign in, C14 Enter email code, then C02 Your name and phone number once. After that it loads the account's shop application (#294): with none, a Start screen ("Start my shop application"); a Draft opens S17 Shop application, one form in four groups with Save draft, where the shop's location comes from the phone's GPS or from a pin moved on Google's map (#307); a sent one opens S18 Application status, the five steps from Draft to Live, refreshed by pulling down (#292). Each of these ends with the theme choice and Sign out. Joining a shop as staff comes with #58.

## Run it locally

Expo Go is not used (ADR-0001). `expo run` makes a local development build and starts Metro.

1. Start the server: see `apps/server/README.md`. It listens on `127.0.0.1:3000`.
2. Tell the app where the API is, in `apps/shopkeeper/.env` (git-ignored):

   ```sh
   EXPO_PUBLIC_API_BASE_URL=http://127.0.0.1:3000
   # Where Help and a phone already in use point.
   EXPO_PUBLIC_SUPPORT_EMAIL=
   # Optional until the store listings exist; while unset, the update screen names the stores instead of showing a button. A store build needs both.
   EXPO_PUBLIC_ANDROID_STORE_URL=
   EXPO_PUBLIC_IOS_STORE_URL=
   # The Google map keys for S17's map, the same two as the Customer app's.
   GOOGLE_MAPS_ANDROID_API_KEY=
   GOOGLE_MAPS_IOS_API_KEY=
   ```

   Without the map keys the map on S17 is blank. Each key's restrictions in Google Cloud list this app too: its package name with the same debug SHA-1 on the Android key, and its bundle ID on the iOS key (see [the map keys](../customer/README.md#the-map-keys)).

   That works from the iOS simulator. The Android emulator reaches the Mac at `http://10.0.2.2:3000`. A real phone needs the Mac's LAN address, with the server started with `HOST=0.0.0.0`.
3. Build and open it:

   ```sh
   pnpm --filter @ygo/shopkeeper ios      # or: android
   ```

   The first run asks for an iOS bundle identifier or Android package name. Use a throwaway one and do not commit it: the store ticket picks the real ones, which cannot change after the first upload.

Without `EXPO_PUBLIC_API_BASE_URL`, without an email address in `EXPO_PUBLIC_SUPPORT_EMAIL`, or without a `version` in `app.json`, the app stops at start with an error naming it.

At launch the app asks the server who is signed in (`GET /v1/me`), with a blank screen in the theme colour until it answers. With no answer, "Can't reach YGo" offers Try again and keeps the saved sign-in.

At launch the app calls `GET /v1/version-check`, sending its name and the `app.json` version. If the server answers 426 `UPDATE_REQUIRED` (its `MIN_SHOPKEEPER_VERSION` is newer), a full screen asks the person to update, with a button to the store link for the platform, or a line naming the stores when no link is set. Offline or any other answer lets the app carry on.

The theme (System, Light or Dark) is chosen at the end of the shop application screens for now, and on S36 More once it is built. The choice is saved on the phone with MMKV and applied before the first screen draws; System follows the phone's theme. The status bar and Android's navigation bar follow the theme on screen.

`EXPO_PUBLIC_` variables are written into the bundle at build time, so they are public: never put a secret in one.

## Build

`pnpm --filter @ygo/shopkeeper build` runs `expo export` for Android and iOS into `dist/`. The gate runs it to prove the JavaScript bundles.

## Test

`pnpm --filter @ygo/shopkeeper test` runs the Vitest tests in `test/`, for the logic under `src/lib/`.

## Styling

NativeWind classes over `@ygo/tokens` roles only, such as `bg-surface` and `text-muted`. `tailwind.config.js` loads the same `@ygo/tokens/tailwind` plugin as the web apps, which replaces Tailwind's palette and switches to the dark values with the theme in use. `metro.config.js` sets 1rem to 16, as on the web, so the spacing scale matches the design system. Inline `style` is only for values known at runtime, such as safe-area insets.

## Google and Apple sign-in

See [provider setup and device checks](../../docs/operations/social-sign-in.md). Both apps need a new native build after installing these sign-in modules.

## Encrypted opening stock (#390)

Rebuild the native app after pulling this change. `expo-sqlite` must have `useSQLCipher` enabled; the app checks `PRAGMA cipher_version` and refuses to open stock storage without it. Expo export checks JavaScript, not native encryption.

Opening-stock entries now live in an account-scoped SQLCipher database, with each row scoped to its shop and pack. A 32-byte random key stays in this phone's SecureStore. The existing MMKV queue is imported only for the shop verified by the server; the old entry is removed after the encrypted transaction commits. Malformed or conflicting legacy entries are retained for attention. An unreadable or missing key never causes a database reset. Sign-out checks pending entries first and offers the Opening stock screen to retry.

Native verification after rebuilding: save opening stock without a connection, kill/reopen the app and reconnect, then retry; expect the same opening quantity recorded once. A missing SQLCipher build must show the storage error. The actual encrypted file must refuse reads with ordinary SQLite or a wrong key, and reopen with its original key. Use synthetic data only, and never print or copy the key into logs. Cold launching the stock screen without connectivity and confirmed shop-unlink cleanup are subsequent #48 children.
