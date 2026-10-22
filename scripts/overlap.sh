#!/usr/bin/env bash
# Lists the files each in-flight branch changes against origin/main, so a ticket
# can see who else is editing the same code (docs/agents/workflow.md). In flight:
# pushed, not main, not yours, and with no closed or merged pull request.
# With paths as arguments, shows only the branches that touch them.
#   scripts/overlap.sh [path…]
set -euo pipefail

git fetch --quiet --prune origin
finished=$(gh pr list --state closed --limit 1000 --json headRefName --jq '.[].headRefName')
mine=$(git branch --show-current)

git for-each-ref --format='%(refname:short)' refs/remotes/origin | while read -r ref; do
  branch=${ref#origin/}
  case $branch in main | HEAD | origin | "$mine") continue ;; esac
  grep -xF "$branch" <<<"$finished" >/dev/null && continue
  files=$(git diff --name-only "origin/main...$ref")
  if (($#)); then
    files=$(grep -F "${@/#/-e}" <<<"$files" || true)
    [[ -z $files ]] && continue
  fi
  echo "$branch"
  [[ -n $files ]] || files="(claimed, nothing pushed yet)"
  while read -r line; do echo "  $line"; done <<<"$files"
done
