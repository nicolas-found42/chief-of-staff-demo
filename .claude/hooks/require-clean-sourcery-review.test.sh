#!/usr/bin/env bash
# Test matrix for the Sourcery merge guard, for anyone changing how it decides
# what counts as a merge invocation. Not part of `pnpm run check`: it reaches
# GitHub for two fixtures, both permanent merged pull requests — #273, whose
# head commit carries a review with blocking findings, and #275, whose head
# carries a clean one.
#
# Run it as a file rather than pasting the cases into a shell command: the live
# hook inspects the command it is given, so an unquoted case would be caught in
# the act of testing it.
#
#   bash .claude/hooks/require-clean-sourcery-review.test.sh
cd "$(dirname "$0")/../.." || exit 1
g=.claude/hooks/require-clean-sourcery-review.sh
fails=0

# expected is allow | deny | bind — `bind` allows the merge and rewrites the
# command to carry --match-head-commit.
check() {
  local expected="$1" cmd="$2" label="${3:-}" payload out actual
  payload=$(printf '{"tool_name":"Bash","tool_input":{"command":%s}}' "$(jq -Rn --arg c "$cmd" '$c')")
  out=$(printf '%s' "$payload" | bash "$g")
  if [ -z "$out" ]; then
    actual="allow"
  elif printf '%s' "$out" | jq -e '.hookSpecificOutput.updatedInput.command' >/dev/null 2>&1; then
    actual="bind"
  else
    actual="deny"
  fi
  if [ "$actual" = "$expected" ]; then
    printf 'ok    %-5s  %s\n' "$actual" "${label:-$cmd}"
  else
    printf 'FAIL  got %-5s want %-5s  %s\n' "$actual" "$expected" "${label:-$cmd}"
    fails=$((fails + 1))
  fi
}

# --- carries the text of a merge without running one ---
check allow 'grep -rn "gh pr merge" docs/'
check allow 'pnpm run check'
check allow 'gh pr checks 275 --watch'
check allow 'gh pr merge --help'
check allow 'echo "run: gh pr merge 273 --squash"' 'quoted in an echo'
check allow "gh pr create --body 'first gh pr create --fill; then gh pr merge 273 --squash'" 'quoted in a PR body'
check allow 'git commit -m "docs: explain gh pr merge; and its gate"' 'quoted in a commit message'
check allow 'python3 - <<PY
s = s.replace(x, "then: gh pr merge 273 --squash")
PY' 'unquoted inside a heredoc'
check allow "python3 - <<'PY'
s = s.replace(x, \"then: gh pr merge 273 --squash\")
PY" 'a quoted heredoc tag still opens one'
check allow 'cat > doc.md <<MD
Merge it with: gh pr merge 273 --squash
MD' 'a real number inside a heredoc'

# --- a quoted heredoc opener opens nothing, so it hides nothing ---
check deny 'echo "<<EOF"
gh pr merge 273 --squash
EOF' 'a fake heredoc opener cannot hide a merge'
check deny "echo '<<PY' && gh pr merge 273 --squash" 'a fake opener beside a real merge'

# --- a merge must stand alone, so one check covers one merge ---
check deny 'git push && gh pr merge 275 --squash' 'a merge riding on another command'
check deny 'gh pr merge 275 --squash && gh pr merge 273 --squash' 'a second merge behind the first'

# --- resolving which pull request ---
check deny 'gh pr merge <n> --squash' 'an unresolvable explicit target'
check bind 'gh pr merge --squash 275' 'a target placed after its flags'
check bind 'gh pr merge -b "some body text" 275 --squash' 'a target after a quoted flag value'
check deny 'GH_TOKEN=x gh pr merge 273 --squash' 'an environment-prefixed invocation'

# --- the gate itself ---
check bind 'gh pr merge 275 --squash' 'clean review at head, bound to it'
check deny 'gh pr merge 273 --squash' 'blocking findings at head'
check deny 'gh pr merge 273 --auto --squash' '--auto'
check deny 'gh pr merge 99999 --squash' 'a target it cannot resolve fails closed'
check allow 'gh pr merge 275 --squash --match-head-commit 5c618805a1e0a3b6b0a8b9e0e7e6e4e1e0b0a0c0' 'already bound, left alone'

printf '\n%s\n' "failures: $fails"
exit "$fails"
