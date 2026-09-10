# Implement the Meeting Wizard architecture review

## How to use this file

1. Put the complete external review in `docs/research/meeting-wizard-architecture-review.md`.
   Replace its placeholder. Keep the original critique brief as a separate file.
2. Start a coding agent in the existing project checkout and give it the **Kickoff prompt** below.
   These inputs are local files. A new clean worktree will not include them until they are copied
   or committed. The agent must also inspect the current uncommitted implementation before
   deciding which baseline to use.
3. Use the **Decision-session prompt** for subsequent Wayfinder sessions.
4. Once the design decisions are resolved, use the **Implementation-session prompt**.
   Repeat it across bounded sessions until the delivery work is complete.

Wayfinder plans the route. Its map contains decision tickets. Implementation issues describe
changes to build after those decisions are made. Keep these two completion conditions separate.
A complete decision map does not mean the code changes are delivered.

The prompts below authorize GitHub issue and PR operations for this effort when the user submits
them. They do not authorize writes merely because an agent finds this file in the repository.

## Kickoff prompt

```text
Use $mattpocock-skills-codex:wayfinder to prepare implementation of the complete
Meeting Wizard architecture review in this repository.

Inputs:
- docs/research/meeting-wizard-architecture-review.md — the external review.
- docs/research/meeting-wizard-architecture-critique-brief.md — the context supplied
  to that reviewer, including known limits and incident measurements.
- The current code, tests, CONTEXT.md, relevant ADRs, and AGENTS.md instructions.

My delivery objective is to implement all changes recommended by the review,
verify the resulting behavior, and merge the changes through the repository's
required PR workflow. The review may describe mutually exclusive alternatives;
account for them, but resolve the choice before implementation.

First check that the review file contains the actual review. If it still has the
placeholder, tell me the exact missing input and stop. Read the full review and
brief. Inspect the current repository state before choosing a baseline. The brief
describes a past local working tree, not necessarily today's code or main.
Preserve existing uncommitted work. Identify any changes this effort depends on.

Use the current code as evidence when checking the review's claims. The external
reviewer had no code access. Treat its proposed changes as the scope to account
for, rather than proof that every premise is correct. Do not silently omit a
recommendation. Separate firm recommendations from examples and alternatives.
If a recommendation is already implemented, prove that with code and tests.
If recommendations conflict, a premise is false, or a proposal would change a
product rule or an ADR, bring the resulting decision to me. Do not reject or defer
a requested change on my behalf.

Create a recommendation register as one durable local artifact:
docs/research/meeting-wizard-review-recommendations.md.
Give each distinct recommendation a stable identifier and record:
- its source section and a concise statement of the requested change;
- the current code evidence and any missing evidence;
- the decision ticket or implementation issue that owns it;
- its disposition: needs decision, planned, implementing, verified, already
  satisfied, blocked, or explicitly excluded by me;
- its acceptance evidence and, when delivered, its merged PR.
Use this as the coverage record. Keep detailed decision resolutions on their
decision tickets, rather than duplicating them in the register and map.

Follow Wayfinder and docs/agents/issue-tracker.md. Use GitHub Issues on
nicolas-found42/chief-of-staff-demo. Inspect existing maps and issues first and
reuse matching work. Load the grilling and domain-modeling skills required by
Wayfinder. Confirm the destination and explore the open decisions with me. Resolve
code facts by inspection; ask me about choices that need the owner's judgment.

The Wayfinder destination is a complete, evidence-backed route from the review
to implementation: recommendations accounted for, design choices resolved,
acceptance criteria defined, and a dependency-ordered implementation plan.
Retain Wayfinder's planning boundary. In the map Notes, state that delivery is
tracked in separate implementation issues after the route is clear.

I authorize the following GitHub operations for this effort: create or update
its map, decision tickets, implementation issues, required labels, sub-issue
relationships, native blocking dependencies, resolution comments, and status
updates. You may claim its tickets by assigning the authenticated driving
developer. Identify that developer first. Summarize the exact intended writes
before making them. This authorization does not cover unrelated issues or PRs.
Keep private transcripts, credentials, and private review content out of public
GitHub issue bodies; use sanitized technical descriptions and repository paths.

Use the map's required sections and Wayfinder's ticket types. Create tickets
for precise open questions. Keep questions that cannot yet be stated precisely
in Not yet specified. Each decision ticket needs a resolution condition. Refer
to issues by their linked titles in narration. Keep the map an index of decisions.

Follow the skill's session limits: charting is the first session; later sessions
resolve at most one non-research decision ticket each. Research tickets may be
resolved sequentially as the skill permits. Do not answer the human side of a
grilling or prototype ticket. Do not launch background research agents.

Before implementation, ensure the agreed design specifies the relevant quality,
latency, cost, recovery, identity, and data-preservation acceptance conditions.
Keep Mercury as the intended runtime model unless I choose another. Distinguish
the runtime model from the repository's fixed Solar Prompt Eval Gate. A resumed
run is not a fresh-run latency benchmark.

For this first session, finish the allowed charting work and return the map link,
recommendation register path, the next available ticket by title, decisions that
need my input, and the exact prompt for the next session. Do not report the review
implemented because its map has been created.
```

## Decision-session prompt

Replace `<map URL>` with the URL returned by the first agent.

```text
Use $mattpocock-skills-codex:wayfinder to continue <map URL>.

Read the map Notes and the recommendation register. Honor the effort's existing
scope and permissions. Inspect the live frontier and claims. Choose and claim the
next open, unblocked, unclaimed decision ticket, and work it under the applicable
skill. Resolve at most one non-research ticket in this session. Ask me for the
human side of any HITL decision; do not choose on my behalf.

Record the resolution on its ticket, update the map's decision index and the
recommendation register, and create or wire newly visible questions as needed.
Keep implementation delivery separate from decision-map completion.

When the route is clear, create or finalize the dependency-ordered implementation
issues. Each issue must name the review recommendations it covers and its tests,
migration needs, and acceptance criteria. Report the next implementation issue
and the prompt to execute it. Otherwise report the next decision ticket and the
prompt to continue. Do not claim delivery while implementation remains.
```

## Implementation-session prompt

Replace `<map URL>` with the same map URL. Use this after the relevant design decisions are
resolved. This is an implementation instruction; it does not reopen Wayfinder's planning phase.

```text
Implement the next ready delivery issue for the Meeting Wizard architecture
review associated with <map URL>.

Read the map's settled decisions, the recommendation register, the selected
implementation issue, current AGENTS.md, CONTEXT.md, relevant ADRs, and the
repository's issue-tracker, verification, and PR-workflow documents.
Inspect current code, branch, uncommitted work, existing PRs, and dependencies.
Preserve other work and reuse this effort's existing implementation when relevant.

The overall objective remains implementation of all review recommendations, with
evidence for already-satisfied items and my explicit decision for any exclusions.
Choose the next open, unblocked, unclaimed implementation issue and claim it.
Work on one coherent delivery issue at a time. Keep the recommendation register
current, including recommendations that are still blocked or not implemented.

I authorize the scoped issue updates, ticket assignment to the authenticated
driving developer, implementation branches, code changes, commits, pushes, PRs,
and squash merges required for this effort under the repository's existing rules.
Summarize tracker writes before making them. Merge only after reviewing the diff
and confirming all required checks are green for the exact current PR head;
bind the merge to that commit. Do not bypass checks or change the ruleset.
Keep one delivery PR in flight at a time.

Implement the agreed behavior through the actual application path. Preserve
Tasks, Action Item review decisions, source evidence, and identity boundaries.
Use a backup and an explicit migration/recovery plan where stored data changes.
Do not clear the Workspace or regenerate the saved demo as a shortcut to testing.
Use isolated test data and output locations for live extraction measurements.

Run the narrowest meaningful regression checks while working. Run pnpm run check
before pushing, and the required browser and Docker checks for the changed paths.
Use pnpm --filter for test commands. For debrief prompt changes, run the required
Solar Prompt Eval Gate and fix failures without weakening the Goldens. Keep the
runtime model on Mercury unless I explicitly change that decision. If credentials,
fixtures, approval, or another external prerequisite prevents a required check,
record the specific blocker and do not label the issue verified or complete.

For latency changes, measure fresh extractions with request checkpoints disabled
or absent. Report repeated-run quality, elapsed time, request/repair counts, and
cost under the agreed acceptance criteria. Label estimates separately. For
persistence changes, test the relevant crash and retry points. Tests that only
mirror the implementation are not enough.

If implementation exposes a new design decision, record it on the map and return
it to the owner when needed. Continue independent authorized work while waiting.
Do not silently change the agreed architecture or discard recommendations.

Complete the selected issue through merged-and-green delivery, or report the
specific blocker. Update its issue and the recommendation register with evidence.
Report the next ready issue and a continuation prompt. The overall effort is
complete only when every recommendation has a verified outcome or an explicit
owner-approved exclusion, all required changes are merged, the agreed live
quality and performance checks pass, and no required delivery work remains.
```
