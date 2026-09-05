---
name: handoff
description: "Triage open issues for acceptance criteria that no test claims."
disable-model-invocation: true
---

Audit this repo's open issues for one thing: **which acceptance criteria no test claims.**

This is triage, not verification. A claimed criterion is not a correct one. You are sorting the
backlog so that a later, expensive per-criterion review knows where to look — and so that an issue
whose criteria nothing even asserts stops being counted as delivered.

## Evidence is a test

The rule this pass exists to enforce.

A commit message is not evidence. `git log --grep="#N"` finds commits that *mention* an issue, and
a mention is as often a record of the issue being broken as of it being met. Run on this repo, that
check produced these:

| Issue | What the matched commit actually says |
| --- | --- |
| #117 | `Refs #125, #117` — a cross-reference carried on a different issue's commit |
| #209 | describes behaviour "which #209 **forbids**" |
| #172 | describes a bug: "Tasks became canonical Workspace state in #172" and the boundary never followed |

Score a commit as evidence and you will mark violated criteria as done. Read tests.

The same goes for an issue's own checked boxes, a `feat:` subject naming the issue, and a closed
blocker. Each says work happened. None says a criterion is asserted anywhere.

## Scope

Every open issue whose body carries an `## Acceptance criteria` section:

```bash
gh issue list --state open --limit 100 --json number,title,body \
  -q '.[] | select(.body | test("Acceptance criteria")) | "\(.number)\t\(.title)"'
```

## Steps

1. **List the scope** with the command above. Write the issue numbers down before you start; the
   pass is over every one of them.

2. **Extract each criterion verbatim** — `gh issue view <n> --json body -q .body`. One row per
   checkbox. Keep the issue's wording rather than your paraphrase, so the report can be re-checked
   against the ticket.

3. **Hunt for the test that claims it.** Tests live in `tests/src/**` (vitest, by module) and
   `tests/e2e/**` (Playwright journeys). Search on the criterion's own nouns and verbs — the repo
   names tests in domain language, so a criterion about retrying a Task link is findable from
   `retry` and `link`. Read the test body, not only its name: a name can promise what its
   assertions do not check.

4. **Give every criterion one verdict.**
   - `claimed` — a test names this criterion's behaviour and asserts it. Record `path:line`.
   - `partial` — a test touches the behaviour but asserts less than the criterion demands (the
     happy path only; the state but not the transition). Record what it leaves unasserted.
   - `unclaimed` — no test asserts this. This is the finding the pass exists to produce.

5. **Write the report** to `docs/research/issue-ac-coverage.md`: a table per issue, then a summary
   listing every issue holding at least one `unclaimed` criterion, ordered by how many.

## Completion

Every issue in the step-1 list has a verdict for every one of its criteria, each `claimed` or
`partial` verdict carrying a `path:line`. An issue you could not reach a verdict on is its own
row, with the reason.

Sampling does not finish this pass. Partial coverage of the backlog reproduces the guesswork it
replaces.

## Leave the repo as you found it

Report only. The tracker keeps its labels and its open issues, the code keeps its behaviour, and no
test is added to close a gap you find — an `unclaimed` criterion is the deliverable, not a defect
to fix on the way past. Raise anything you believe is genuinely broken in the report, and let the
human choose.
