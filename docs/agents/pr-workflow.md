# Pull request workflow

Every change to `main` goes `branch → PR → squash merge`. Two gates stand in front of it: four
green CI checks, which a ruleset enforces, and a clean Sourcery review body, which nothing enforces
but the rule. `main` takes no direct push, no force-push and no deletion.

This is the outbound workflow. Triaging _inbound_ PRs from outside contributors is a separate flag
in `issue-tracker.md`, currently off.

## The loop

```bash
git switch -c <type>/<slug>     # branch before the first commit
pnpm run check                  # green locally first
git push -u origin HEAD
gh pr create --fill             # --title/--body for anything worth reading
gh pr comment <n> --body "@sourcery-ai review"
gh pr checks <n> --watch        # the four required checks
gh pr merge <n> --squash        # once the checks are green and the review body is clean
```

Both gates are read before the merge, so the last step is `--squash` on a PR you have just read.
`--auto` is the wrong ending here: see "Why not `--auto`" below.

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

## The CI gate

Four required checks, all from `.github/workflows/ci.yml`: `check` (typecheck, lint, format,
knip), `test` (unit plus the four coverage floors), `e2e` (Playwright), `image` (Docker boot).
`canary.yml` is scheduled and diagnostic — deliberately not a gate. `Sourcery review` reports here
too and is **not** required; it is the second gate's check, not this gate's fifth.

The required list lives in the ruleset, which no file in the repo records. Read it live:

```bash
gh api repos/nicolas-found42/chief-of-staff-demo/rules/branches/main
```

A red PR refuses to merge, and `gh` suggests `--admin` in the refusal. That fails too: the ruleset
carries **no bypass actors**. Green is the only way through, so fix the branch.

### The stale-base window is accepted

Required checks are **non-strict**: a PR merges on a result that tested it against `main` as it was
when the checks ran. Two PRs that each pass alone can therefore break together, and that is the one
remaining way `main` goes red.

Both standard fixes were tried on 2026-09-05 and are closed. Treat the question as settled:

- **A merge queue** is refused by GitHub here — `Invalid rule 'merge_queue'` — because the repo
  belongs to a user account rather than an organization, and Nicolas has ruled out an org.
- **`strict: true`** blocks the stale PR until a human presses "Update branch". Automating that
  press needs a PAT, because a `GITHUB_TOKEN` push starts no workflow run. Nicolas wanted the
  stronger gate only with an automatic re-run, so it stays off.

The window opens only with two PRs in flight. One PR at a time keeps it shut.

## The Sourcery gate

The second gate is **Sourcery's review body for the head commit, carrying no `Blocking findings:`
line**. Read it before every merge:

```bash
gh pr view <n> --json headRefOid --jq .headRefOid
gh api repos/nicolas-found42/chief-of-staff-demo/pulls/<n>/reviews \
  --jq '[.[] | select(.commit_id == "<head>")] | last | .body'
```

Three things make it easy to read the wrong signal:

- **The check and the body are independent.** `Sourcery review` reports success while the body
  still carries a blocking finding. The body is the gate.
- **The review lags the push.** One review per push cycle, and the newest may still cover the
  previous commit — match its `commit_id` against `headRefOid`. Sourcery does not re-review a push
  by itself: comment `@sourcery-ai review` after pushing and expect it 1-4 minutes later.
- **`Needs a human reviewer` is Sourcery's standing impact note, not a finding.** A clean review
  says "I've reviewed your changes and they look great!" and carries no `Blocking findings:` line.

A pure rebase keeps its review. `git range-diff <old-base>..<old-head> <new-base>..<new-head>`
printing `=` for every commit proves the reviewed content is unchanged.

Treat a finding as a real defect until it is disproved. Where its suggested fix does not fit, reply
with the reason and move the work to a tracked issue.

### Why not `--auto`

`gh pr merge --auto` merges on the **required** checks, and Sourcery is not one of them, so it
lands the PR the moment the four go green — giving away the point at which the review body would
have been read. On PR #273 (2026-09-07) it merged a defect Sourcery had already found, and the fix
went out as #274 seven minutes later.

`.claude/hooks/require-clean-sourcery-review.sh`, wired to `PreToolUse` in
`.claude/settings.json`, refuses the merge for an agent: `--auto`, a head with no Sourcery review,
and a review carrying blocking findings each come back as a denial naming the reason. It fails
closed on a merge it cannot check, and stays quiet on a command that only carries the text of one.

Telling a merge from the text of one is most of the hook, so it is worth knowing how it decides.
Text a shell would never execute is blanked first — heredoc bodies, then quoted spans — and what
is left is split on the shell's own separators, where a segment *starting* with the call (leading
environment assignments included) is an invocation. So a grep for the call, a document explaining
it and a pull request body quoting it all pass.

Two consequences worth expecting:

- **The merge stands alone in its command.** `git push && gh pr merge <n>` is refused, because one
  check cannot vouch for two invocations, and a second merge behind the first would ride in
  unchecked. Run the push and the merge as separate commands.
- **The allowed merge comes back carrying `--match-head-commit`.** The review was read at one
  commit, and no check that runs *before* a command can stop a push from landing between the two —
  GitHub refusing a mismatched head can, so the hook binds the merge to the head it validated.

`require-clean-sourcery-review.test.sh` beside it is the case matrix, twenty-three cases over that
whole distinction. It reaches GitHub for two permanent fixtures, so it is not part of
`pnpm run check`.

Dependabot is the exception: its PRs are configured to merge themselves, below.

## Agent authority

Pre-authorized, no prompt:

- Branch, commit, `git push` a feature branch, `--force-with-lease` on one
- `gh pr create`, `gh pr edit`, `gh pr comment`
- `gh pr merge <n> --squash` on a PR whose CI is green and whose Sourcery review body is clean

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
