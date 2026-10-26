---
name: merge
description: Merge a YGo pull request and tidy up after it. Use when the owner says "merge", with or without a PR number.
---

# Merge

The owner saying "merge" is their approval for that PR. Work through the steps in order; each ends on its done check. Stop and report to the owner whenever a step says so, and leave the PR open.

## 1. Pick the PR

- A number given: that PR.
- No number: the open PR whose branch is checked out in the current worktree (`gh pr view --json number,title,headRefName`).
- No PR from the current worktree: `gh pr list`. One open PR: that one. Several: ask which.

Done when you hold one PR number.

## 2. Rebase only on a conflict

`gh pr view <n> --json mergeable --jq .mergeable`:

- `MERGEABLE`: go to step 3. A branch behind main merges as it is; the run on main checks the combination.
- `UNKNOWN`: GitHub is still working it out; ask again after a few seconds.
- `CONFLICTING`: rebase in the worktree holding the PR's branch (`git worktree list`):
  1. `git fetch origin && git rebase origin/main`. A conflicting `pnpm-lock.yaml` is rebuilt with `pnpm install`. A conflict in code you cannot settle with certainty: `git rebase --abort`, stop, and name the files to the owner.
  2. `git push --force-with-lease`.

A conflicting PR from the second developer, or one with no worktree on this machine: ask its author to rebase rather than rewriting their branch.

Done when the PR reports `MERGEABLE`.

## 3. Wait for green checks

`gh pr checks <n> --watch --fail-fast`.

A red check: read it with `gh run view <run-id> --log-failed`, stop, and tell the owner which test failed and why. A check that fails on code the PR never touched is a flaky test: say so, and rerun only that job once with `gh run rerun <run-id> --failed`. If it fails again, open one issue for that test.

Done when every check is green.

## 4. Merge

`gh pr merge <n> --squash`. Leave out `--delete-branch`: GitHub already deletes the remote branch on merge, and the flag would switch branches inside a worktree.

Done when `gh pr view <n> --json state --jq .state` prints `MERGED`.

## 5. Keep or remove the worktree

Keep the worktree when any of these holds, and tell the owner which:

- Another open issue continues in it: the next child of the same parent, or follow-up work the owner or the issue names.
- It holds work not in the PR: `git status --short` shows changes, or `git log <PR head SHA>..HEAD` shows commits.

To reuse a kept worktree for its next issue, start that issue's branch inside it from a fresh `origin/main` (`git switch -c <m>-<slug> origin/main`) and push it to claim the issue.

Otherwise remove it from the main folder (the first row of `git worktree list`):

```
git worktree remove ../YGo-<n>
git branch -D <branch>
```

`-D` because a squash merge leaves the branch looking unmerged.

Done when `git worktree list` and `git branch` show the merged branch only where you chose to keep it.

## 6. Update the main folder

In the main folder: `git pull --ff-only`, then `git fetch --prune`.

Done when `git status` reports main up to date with `origin/main`.

## 7. Record progress on GitHub

GitHub is where every agent, Codex included, reads progress.

1. Find the issue the PR closed: `gh pr view <n> --json closingIssuesReferences --jq '.closingIssuesReferences[].number'`.
2. Find its parent: `gh api repos/{owner}/{repo}/issues/<issue>/parent --jq .number` (a 404 means none).
3. With a parent, list its children: `gh api repos/{owner}/{repo}/issues/<parent>/sub_issues --jq '.[] | "\(.number) \(.state) \(.title)"'`. Comment on the parent:

   ```
   #<issue> merged in #<n> (<short SHA>). Remaining: #a, #b. Next: #a.
   ```

   When every child is closed, close the parent with a comment saying the last child merged.

An agent with its own memory, such as Claude Code, also updates its handoff note.

4. When the PR body has a "Screen check" line, add it to the open `Screen check: batch <N>` issue, and mark the batch ready when it is full, as `docs/agents/workflow.md` section 7 says.

Done when the parent's comment is posted (or the closed issue has no parent), and any screen line sits in a batch.

## 8. Report

Tell the owner in a few lines:

- What merged, with its commit SHA.
- "Batch ready" with the batch link, when this merge filled one.
- Each worktree kept, and why.
- Still open: `gh pr list` and `git worktree list`.
- The next issue: the next open child of the parent, else the oldest `ready-for-agent` issue nobody has claimed (`git ls-remote --heads origin '<n>-*'` is empty).

Wait for the owner before starting the next issue.
