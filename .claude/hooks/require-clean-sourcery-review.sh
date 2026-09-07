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
# only carries the text of one. `require-clean-sourcery-review.test.sh` beside
# it is the case matrix for that distinction.
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

# The text a shell would never execute, blanked: heredoc bodies, then quoted
# spans. A substring test over the raw command answers the wrong question — it
# refuses the grep that searches for the call, the document that explains it and
# the pull request body that quotes it, none of which run anything.
executable_text() {
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
    tr ';|&\n' '\n\n\n\n'
}

# A segment that *starts* with the call is an invocation. Leading environment
# assignments belong to it: `GH_TOKEN=x gh pr merge 1` merges just as surely.
INVOCATION='^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*gh[[:space:]]+pr[[:space:]]+merge([[:space:]]|$)'

command=$(cat | jq -r '.tool_input.command // ""' 2>/dev/null)
executable=$(executable_text "$command")
invocations=$(printf '%s\n' "$executable" | grep -cE "$INVOCATION")
[[ "$invocations" -gt 0 ]] || exit 0

# One merge, alone in its command. Anything else — a second merge behind the
# first, or a merge riding on the back of another command — would leave this
# guard validating one invocation while the shell ran two.
segments=$(printf '%s\n' "$executable" | grep -c '[^[:space:]]')
if [[ "$invocations" -gt 1 || "$segments" -gt 1 ]]; then
  deny "Run the merge as its own command so its Sourcery review can be checked against it. This command carries ${invocations} merge invocation(s) among ${segments} commands."
fi

merge_call=$(printf '%s\n' "$command" | tr '\n' ' ')

if [[ "$merge_call" == *--help* ]]; then exit 0; fi

# Which pull request. Every non-flag word after `merge` is a candidate, and the
# first that GitHub resolves is the target: reading gh's whole flag grammar to
# find it would be a second implementation of gh, and a flag's quoted value is
# never a pull request anyway. An explicit candidate that resolves to nothing
# is refused rather than quietly replaced by the current branch's own PR.
after_merge=${merge_call#*pr }
after_merge=${after_merge#*merge}
candidates=()
for word in $after_merge; do
  [[ "$word" == -* ]] && continue
  candidates+=("$word")
  [[ "${#candidates[@]}" -ge 4 ]] && break
done

number=""
for candidate in "${candidates[@]:-}"; do
  [[ -n "$candidate" ]] || continue
  number=$(gh pr view "$candidate" --json number --jq .number 2>/dev/null)
  [[ -n "$number" ]] && break
done

if [[ -z "$number" ]]; then
  if [[ "${#candidates[@]}" -gt 0 && -n "${candidates[0]:-}" ]]; then
    deny "Could not resolve '${candidates[0]}' to a pull request, so its Sourcery review could not be checked."
  fi
  # No target named at all: gh would merge the current branch's pull request.
  number=$(gh pr view --json number --jq .number 2>/dev/null)
  [[ -n "$number" ]] || exit 0
fi

if [[ "$merge_call" == *--auto* ]]; then
  deny "--auto merges on the four required checks, and Sourcery is not one of them, so it lands the PR before its review body can be read. Read both gates, then merge with: gh pr merge <n> --squash"
fi

head=$(gh pr view "$number" --json headRefOid --jq .headRefOid 2>/dev/null)
[[ -n "$head" ]] || deny "Could not read the head commit of PR #${number}, so its Sourcery review could not be checked."

# The newest Sourcery review for this head, wherever it sits in a review history
# long enough to paginate. The selection stays inside jq. A review body runs to many lines, so picking
# the newest one with a line-wise `tail` reads the last line of the last body
# instead of the last body — which drops the `Blocking findings:` line and lets
# a blocking review pass as clean. `--slurp` cannot combine with `--jq`, hence
# the pipe.
body=$(gh api --paginate --slurp "repos/{owner}/{repo}/pulls/${number}/reviews" 2>/dev/null |
  jq -r "[.[][] | select(.user.login == \"sourcery-ai[bot]\" and .commit_id == \"${head}\")] | last | .body // \"\"" 2>/dev/null)

if [[ -z "$body" ]]; then
  deny "No Sourcery review covers PR #${number} at its head commit ${head:0:7}. Sourcery does not re-review a push on its own: request one with a PR comment of @sourcery-ai review, wait 1-4 minutes, then read the body before merging."
fi

if [[ "$body" == *"Blocking findings:"* ]]; then
  deny "Sourcery's review of PR #${number} at ${head:0:7} carries blocking findings, so this merge is refused. Read the body, address each finding, push, and request a fresh review. See docs/agents/pr-workflow.md."
fi

# The review was read at this head; bind the merge to it. A push landing between
# this check and the merge would otherwise land an unreviewed commit, and no
# check run before a command can close that window on its own — GitHub refusing
# a mismatched head can.
if [[ "$merge_call" != *--match-head-commit* ]]; then
  jq -n --arg command "${command} --match-head-commit ${head}" --arg head "${head:0:7}" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { command: $command }
    },
    systemMessage: ("Bound the merge to the reviewed head " + $head + " with --match-head-commit.")
  }'
fi

exit 0
