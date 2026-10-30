# YGo

Hyperlocal quick-commerce platform connecting customers with local shops within a 2–3 km radius.
`References/` holds read-only reference repos and UI inspiration. Research them, never modify them.

This file is the rulebook for every coding agent and every developer. Codex, Cursor and other agents read it directly; Claude Code reads it through `CLAUDE.md`, which only imports it. Put new rules here, never in `CLAUDE.md`.

Write the brand as "YGo" everywhere: code, copy, docs and commits. Never "YUGO" or "YGO".

Before starting a ticket, read `docs/agents/workflow.md`: how work is claimed, branched, sized and reviewed when several agents and developers work in parallel.

## Writing code

- Write the minimum the ticket asks for. One caller gets inline code; handle only the errors that can actually occur.
- Keep each diff surgical: every changed line traces to the ticket and matches the surrounding style. Report unrelated problems in the PR description, and remove only what your own change made unused.
- Settle every assumption with the owner before writing code. After claiming the ticket, list each choice the ticket and the docs leave open, in plain words, in the rounds of the `grilling` skill (the owner can also start it with `/grill-me`): numbered questions, each with your recommended answer and its one-line reason, worded so "yes" accepts it. Put a deep technical choice as your decision, what it costs and why, so a "yes" is an informed one. Look facts up yourself and ask only for decisions; a choice the docs or the standing answers already settle needs no question. When no open choice is left, say "No open questions; building with the standing answers" and start. Otherwise wait for the answers and build what was agreed. Record the answers and the standing answers used in the PR's Assumptions section. An open question found mid-work stops the work until it is answered.
- Standing answers hold for every ticket without being asked; a ticket that needs a different one raises it as a question:
  - Done check: a test for each new behaviour, `pnpm check` before pushing, and a green gate in CI. Name it before writing code and finish when it passes. The owner checks a screen in a browser or on a phone after it merges, in a batch (`docs/agents/workflow.md`, section 7).
  - One PR per ticket, split only past the size limit in `docs/agents/workflow.md`.
  - Follow the pattern of the nearest existing screen, route or test.
  - A small fix in code the ticket already edits goes in the same PR and is named in it. A bigger or unrelated problem becomes a follow-up issue named in the PR.
  - A flaky test gets one rerun, and an issue only when it fails again.

## Where code lives

Every kind of shared code has exactly one home. Before creating a component, helper, type or constant, search its home and the app you are in for something that already does the job, then reuse or extend it. State in the PR what you searched for when you add something new.

| What | Home |
| --- | --- |
| Request and response shapes, error codes | `@ygo/contracts` |
| Field rules: phone, name, email, codes, pincode, PAN and the like | `@ygo/contracts` (`src/fields.ts`) |
| Calling the API, retries, token refresh | `@ygo/api-client` |
| Prices, fees, coupons | `@ygo/pricing` |
| Money, number, date and time display | `@ygo/format` |
| Colours, spacing, type | `@ygo/tokens` |
| A component or helper one screen uses | Beside that screen |
| A component or helper two screens of one app use | That app's `components/` or `lib/` |
| A component, hook or helper both mobile apps use | `@ygo/mobile` (ADR-0009) |

- Extract on the second use, not the first: the second copy inside one app moves to that app's `components/` or `lib/`.
- Code two apps need moves into the matching package above. A new package needs an ADR first.
- Forms check input with the `@ygo/contracts` schema the server uses, and show each field's message from the app's own strings. A rule not there yet is added there, citing where it was decided. Only `@ygo/contracts` writes zod schemas, apart from the server's Fastify glue (`src/zod.ts`) and environment check (`src/config.ts`); the gate (`ygo/no-zod`) fails a `zod` import anywhere else. It cannot see a hand-written check such as a regex in a form, so review looks for one.
- Show amounts and numbers through `@ygo/format` with no trailing zero: "₹60" not "₹60.00", "₹59.50" with paise, "10%" not "10.00%". Admin, bills and tables follow it too, with no exception. Never hand-write `toFixed(2)` or `.00` (design system section 3, #413).
- Mobile and web keep separate UI components; no UI is shared between them (ADR-0001, ADR-0007, ADR-0009).
- Add a dependency only after checking that no installed one does the job, and say why in the PR.

## The gate

`pnpm gate` runs lint, typecheck, test and build across the workspace (ADR-0007). CI runs it on every pull request and on main, and a failure blocks the merge. Before pushing, run `pnpm check`: the same tasks for only the packages your branch affects, compared with `origin/main`. On one machine both run one at a time across every worktree of the clone: a second run prints who holds the lock and waits, so leave it waiting and run them only through `pnpm check` and `pnpm gate`.

Turborepo may differ from what you remember: read `docs/` inside the installed `turbo` package (`node_modules/.pnpm/turbo@*/node_modules/turbo/docs/`) before changing `turbo.json`.

## Project docs outrank skills

`CONTEXT.md`, `docs/adr/`, `docs/product/` and `docs/design/design-system.md` win over any installed skill.

`expo-native-ui` (`.agents/skills/`) is written for generic Expo apps, and four of its rules conflict with YGo:

- Style with NativeWind classes over `@ygo/tokens` (ADR-0001), in place of its inline styles and platform semantic colours. Inline `style` is for values that change at runtime, such as animated or measured sizes.
- Use Lucide icons (`lucide-react-native`), in place of SF Symbols.
- Build one YGo design for iOS and Android from the design system, in place of separate Apple HIG and Material looks.
- Build sheets, pickers, switches and menus from React Native and NativeWind in the YGo design, in place of reaching for `@expo/ui` (native SwiftUI and Jetpack Compose) first.

It also points to other Expo skills (`expo-router`, `expo-animation`, `expo-ui`, `expo-data-fetching`) that are not installed here; follow the project docs instead.

Use it for safe areas, keyboard handling, lists, screen states and running in Expo Go.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `Hemanshujc1/YGo`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `CONTEXT.md` plus `docs/adr/`. See `docs/agents/domain.md`.

### Skills outside the repo

The repo installs only the skills in `.agents/skills/`: the ones pinned by `skills-lock.json`, plus YGo's own `merge`, which every agent follows when the owner says "merge". Others named in these docs, such as `/code-review`, are installed per user in Claude Code; an agent without them follows the written step by hand.
