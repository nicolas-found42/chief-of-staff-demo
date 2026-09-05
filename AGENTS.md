# AGENTS.md

Local web app hosting Found42's meeting and content workflows as tabs in one
app. Pnpm monorepo: `apps/server`, `apps/web`, `packages/shared`, `tests`, `relay`.

## Agent skills

### Issue tracker

GitHub Issues on `nicolas-found42/chief-of-staff-demo` via the `gh` CLI; specs
are long-form issues, settled decisions land as ADRs. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map 1:1 to GitHub label strings (`needs-triage`,
`needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` glossary and `docs/adr/` at the root; the
workspaces are build units, not domains. See `docs/agents/domain.md`.

### Pull requests

Every change to `main` goes `branch → PR → squash merge`; a ruleset with no bypass requires a PR
and the four CI checks. See `docs/agents/pr-workflow.md`.

### Verification gates

Run the narrowest gate covering the change while working; whole-tree `pnpm run
check` before each commit; container changes add a Docker boot check. See
`docs/agents/verification.md`.
