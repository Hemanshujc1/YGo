# @ygo/mobile

Code both mobile apps use: the Customer and Shopkeeper apps, never the web apps or the server (ADR-0009).

- `AppShell`: wraps each app's root layout. It sets the system bars, runs the version check once at launch and shows `UpdateRequired` in place of the app when it is refused.
- `Text`: React Native's `Text` set in Inter.
- `applySavedTheme`, `savedTheme`, `chooseTheme`, `ThemeChoice`: the theme choice, saved in MMKV. Each root layout calls `applySavedTheme()` once, after importing its stylesheet, so a saved Light or Dark never flashes the system theme. Importing the package has no side effects.

The package holds no words and reads no settings: each app passes its strings and store links as props. A component moves in only when both apps use it, and nothing only one app uses belongs here.

Each app's `tailwind.config.js` lists `../../packages/mobile/src/**/*.tsx` in `content`, or the classes here never get generated. Every peer dependency is pinned to the exact version both apps pin; bump them together.
