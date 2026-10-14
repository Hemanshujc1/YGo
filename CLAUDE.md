# YGo

Hyperlocal quick-commerce platform connecting customers with local shops within a 2–3 km radius.
`References/` holds read-only reference repos and UI inspiration. Research them, never modify them.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `Hemanshujc1/YGo`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `CONTEXT.md` plus `docs/adr/`. See `docs/agents/domain.md`.

## Writing code

- Write the minimum the ticket asks for. One caller gets inline code; handle only the errors that can actually occur.
- Keep each diff surgical: every changed line traces to the ticket and matches the surrounding style. Report unrelated problems in the PR description, and remove only what your own change made unused.
- Decide technical trade-offs yourself and state your assumptions in the PR. Ask the owner only about money, time, risk or user-visible behaviour.
- Before writing code, name the check that proves the ticket is done (a test, a typecheck, a reproduction), and finish when it passes.
