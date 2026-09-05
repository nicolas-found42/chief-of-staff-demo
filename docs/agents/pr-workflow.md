# Pull request workflow

Substantial work goes `branch → PR → squash merge`. Small work still commits straight to `main`.
This is the outbound development workflow; triaging *inbound* PRs from outside contributors is a
separate flag in `issue-tracker.md`, currently off.

## What needs a PR

| Goes through a PR | Commits straight to `main` |
| --- | --- |
| A spec's or issue's implementation | Typo and wording fixes |
| A change touching more than one workspace | A version or dependency bump |
| Anything that lands an ADR | A one-line fix with an obvious blast radius |
| A new module, route, or migration | Regenerating a lockfile or a formatting pass |
| Anything whose review value is in the diff | Reverting a commit made minutes ago |

The test is whether the diff is worth reading as a unit later. When it is genuinely unclear, open
the PR — an unnecessary PR costs a minute, an unreviewable direct commit costs a bisect.

## Branch naming

`<type>/<slug>`, where `<type>` matches the conventional-commit prefix the work will carry:
`feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `build`. Slug is kebab-case and short.

Work that closes a tracked issue puts the number first: `feat/202-live-cutover`. That makes the
branch, the PR, and the issue greppable as one string.

Never work directly on `main` for PR-scoped work — branch before the first commit, not after.

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

Merge only when CI is green — `gh pr checks <n> --watch` blocks until it resolves. A failing check
is a fix on the branch, never a merge with an override.

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

- Any force-push or history rewrite touching `main` (an ordinary push of a small direct commit is fine)
- Merging with a failing or skipped required check
- Deleting a remote branch that is not the just-merged PR's own branch
- `gh pr close` on a PR someone else opened

This supersedes the earlier "commit to `main`, never push" default for PR-scoped work. Direct
commits to `main` for small work are still committed locally and pushed as part of normal flow.

## CI

`.github/workflows/ci.yml` runs on pull requests and on pushes to `main`: the `check` job
(typecheck, lint, format, knip), `test` with coverage, `e2e` under Playwright, and `image` for the
Docker boot. All four are the merge gate. `canary.yml` is scheduled and diagnostic — it is
deliberately **not** a merge gate.
