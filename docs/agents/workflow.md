# Working in parallel

Several coding agents and developers work on YGo at once. These rules keep their branches from colliding and their code from diverging.

## 1. One ticket, one owner, one branch

- Work starts from a GitHub issue labelled `ready-for-agent` (fully specified, an agent can finish it alone) or `ready-for-human` (needs a device, a store console, an AWS or payment account, or a judgement call).
- Claim the issue before writing code, by pushing its branch:
  1. `git fetch origin` and check `git ls-remote --heads origin '<n>-*'`. If a branch exists, the issue is taken; pick another.
  2. Create the branch from a fresh `origin/main` as `<issue-number>-<short-slug>` in its own worktree: `git worktree add ../YGo-<n> -b <n>-<slug> origin/main`.
  3. Push it at once (`git push -u origin <n>-<slug>`), then `gh issue edit <n> --add-assignee @me` so people can see it.
- Every agent uses the same GitHub account, so the pushed branch, not the assignee, shows that an issue is taken.
- Each agent works only in its own worktree. Never edit files in a folder another agent is using.
- After claiming, and before writing code, settle the ticket's assumptions and its done check with the owner (AGENTS.md, Writing code).
- Before writing code, run `scripts/overlap.sh <paths the ticket will edit>` to see which in-flight branches touch the same files.
  - Edits in separate places of one file, such as a new string or a new route line, go ahead; whoever merges second rebases. A conflicting `pnpm-lock.yaml` is rebuilt with `pnpm install` after the rebase.
  - When both branches change the same function, component or migration, raise it with the owner in the first round: wait behind a GitHub "blocked by" link, or take another ticket. Shared packages follow section 3.
- The PR body starts with `Closes #<n>` and follows `.github/pull_request_template.md`.

## 2. Slice vertically

A ticket delivers one working feature end to end: its contract, its server route and its screen. One owner for the whole slice means no hand-off and no half-built interface waiting on another branch.

## 3. Shared packages change one at a time

Each package in `packages/*` is shared by several apps, so two branches editing it at once will conflict or disagree.

- A change to a package, above all `@ygo/contracts` or `@ygo/tokens`, ships in its own small PR, merged before the feature PRs that use it.
- When two open tickets both need the same package changed, link them with a GitHub "blocked by" dependency so they run one after the other.

## 4. Size

A PR is small enough to review in one sitting: about 400 changed lines, not counting lockfiles and generated files. A ticket that will exceed that is split into child issues before work starts.

## 5. Done

- Rebase on `main` before opening the PR.
- The CI gate `pnpm gate` (lint, typecheck, test, build) is green (ADR-0007).
- The ticket's done check, named before coding, passes and is recorded in the PR.

## 6. Review

- Every PR gets a `/code-review` pass, and the author fixes or answers each finding.
- The owner approves every merge by saying "merge"; the agent then follows `.agents/skills/merge/SKILL.md`. PRs that touch `packages/*` or money code (`@ygo/pricing`, server billing and settlement) get a line-by-line human read.
