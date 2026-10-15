# YGo

Hyperlocal quick-commerce platform connecting customers with local shops within a 2–3 km radius.
`References/` holds read-only reference repos and UI inspiration. Research them, never modify them.

This file is the rulebook for every coding agent and every developer. Claude Code reads it through `CLAUDE.md`; Codex, Cursor and other agents read it directly.

Before starting a ticket, read `docs/agents/workflow.md`: how work is claimed, branched, sized and reviewed when several agents and developers work in parallel.

## Writing code

- Write the minimum the ticket asks for. One caller gets inline code; handle only the errors that can actually occur.
- Keep each diff surgical: every changed line traces to the ticket and matches the surrounding style. Report unrelated problems in the PR description, and remove only what your own change made unused.
- Decide technical trade-offs yourself and state your assumptions in the PR. Ask the owner only about money, time, risk or user-visible behaviour.
- Before writing code, name the check that proves the ticket is done (a test, a typecheck, a reproduction), and finish when it passes.

## Where code lives

Every kind of shared code has exactly one home. Before creating a component, helper, type or constant, search its home and the app you are in for something that already does the job, then reuse or extend it. State in the PR what you searched for when you add something new.

| What | Home |
| --- | --- |
| Request and response shapes, error codes | `@ygo/contracts` |
| Calling the API, retries, token refresh | `@ygo/api-client` |
| Prices, fees, coupons | `@ygo/pricing` |
| Money, number, date and time display | `@ygo/format` |
| Colours, spacing, type | `@ygo/tokens` |
| A component or helper one screen uses | Beside that screen |
| A component or helper two screens of one app use | That app's `components/` or `lib/` |

- Extract on the second use, not the first: the second copy inside one app moves to that app's `components/` or `lib/`.
- Code two apps need moves into the matching package above. A new package needs an ADR first.
- Mobile and web keep separate UI components; there is no shared UI package (ADR-0001, ADR-0007).
- Add a dependency only after checking that no installed one does the job, and say why in the PR.

## Project docs outrank skills

`CONTEXT.md`, `docs/adr/`, `docs/product/` and `docs/design/design-system.md` win over any installed skill.

`expo-native-ui` (`.agents/skills/`) is written for generic Expo apps, and three of its rules conflict with YGo:

- Style with NativeWind classes over `@ygo/tokens` (ADR-0001), in place of its inline styles and platform semantic colours. Inline `style` is for values that change at runtime, such as animated or measured sizes.
- Use Lucide icons (`lucide-react-native`), in place of SF Symbols.
- Build one YGo design for iOS and Android from the design system, in place of separate Apple HIG and Material looks.

Use it for safe areas, keyboard handling, lists, screen states and running in Expo Go.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `Hemanshujc1/YGo`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `CONTEXT.md` plus `docs/adr/`. See `docs/agents/domain.md`.
