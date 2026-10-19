# @ygo/mobile

Code both mobile apps use: the Customer and Shopkeeper apps, never the web apps or the server (ADR-0009).

- `AppShell`: wraps each app's root layout. It applies the saved theme before the first render, sets the system bars and shows `UpdateRequired` in place of the app when the launch version check is refused.
- `Text`: React Native's `Text` set in Inter.
- `savedTheme`, `chooseTheme`, `ThemeChoice`: the theme choice, saved in MMKV.

The package holds no words and reads no settings: each app passes its strings and store links as props. A component moves in only when both apps use it, and nothing only one app uses belongs here.

Each app's `tailwind.config.js` lists `../../packages/mobile/src/**/*.tsx` in `content`, or the classes here never get generated. Every peer dependency is pinned to the exact version both apps pin; bump them together.
