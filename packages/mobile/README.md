# @ygo/mobile

Code both mobile apps use: the Customer and Shopkeeper apps, never the web apps or the server (ADR-0009).

- `AppShell`: wraps each app's root layout. It sets the system bars, runs the version check at launch and whenever the app comes back from the background, and shows `UpdateRequired` in place of the app once any call is refused.
- `showUpdateRequired`: each app passes it to `createApiClient` as `onUpdateRequired`, so a 426 `UPDATE_REQUIRED` from any call shows the update screen. It stays until the app restarts.
- `sessionStore`: each app passes it to `createApiClient` as `session`. The refresh token lives in `expo-secure-store`, on this phone only: the Keychain never syncs it, and each app's `app.json` lists the `expo-secure-store` plugin, which leaves it out of Android backups. Never in MMKV. A sign-out whose clear fails leaves a marker in MMKV, and while it is set the token is never handed out. A fresh install ignores a token an earlier install left in the Keychain, and a token that can't be read counts as none. A marker that can't be read counts as set. The client queues every store call in order, so a sign-in and a sign-out never overlap.
- `showSignedOut`, `createSession`, `useSession`: each app passes `showSignedOut` as `onSignedOut` and makes one `session = createSession(api)`. A new `createSession` takes the signal from the last, so Fast Refresh leaves no stale listener. `useSession(session)` answers checking, signed out, profile needed, signed in, or unreachable, which picks the screen.
- `Text`: React Native's `Text` set in Inter.
- `applySavedTheme`, `savedTheme`, `chooseTheme`, `ThemeChoice`: the theme choice, saved in MMKV. Each root layout calls `applySavedTheme()` once, after importing its stylesheet, so a saved Light or Dark never flashes the system theme. Importing the package has no side effects.

The package holds no words and reads no settings: each app passes its strings and store links as props. A component moves in only when both apps use it, and nothing only one app uses belongs here.

Each app's `tailwind.config.js` lists `../../packages/mobile/src/**/*.tsx` in `content`, or the classes here never get generated. Every peer dependency is pinned to the exact version both apps pin; bump them together.
