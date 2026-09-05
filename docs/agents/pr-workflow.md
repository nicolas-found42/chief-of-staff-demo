# Pull request workflow

Every change to `main` goes `branch → PR → squash merge`. A ruleset enforces it: `main` takes no
direct push, no force-push, no deletion, and no merge until four CI checks are **green**.

This is the outbound workflow. Triaging _inbound_ PRs from outside contributors is a separate flag
in `issue-tracker.md`, currently off.

## The loop

```bash
git switch -c <type>/<slug>     # branch before the first commit
pnpm run check                  # green locally first
git push -u origin HEAD
gh pr create --fill             # --title/--body for anything worth reading
gh pr merge --auto --squash     # lands itself when the gate goes green
```

`--auto` is the normal ending: it merges when the gate passes and does nothing when it fails, so no
step blocks on a watch. Use `gh pr checks <n> --watch` when you need the result in-session.

Done means **merged and green**. A PR left open is unfinished work; say so rather than reporting
the task complete.

`verification.md` has the narrower gates to run while working, before `pnpm run check` is worth it.

## Naming

`<type>/<slug>`, where `<type>` is the conventional-commit prefix the squash commit will carry:
`feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `build`. Issue number first when there is one —
`feat/202-live-cutover` — so the branch, the PR, and the issue share one greppable string.

The squash commit takes the **PR title**, so the title carries the prefix and the body becomes the
commit body. Close the issue from the body with `Closes #202`.

A branch that falls behind rebases, never merges `main` in: `git fetch origin && git rebase origin/main`,
then `git push --force-with-lease` on the feature branch.

## The gate

Four required checks, all from `.github/workflows/ci.yml`: `check` (typecheck, lint, format,
knip), `test` (unit plus the four coverage floors), `e2e` (Playwright), `image` (Docker boot).
`canary.yml` is scheduled and diagnostic — deliberately not a gate.

The required list lives in the ruleset, which no file in the repo records. Read it live:

```bash
gh api repos/nicolas-found42/chief-of-staff-demo/rules/branches/main
```

A red PR refuses to merge:

```
X ... is not mergeable: the base branch policy prohibits the merge.
To use administrator privileges to immediately merge the pull request, add the `--admin` flag.
```

`gh` advertises `--admin` there, but the ruleset carries **no bypass actors**, so it fails too. The
only way past a red check is a green one. Fix the branch.

### The stale-base window is accepted

Required checks are **non-strict**: a PR merges on a result that tested it against `main` as it was
when the checks ran. Two PRs that each pass alone can therefore break together, and that is the one
remaining way `main` goes red.

This is a decision, not an oversight. Do not re-propose the two standard fixes:

- **A merge queue** is unavailable. GitHub refuses the `merge_queue` ruleset rule on this repo —
  `Invalid rule 'merge_queue'` — because the owner is a user account, not an organization, and
  Nicolas has ruled out moving to an org.
- **`strict: true`** blocks the stale PR and waits for a human to press "Update branch"; automating
  that press needs a PAT, because a `GITHUB_TOKEN` push does not start a new workflow run. Nicolas
  asked for the stronger gate only if the re-run were automatic, so it stays off.

The window only matters with two PRs open at once. Work one PR at a time and it never opens.

## Agent authority

Pre-authorized, no prompt:

- Branch, commit, `git push` a feature branch, `--force-with-lease` on one
- `gh pr create`, `gh pr edit`, `gh pr comment`
- `gh pr merge --auto --squash`, and `--squash` on a green PR

Ask first, every time:

- Changing the ruleset: bypass actors, required checks, enforcement
- `gh pr close` on a PR someone else opened
- Deleting a remote branch other than the just-merged PR's own

Bypasses were tried and removed. An admin-role bypass looks like a safety valve for the human, but
the agent authenticates as `nicolas-found42` — `gh auth status` confirms it — so GitHub cannot tell
the two apart, and the valve opens for both. The empty bypass list is the whole point: the gate
holds against everyone, so no one has to remember when it does not.

## Dependabot

Dependabot PRs merge themselves. `.github/workflows/dependabot-automerge.yml` enables auto-merge
for `dependabot[bot]`, so a green one lands unattended. It passes the same gate as everything else.

A red one waits. Report it to Nicolas with the failing check named; merging it is his call, per PR.
The config groups updates weekly on Monday and does not exclude majors, so a red Dependabot PR is
usually a breaking major rather than a flake — read the failure before assuming a retry helps.
