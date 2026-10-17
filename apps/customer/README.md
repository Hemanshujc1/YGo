# @ygo/customer

The Customer app: Expo SDK 57, `expo-router` and NativeWind v4 over `@ygo/tokens` (ADR-0001). For now it shows the server's health answer.

## Run it locally

Expo Go is not used (ADR-0001). `expo run` makes a local development build and starts Metro.

1. Start the server: see `apps/server/README.md`. It listens on `127.0.0.1:3000`.
2. Tell the app where the API is, in `apps/customer/.env` (git-ignored):

   ```sh
   EXPO_PUBLIC_API_BASE_URL=http://127.0.0.1:3000
   ```

   That works from the iOS simulator. The Android emulator reaches the Mac at `http://10.0.2.2:3000`. A real phone needs the Mac's LAN address, with the server started with `HOST=0.0.0.0`.
3. Build and open it:

   ```sh
   pnpm --filter @ygo/customer ios      # or: android
   ```

   The first run asks for an iOS bundle identifier or Android package name. Use a throwaway one and do not commit it: the store ticket picks the real ones, which cannot change after the first upload.

The screen shows "ok", the words for the error code the server answered (`src/strings.ts`), or "The server cannot be reached." when no answer comes back within 10 seconds.

`EXPO_PUBLIC_` variables are written into the bundle at build time, so they are public: never put a secret in one.

## Build

`pnpm --filter @ygo/customer build` runs `expo export` for Android and iOS into `dist/`. The gate runs it to prove the JavaScript bundles.

## Styling

NativeWind classes over `@ygo/tokens` roles only, such as `bg-surface` and `text-muted`. `tailwind.config.js` loads the same `@ygo/tokens/tailwind` plugin as the web apps, which replaces Tailwind's palette and switches to the dark values with the system theme. `metro.config.js` sets 1rem to 16, as on the web, so the spacing scale matches the design system. Inline `style` is only for values known at runtime, such as safe-area insets.
