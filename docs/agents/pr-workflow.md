# Pull request workflow

Every change to `main` goes `branch → PR → squash merge`. This is the outbound development
workflow; triaging *inbound* PRs from outside contributors is a separate flag in
`issue-tracker.md`, currently off.

## Everything goes through a PR

A ruleset on `main` (no bypass actors) requires a pull request and the four CI checks — `check`,
`test`, `e2e`, `image` — and blocks force-pushes and branch deletion. There is no direct-commit
lane, deliberately: the agent works with the repo owner's own credentials, so any bypass granted
to a human is a bypass granted to the agent, and a rule that exempts everyone enforces nothing.

The cost is small because trivial changes do not have to be babysat:

```bash
git switch -c docs/fix-typo && git commit -am "docs: fix a typo" && git push -u origin HEAD
gh pr create --fill && gh pr merge --auto --squash
```

Auto-merge lands it the moment CI is green; nothing waits on you. Scale the *care* to the change,
not the mechanism — a one-liner gets `--fill` and auto-merge, a spec's implementation gets a
written body and a read-through.

## Branch naming

`<type>/<slug>`, where `<type>` matches the conventional-commit prefix the work will carry:
`feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `build`. Slug is kebab-case and short.

Work that closes a tracked issue puts the number first: `feat/202-live-cutover`. That makes the
branch, the PR, and the issue greppable as one string.

Branch before the first commit, not after. A commit made on `main` by mistake has to be moved
onto a branch before it can go anywhere, since `main` rejects direct pushes.

## Opening a PR

1. Branch from an up-to-date `main`: `git switch main && git pull && git switch -c <type>/<slug>`.
2. Commit as the work completes, same message conventions as `main`.
3. Run the whole-tree gate — `pnpm run check` — before pushing. CI runs it again, but a red PR
   wastes a round trip. See `verification.md` for the narrower gates to use while working.
4. `git push -u origin <branch>`.
5. `gh pr create --fill` for a straightforward change, or `--title`/`--body` with a heredoc when the
   body needs structure.

The body states what changed and why, and links its issue with a closing keyword — `Closes #202` —
so the merge closes the issue. A PR with no issue says so in one line; that absence is information.

## Merging

**Squash merge, always**: `gh pr merge <n> --squash --delete-branch`. One PR is one commit on
`main`, so the history stays bisectable and a revert is a single hash. The squash commit message is
the PR title plus body, so the PR title carries the conventional-commit prefix.

Merge only when CI is green. `gh pr merge --auto --squash` is usually better than watching:
it lands the PR when the checks pass and does nothing if they fail. `gh pr checks <n> --watch`
blocks until they resolve when you do want to wait. A failing check is a fix on the branch, never
a merge with an override.

Rebase onto `main` rather than merging `main` in when the branch falls behind:
`git fetch origin && git rebase origin/main`, then force-push **the feature branch only**
(`git push --force-with-lease`).

## Agent authority

Pre-authorized, no prompt needed:

- Creating branches, committing to them, and `git push` of a feature branch
- `gh pr create`, `gh pr edit`, `gh pr comment`
- `gh pr merge --squash` once CI is green
- `--force-with-lease` on a feature branch that is not `main`

Ask first, every time:

- Weakening, disabling, or adding a bypass actor to the `main` ruleset
- Merging with a failing or skipped required check
- Deleting a remote branch that is not the just-merged PR's own branch
- `gh pr close` on a PR someone else opened

This supersedes the earlier "commit to `main`, never push" default. The ruleset now enforces most
of it mechanically rather than by convention; the entries above are the parts a rule cannot cover.

## Dependabot

Dependabot PRs merge themselves. `.github/workflows/dependabot-automerge.yml` turns on auto-merge
for anything authored by `dependabot[bot]`, and the `main` ruleset lists the Dependabot app as a
bypass actor, so nothing Dependabot does is restricted.

The merge itself is still gated on the four checks, and that is a platform limit rather than a
policy choice: the workflow merges with `GITHUB_TOKEN`, so the acting party is `github-actions[bot]`,
and GitHub refuses to accept the Actions app as a bypass actor on a user-owned repository
(`Actor GitHub Actions integration must be part of the ruleset source or owner organization`).
Un-gating it would mean granting bypass to the admin role, which the agent also holds — see the
reasoning in *Agent authority*. So a green Dependabot PR lands unattended; a red one waits.

## CI

`.github/workflows/ci.yml` runs on pull requests and on pushes to `main`: the `check` job
(typecheck, lint, format, knip), `test` with coverage, `e2e` under Playwright, and `image` for the
Docker boot. All four are the merge gate. `canary.yml` is scheduled and diagnostic — it is
deliberately **not** a merge gate.
