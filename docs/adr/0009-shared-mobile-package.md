# ADR-0009: A shared package for the two mobile apps

- **Status**: Accepted
- **Date**: 2026-10-19
- **Ticket**: [#141 ADR: a shared package for code both mobile apps use](https://github.com/Hemanshujc1/YGo/issues/141)

## Context

The Customer app shell (#120) and the Shopkeeper app shell (#124) were built one after the other, and the second copied the first. The two apps now hold identical `components/text.tsx`, `components/update-required.tsx`, `theme.ts` and `app/_layout.tsx`, and most of `strings.ts`. Every fix has to be made twice, and the copies will drift. Most of the design system's mobile components (buttons, inputs, sheets, empty states) will also be needed by both apps, so the copying grows with every screen.

AGENTS.md says code two apps need moves into a package, and a new package needs an ADR. [ADR-0007](0007-monorepo-and-shared-packages.md) lists seven packages and forbids "a shared UI package". Its reason is about mobile and web: "a package attempting to span React Native and the web becomes two implementations behind one import". Two React Native apps on the same pinned Expo SDK ([ADR-0001](0001-mobile-app-framework.md)) do not have that problem, but the rule as written covers them too.

## Decision

**Add an eighth package, `@ygo/mobile`, for code both mobile apps use. ADR-0007's "no shared UI package" is narrowed to "no UI shared between mobile and web".**

**What goes in.** A component, hook or helper that both the Customer and Shopkeeper apps use: shell parts such as the Inter `Text`, the update-required screen, the theme setting, the launch version check and the update listener (#137), and the design system's mobile components once both apps need them. Code moves in on its second use, when the second app needs it, the same rule AGENTS.md sets inside one app.

**What stays out.**

- Anything only one app uses. Above all, nothing only the Shopkeeper app uses, such as floor prices, commission or the counter till: ADR-0001 keeps that code off customers' phones, and a shared package must not become the way it gets there.
- Anything the web apps import. `@ygo/mobile` is React Native only.
- Anything that already has a home: calling the API (`@ygo/api-client`), shapes and error codes (`@ygo/contracts`), display formats (`@ygo/format`), colours, spacing and type (`@ygo/tokens`).
- App setup: `app.json`, the Tailwind, Babel and Metro configs stay in each app.
- Words. Shared parts take their text from the app as props, for example `<UpdateRequired title={strings.update.title} />`. Each app keeps one strings file, so Hindi stays a translation pass over that file (CONTEXT.md), and each app can name itself.

**How it is built.**

- TypeScript source with no build step, like the other packages (ADR-0007).
- React, React Native, NativeWind, MMKV and the Expo modules it uses are **peer dependencies**, so it runs on each app's own copy and never installs a second one. Their version requirements must accept the versions both apps pin. The apps pin identical exact versions today, and the package follows them when they change.
- Each app's `tailwind.config.js` adds the package's `src` folder to `content`. Without it, Tailwind never sees the package's class names and the shared parts render unstyled.
- Lint and typecheck from the first commit; tests when it holds logic worth testing.

## Consequences

**What this commits the codebase to.** The ticket that creates the package proves the workspace resolves one copy of each peer: `pnpm install` reports no peer-dependency warnings, `pnpm why react-native` (and the same for `react` and `nativewind`) shows a single version, and both apps bundle and run on a simulator. A second copy of React shows up as an "Invalid hook call" crash, so it is caught on first launch, not in a shop.

**What it forbids.** No import of `@ygo/mobile` from `apps/admin`, `apps/web` or `apps/server`. No text inside the package. No code in it that only one app uses.

**What it costs.** One more package and its Tailwind path in two configs. A change to a shared part affects both apps at once, so it is checked in both. An Expo upgrade, after the pilot's SDK pin is lifted, updates the package's peer requirements in the same commit as the apps.

**What it buys.** One fix for both apps, and one Customer and Shopkeeper look that cannot drift apart.

## Alternatives considered

**Keep copying.** No package and no ADR, and each app free to change its copy. Rejected because the copies are already identical and every design-system component would add another pair to keep in step by hand.

**Put mobile code in `@ygo/tokens`.** Already shared by both apps. Rejected because the web apps import `@ygo/tokens` too, and React Native code there would break the mobile and web separation this ADR keeps.

**One package for UI and another for shell logic.** Cleaner names, but two packages for a handful of files, split along a line no one has needed yet.
