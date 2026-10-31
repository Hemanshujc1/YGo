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

## 3. Shared packages

Each package in `packages/*` is shared by several apps, so two branches editing it at once will conflict or disagree.

- A change to a package ships inside the feature PR that needs it.
- When another open branch edits the same package file (`scripts/overlap.sh` shows it), link the two tickets with a GitHub "blocked by" dependency so they run one after the other.

## 4. Size

A PR stays at about 1,000 changed lines or fewer, not counting lockfiles and generated files. A ticket that will exceed that is split into child issues before work starts.

## 5. Done

- While building, run only the tests of the files you change (`pnpm --filter <package> exec vitest run <file>`). Run the full `pnpm check` once, after the review in section 6.
- Rebase on `main` before opening the PR.
- The CI gate `pnpm gate` (lint, typecheck, test, build) is green (ADR-0007).
- The ticket's done check, named before coding, passes and is recorded in the PR.

## 6. Review

- Every PR gets a `/code-review` pass, and the author fixes or answers each finding. Run it on the local changes when the work is done, before `pnpm check` and the first push, so the one check and the one CI run cover the review fixes too; push again only for what CI or the owner raises. List the findings and answers in the PR.
- The owner approves every merge by saying "merge"; the agent then follows `.agents/skills/merge/SKILL.md`. PRs that touch `packages/*` or money code (`@ygo/pricing`, server billing and settlement) get a line-by-line human read.

## 7. Screen checks

The owner checks new and changed screens, phone and admin website alike, in batches after they merge. A screen PR merges on its green gate without waiting for that check.

- A screen PR's body carries its batch line under "Screen check": `- [ ] <app>, <screen>: <what to tap>; expect <what to see> (#<PR>)`.
- A batch is one GitHub issue titled `Screen check: batch <N>`, labelled `ready-for-human`. After merging a screen PR, the merger adds its line to the open batch, or opens the next batch when none is open.
- A batch is ready at 4 screens, or at 3 when no other screen PR is open. The merger then adds "(ready)" to its title and tells the owner "batch ready" with its link. A ready batch takes no more lines; later screens start the next batch.
- The owner runs the batch from the latest `main`, phone screens on the OPPO, and says which lines pass. The agent running the check (the `screen-check` skill) ticks each line the owner passed; it never ticks one on its own. For each failed line, an agent opens a fix issue and links it on that line; the fix PR's own line goes into a later batch.
- When every line is ticked or links its fix issue, that agent closes the batch.
