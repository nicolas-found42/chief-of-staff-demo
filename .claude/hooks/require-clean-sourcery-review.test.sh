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

check() {
  local expected="$1" cmd="$2" label="${3:-}" payload out actual
  payload=$(printf '{"tool_name":"Bash","tool_input":{"command":%s}}' "$(jq -Rn --arg c "$cmd" '$c')")
  out=$(printf '%s' "$payload" | bash "$g")
  if [ -z "$out" ]; then actual="allow"; else actual="deny"; fi
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
s = s.replace(x, "then: git push && gh pr merge <n> --squash")
PY' 'unquoted inside a heredoc'
check allow 'cat > doc.md <<MD
Merge it with: gh pr merge 273 --squash
MD' 'a real number inside a heredoc'
check allow 'gh pr merge <n> --squash' 'a placeholder resolves to no PR'

# --- the merge the gate exists for ---
check allow 'gh pr merge 275 --squash' 'clean review at head'
check deny  'gh pr merge 273 --squash' 'blocking findings at head'
check deny  'gh pr merge 273 --auto --squash' '--auto'
check deny  'git push && gh pr merge 273 --squash' 'real compound invocation'
check deny  'gh pr create --fill; gh pr merge 273 --squash' 'real sequenced invocation'
check deny  'gh pr merge 99999 --squash' 'a resolved PR it cannot read fails closed'

printf '\n%s\n' "failures: $fails"
exit "$fails"
