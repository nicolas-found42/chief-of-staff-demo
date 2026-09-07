#!/usr/bin/env bash
# PreToolUse guard for `gh pr merge`.
#
# The Sourcery review body for the PR's head commit is the second merge gate
# (docs/agents/pr-workflow.md). GitHub's ruleset does not enforce it — the
# `Sourcery review` check is not required, so `--auto` lands a PR the moment
# the four CI checks pass, which is how PR #273 merged a defect Sourcery had
# already found. This refuses the merge until that body is read and clean.
#
# Fails closed on a merge it cannot check, and stays quiet on a command that
# only carries the text of one. `require-clean-sourcery-review.test.sh` is the
# case matrix for that distinction.
set -uo pipefail

deny() {
  jq -n --arg reason "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

# Does this command *invoke* a merge, or merely carry the text of one? A
# substring test answers the wrong question, refusing the grep that searches for
# the call, the document that explains it and the pull request body that quotes
# it — none of which run anything.
#
# So the text a shell would never execute is blanked first: heredoc bodies, and
# quoted spans. What survives is split on the shell's own separators, and a
# segment that *starts* with the call is an invocation.
merge_invocation() {
  printf '%s' "$1" |
    awk '
      function unquoted(line,   out, quote, i, c) {
        out = ""; quote = ""
        for (i = 1; i <= length(line); i++) {
          c = substr(line, i, 1)
          if (quote == "") {
            if (c == "\047" || c == "\"") { quote = c; out = out " " } else { out = out c }
          } else if (c == quote) { quote = "" }
        }
        return out
      }
      BEGIN { tag = "" }
      {
        if (tag != "") {
          trimmed = $0
          gsub(/^[[:space:]]+|[[:space:]]+$/, "", trimmed)
          if (trimmed == tag) tag = ""
          print ""
          next
        }
        if (match($0, "<<-?[[:space:]]*[\"\047]?[A-Za-z_][A-Za-z0-9_]*[\"\047]?")) {
          tag = substr($0, RSTART, RLENGTH)
          sub("^<<-?[[:space:]]*", "", tag)
          gsub("[\"\047]", "", tag)
        }
        print unquoted($0)
      }
    ' |
    tr ';|&\n' '\n\n\n\n' |
    grep -E '^[[:space:]]*gh[[:space:]]+pr[[:space:]]+merge([[:space:]]|$)' |
    head -1
}

command=$(cat | jq -r '.tool_input.command // ""' 2>/dev/null)
merge_call=$(merge_invocation "$command")
[[ -n "$merge_call" ]] || exit 0
[[ "$merge_call" == *--help* ]] && exit 0

# Which pull request. A real invocation either names one or runs on a branch
# that has one; when neither resolves, `gh` itself has nothing to merge, so this
# is prose rather than a merge and the gate has no business refusing it.
number=$(printf '%s' "$merge_call" | sed -n 's/.*pr[[:space:]]\{1,\}merge[[:space:]]\{1,\}\([0-9]\{1,\}\).*/\1/p')
if [[ -z "$number" ]]; then
  number=$(gh pr view --json number --jq .number 2>/dev/null)
fi
[[ -n "$number" ]] || exit 0

if [[ "$merge_call" == *--auto* ]]; then
  deny "--auto merges on the four required checks, and Sourcery is not one of them, so it lands the PR before its review body can be read. Read both gates, then merge with: gh pr merge <n> --squash"
fi

head=$(gh pr view "$number" --json headRefOid --jq .headRefOid 2>/dev/null)
[[ -n "$head" ]] || deny "Could not read the head commit of PR #${number}, so its Sourcery review could not be checked."

body=$(gh api "repos/{owner}/{repo}/pulls/${number}/reviews" \
  --jq "[.[] | select(.user.login == \"sourcery-ai[bot]\" and .commit_id == \"${head}\")] | last | .body // \"\"" 2>/dev/null)

if [[ -z "$body" ]]; then
  deny "No Sourcery review covers PR #${number} at its head commit ${head:0:7}. Sourcery does not re-review a push on its own: request one with a PR comment of @sourcery-ai review, wait 1-4 minutes, then read the body before merging."
fi

if [[ "$body" == *"Blocking findings:"* ]]; then
  deny "Sourcery's review of PR #${number} at ${head:0:7} carries blocking findings, so this merge is refused. Read the body, address each finding, push, and request a fresh review. See docs/agents/pr-workflow.md."
fi

exit 0
