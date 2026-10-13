# ADR-0001: Mobile app framework

- **Status**: Accepted
- **Date**: 2026-10-13
- **Ticket**: [#22 Mobile apps: React Native/Expo evaluation](https://github.com/Hemanshujc1/YGo/issues/22)

## Context

Phase 1 ships two mobile surfaces, Customer and Shopkeeper, built and maintained by one developer working with coding agents, for a one-month real pilot of fifty to eighty hand-onboarded shops. Both Android and iOS are in scope from day one from a single codebase ([#12](https://github.com/Hemanshujc1/YGo/issues/12)).

Constraints already fixed before this decision:

- **Offline is a hard requirement**, not a nicety: counter billing, stock adjustment and the delivery screens work offline, with a queue bounded at five hundred actions or seventy-two hours ([#11](https://github.com/Hemanshujc1/YGo/issues/11)).
- **An acceptance alarm** must reach a phone sitting on a shop counter, loudly, with the order reachable in one tap ([#9](https://github.com/Hemanshujc1/YGo/issues/9)).
- **Android 10 is the product floor**; phone and portrait only; light and dark themes with colour expressed only through semantic tokens ([#12](https://github.com/Hemanshujc1/YGo/issues/12)).
- **No reference project used React Native, Expo, or any library named here.** `docs/research/reference-projects.md` withholds capability claims about all of them. The earlier VaayuGO work was React 19 with Vite, web only, in plain JavaScript.

## Decision

**React Native with Expo, SDK 57 pinned (React Native 0.86), TypeScript strict, as two separately published apps built from one repository.**

Expo here means **Expo with native code**: `expo prebuild`, config plugins and development builds from the first week. Expo Go is not part of the workflow at any point.

The decisions this record commits:

| Area | Decision |
| --- | --- |
| Framework | React Native with Expo, SDK 57 pinned for the whole pilot |
| Language | TypeScript, strict |
| Apps | Two listings, one repository; delivery lives inside the Shopkeeper app |
| Targets | Android 10 floor, iOS 16.4 floor, targeting Android 16 (API 36) |
| Navigation | `expo-router` |
| Local storage | `expo-sqlite` with SQLCipher; key in `expo-secure-store`; MMKV for display preferences only |
| Server reads | TanStack Query with a persister — disposable |
| Queued writes | An explicit SQLite outbox table — durable |
| Styling | NativeWind v4 over shared semantic tokens |
| Maps | Platform maps, operating-system geocoding, no paid Google APIs |
| Push | `expo-notifications` with Expo's push service; FCM credentials configured for Android |
| Alarm | Notification floor on both platforms; Notifee full-screen intent as an Android enhancement only |
| Builds | Local Android builds; EAS Build (Free) for iOS and every submission |
| Updates | EAS Update, JavaScript and assets only |

## Consequences

**What this forbids.** No `react-native-web`, and no UI component shared between the mobile apps and the Admin Web. No literal colour value in any screen. No Places or Geocoding API call. No over-the-air update that carries native code or changes declared functionality. No Expo SDK upgrade during the pilot. No use of the server-read cache to hold a queued write — that separation is the basis of [#11](https://github.com/Hemanshujc1/YGo/issues/11)'s conflict rules and of [#20](https://github.com/Hemanshujc1/YGo/issues/20).

**What it costs.** Two store listings mean two submissions, two data-safety declarations, two screenshot sets and possibly two fourteen-day closed tests for every release cycle. Pinning the SDK means a critical upstream fix that lands only in SDK 58 has no supported path in during the pilot. SQLCipher introduces a key that must survive app updates, and losing it loses the local queue.

**What it buys.** One codebase for both platforms. Over-the-air fixes measured in minutes rather than review days, which for one developer supporting fifty live shops is the single largest operational lever in the stack. Managed signing credentials. A styling layer in which [#12](https://github.com/Hemanshujc1/YGo/issues/12)'s token rule is greppable rather than remembered.

**Two platform constraints this decision surfaced rather than created.** The Android acceptance alarm is now permission-gated: `USE_FULL_SCREEN_INTENT` has been granted by default only to alarm-clock and calling apps since 22 January 2025, and an audio foreground service requires a Play Console declaration. The alarm therefore degrades on Android much as it already did on iOS, which is recorded as an amendment to [#9](https://github.com/Hemanshujc1/YGo/issues/9). And Play has required new apps to target API 36 since 31 August 2026, with an extension to 1 November 2026, so the toolchain's target level must be verified before the first build rather than at submission.

**Soft constraint created for [#23](https://github.com/Hemanshujc1/YGo/issues/23).** NativeWind's value is that token names live in one Tailwind configuration consumed by both the mobile apps and the Admin Web. If the Admin Web does not use Tailwind, this choice should be revisited in favour of Unistyles 3 rather than carried for consistency's sake.

**Unverified at the time of writing**, and listed so it is not mistaken for settled: that SDK 57 targets API 36; that Xcode personal-team provisioning can install a build on a real iPhone without the paid Apple enrolment; whether the twelve-tester closed test is required per app or per account; whether a Google Cloud billing account can be opened without a registered entity; and Expo's push-service free-tier terms.

## Alternatives considered

**Bare React Native.** Gives up config plugins, managed credentials and the update pipeline for no capability gain, because `prebuild` already exposes both native projects when a native module is needed. The New Architecture is mandatory from React Native 0.82 either way, so it was never a differentiator.

**Flutter.** A technically strong fit for the offline and alarm requirements, rejected on the cost of Dart for a solo developer whose existing work and whose remaining stack tickets are entirely React. No reference material in this project uses it.

**A webview wrapper (Capacitor or Ionic).** The one hybrid precedent in the reference material, and an old one. A webview is the wrong substrate for a seventy-two-hour offline till with encrypted local storage and for a locked-screen alarm, both of which are the hardest requirements in Phase 1 rather than peripheral ones.

**One app with role-based routing instead of two.** Cheaper on every store artefact and on closed testing. Rejected because a single bundle would ship hidden floor prices, commission logic and the counter till onto every customer's device, where unreachability is a routing decision and not a boundary.
