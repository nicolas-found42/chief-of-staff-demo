# Meeting Wizard review recommendation register

Wayfinder map: [Meeting Wizard review: evidence-backed route to verified delivery](https://github.com/nicolas-found42/chief-of-staff-demo/issues/338).

This is the canonical local coverage record, created 2026-09-10 during kickoff. Detailed decisions belong only in their decision-ticket resolution comments. Map creation is not delivery. Stable IDs must never be renumbered; split future detail with suffixes and retain the original coverage relationship.

## Current live continuation — resumed 2026-09-10 at 1864ea4

This entry supersedes the operational status in every historical section below.

**Merged since the last entry.** #354 landed as [PR #368](https://github.com/nicolas-found42/chief-of-staff-demo/pull/368),
squash-merged at `1864ea40fb14cf7b0e5fa655b08fac600c288c2c` with `check`, `test`, `e2e` and `image`
green for the exact head `b568f83d39a0b105b560f6e82d95ca2728ac723c`. #353 had already landed as
PR #367 at `0aa656801ba7d789e6b267e5b62ee3c55fd215b3`. Both issues are closed.

A resumed review of #368 before merge found one more instance of the defect class ADR-0086 already
names: the canonical Task bundle refused malformed version metadata, but the generic
expected-generation guard still read a non-integer `generation` as `0`, so a caller holding the
first generation could overwrite a damaged record whose position it never saw. A red regression
reproduced the overwrite before the fix. Whole-tree gate at that head: 2,630 tests in 228 files.

**Sourcery is no longer installed on this repository.** It produced no review on #366, #367 or #368,
there is no configuration for it, and CodeRabbit — which is installed — reports
`Review skipped: manual review required for this OSS repository`. The merge gate in practice is the
four required checks plus reading the diff, as `docs/agents/pr-workflow.md` states.

**#355 is merged** as PR #369 at `3b7e2ce421eb91fc0b1d94f7f15ead3d06024fda`, exact head `eb004885a4b7e4220e203d0f5b35be79174316ae`, four checks green. It was built, built on the identity implementation
inherited uncommitted in the primary checkout. Three defects in that inherited draft were found and
fixed with reproducing regressions: the checked handoff was dropped on materialization, silently
disabling the automatic-promotion guards that read it; the occurrence locator fell back to the array
index, so reordering the model's output renamed the obligation; and the materialization index was
committed as a second file, so the crash after the records reached the Workspace lost it and the
replay proposed every obligation again. The index is now derived from the records.

The owner's review commands — select, correct, reconcile, suggest and resolve an amendment — had no
HTTP surface at all and now have one, each binding the record version it was decided against. The
review surface no longer offers a Create Task the server would refuse.

**The inherited working tree also carried damage, now reverted.** `docs/research/meeting-wizard-architecture-review.md`
had its H1 title deleted and trailing whitespace added to 18 lines; ignoring whitespace the only
change was the deleted title. It is restored to the committed content, sha256
`8af147bdf5cdb99269bcf7471325d11ac956f5cea07f29e13e301f4ef8efe015`. `apps/server/src/composition/shell.ts`
had four comment blocks reindented; restored.

**Real preservation evidence for the #355 stored-format change.** The live Workspace bundle is
format 1 with 64 Action Items, 0 Tasks and 0 Task Lists. An isolated copy of all 664 files was read
twice with this build offline: the two reads were identical, nothing was written, all 64 ids
survived in order, and states, decisions, proposals and the cutover receipt were preserved; every
record imported honestly as `legacy-import`. Result in private `session-355/isolated-recovery.json`.
**Its denominators are zero for promoted, dismissed, Trashed and deleted records**, so those
histories rest on synthetic cases, not on this snapshot. The `workspace-baseline-4` capture is two
files stale — `meeting-brief-calendar.json` and `meetings/meetings.json`, both written by the
running app, neither a Task record.

**Merging #355 does not activate format 3.** The running container is unchanged at image
`sha256:c34dfd19aaa59b05dd1b0021d6463f18cc3c1acf7f8789ceee882915f7aad584` and was never rebuilt with
#354 or #355. A fresh quiesced capture is required immediately before the deploy that activates the
format; it is a deployment step and is not claimed here.

All 64 stable IDs retain their primary owners. #356–365 remain open with their complete acceptance
requirements in scope. No live inference, no external message delivery and no semantic-quality or
final-release claim is made by this entry.


## Active execution delegation — 2026-09-10

[Execution authority](https://github.com/nicolas-found42/chief-of-staff-demo/issues/338#issuecomment-5624501698)
supersedes every historical planning-only, interview, one-ticket and wait-for-answers instruction
below. All 64 IDs remain in scope. Implement in the current agent without grilling or subagents;
resolve routine specifications and rollout choices from evidence. The required outcome is verified,
merged delivery, not a closed map. Spending, source/route prerequisites and human evidence remain
unchanged. Starting fixed point: `bd80b089f401b4b1ea7486848742963022140385`.

Artifact specification #345 is resolved: every current required section remains required, including
coaching. Prepare the checked core immediately, expose incomplete work on downstream failure/stop
or explicit early review, and preserve permanent review-only outcomes. Manual acceptance requires
checked selected content, resolved reconciliation and explicit missing-content acknowledgment.
See issue #345 and ADR-0085; MWR-035–042/059 are specified, implementation outstanding.

Delivery [#352](https://github.com/nicolas-found42/chief-of-staff-demo/issues/352) is implementing the
legacy accepted-Task recovery portion of MWR-007/012 and extending MWR-062. HTTP regressions
reproduced changed retry completion, ambiguous orphans and contradictory source history before
fixes. Full gates/review/merge are pending. The broader atomic acceptance/migration contract remains
outstanding. No Workspace migration or live inference has occurred.

## Current delivery evidence — resumed #353

PR #366 is merged at `635cc9e562906b5e5d6638a10568fce21f395b3c`; all four main CI checks
passed. Session review fixed point is that merge SHA. #353 remains assigned to `nicolas-found42`
and open; its reusable workflow is implemented, tested and reviewed on branch
`codex/353-workspace-backup`, with exact-head CI and merge still outstanding.

**Delivered.** `WorkspaceBackup` (`apps/server/src/backup/workspace.ts`) captures a
checksum-inventoried Workspace at one verified quiescent point and restores only into an absent
destination whose current Workspace still equals that point; `scripts/workspace-backup.mts` is the
operator command, which records code, effective container configuration, stopped image identity and
the saved image archive, restores twice, and retains a private `failure.json` for every refused
attempt. Tests: `workspace-backup.test.ts` (14) and `workspace-backup-command.test.ts` (10) at the
public store/command seams, plus the two-restore Tasks browser journey; `docs/agents/workspace-backup.md`
documents the procedure. Full gate: 2,587 tests in 224 files with typecheck, lint, format and knip.

**Real evidence (private, superseding baseline-2).** `workspace-baseline-4`: the delivered command
captured 664 files / 56,667,177 bytes at 2026-09-10T21:05:04.605Z with the app stopped, canonical
hash `64177c51addf76e76237cd77783be8e74428e58cda41397e64e3b9fa88d0d5bb`, two independently restored
copies, and seven quiescence probes (0 writers, 705 read-only Docker handles, one VM-internal volume
recorded unresolved). An independent pass re-hashed all three trees byte-identically and read the
restored canonical stores: 64 Action Items, 75 Meetings, 6 Transcripts, consent grant present,
ledger 6, cutover receipt present, and zero Tasks, Task Lists and tombstones. A separate real
invocation refused restoration against the drifted live Workspace and wrote nothing; the app
rewrites two index files about five seconds after boot, so the same-point fence is load-bearing.
The running image `sha256:c34dfd19aaa59b05dd1b0021d6463f18cc3c1acf7f8789ceee882915f7aad584` was
restarted unchanged and healthy, its identity recorded separately from checkout HEAD with the
image-to-code relationship marked unverified.

**Honest limits.** The real snapshot's empty Task/Task-List/tombstone state means nonempty
accepted-work, external-receipt and deletion-history preservation rests on controlled cases, not on
live data. No spend ledger exists in the code yet (owned by #357). No stored format was activated and
no live inference occurred; host-crash and power-loss durability remain unclaimed, and applying
newer deletion/authorization state before a restore is #356's fence, not this issue's claim. Private
evidence remains under `/Users/Nicolas/.codex/meeting-wizard-delivery/2026-09-10/`.

## Delivery route — active

All specification tickets #339–351 are resolved under the appended execution authority. Their
historical interview/session language below is superseded. Detailed resolutions: [artifacts #345](https://github.com/nicolas-found42/chief-of-staff-demo/issues/345#issuecomment-5624548847),
[admission #346](https://github.com/nicolas-found42/chief-of-staff-demo/issues/346#issuecomment-5624602684),
[handoff #347](https://github.com/nicolas-found42/chief-of-staff-demo/issues/347#issuecomment-5624603406),
[Brief #348](https://github.com/nicolas-found42/chief-of-staff-demo/issues/348#issuecomment-5624604102),
and [comparison #349](https://github.com/nicolas-found42/chief-of-staff-demo/issues/349#issuecomment-5624605107).

The delivery issues #353–365 cover every stable ID; each Coverage row now links its primary delivery
owner. #352 is a bounded precursor for legacy Task recovery, implemented/tested in
[PR #366](https://github.com/nicolas-found42/chief-of-staff-demo/pull/366), awaiting exact-head merge.
It does not complete broader MWR-007/012. Code `1d8f39dc010067fb6f19cb745153126549bfe1f9` passed
2,563 tests in 222 files with the full static gate; 69 focused tests and six browser journeys passed.
Separate Standards and Spec reviews found no actionable findings. No new full recommendation is
claimed fully verified. Remaining migration, supported-fault and live/human evidence is outstanding.

The ready next issue is #353. Dependencies proceed through storage #354, identity/acceptance #355,
context/privacy #356 and admission #357, then publication #358, handoff #359, responsibility #360,
artifacts #361, Brief #362, campaign tooling/baseline #363, comparison #364 and final acceptance #365.
Native dependencies, not this abbreviated ordering, determine each ready slice. Final audit #365
cross-cuts earlier evidence; narrow existing safeguards are not proof of the broader contracts.

## Standing owner approval — 2026-09-10

The owner subsequently approved **all changes, recommendations, and fixes in the complete review**, including its proposed acceptance thresholds and validation plan. [Canonical approval record](https://github.com/nicolas-found42/chief-of-staff-demo/issues/338#issuecomment-5623223155). This supersedes earlier approval requests below: approved outstanding recommendations are now `planned`. The review’s conditional alternatives retain their evidence gates. No outcome is marked verified by approval alone.

Open tickets refine implementation contracts and missing evidence. Do not ask the owner again whether to adopt the review’s recommendations. Only unspecified material choices, unresolved conflicts, and actual external prerequisites may require further input. Review scope approval does not supply a missing numeric spend cap, filesystem durability promise, or third-party transcript-use authorization.

## Operating-contract decision — 2026-09-10

Resolved [Agree Meeting Wizard operating limits and release evidence](https://github.com/nicolas-found42/chief-of-staff-demo/issues/339#issuecomment-5623276954) after the owner selected the durability boundary and delegated spend limits to the agent’s recommendation. The linked resolution is the canonical contract; its [code investigation](https://github.com/nicolas-found42/chief-of-staff-demo/issues/339#issuecomment-5623268393) records measurement and preservation details. No delivery outcome is asserted.

Primary coverage MWR-017–021 and MWR-056–057 remains `planned`: specifications are settled, but baseline capture, restoration, live evaluation and acceptance evidence are outstanding. Interfaces to publication, admission, privacy, comparison and route assembly remain owned by their existing tickets. No recommendation was excluded. One non-research ticket was resolved this session.

Rechecked `main` at `bd80b089f401b4b1ea7486848742963022140385`, no open PRs, and the native frontier. Read-only investigation confirmed that the Golden runner bypasses application publication, overwrites repetition slots, and emits content-bearing logs; its serialization-error path may lack a terminal outcome file. Campaign accounting, isolated repetition roots and private logs are required delivery work under MWR-019/020/028/052/055. No new recommendation ID is needed: these refine already tracked acceptance work.

No tests or live model calls were run in this specification session. No configuration, Workspace data, saved demo, source file, code, or branch was changed. The review’s SHA-256 still matches the charting value. Only this local register was edited; tracker updates recorded the investigation and resolution, corrected superseded wording, closed the selected ticket and indexed its resolution. Labels and dependency edges were preserved.

## Identity/reconciliation decision — 2026-09-10

Resolved [Define Action Item identity and reconciliation across revisions](https://github.com/nicolas-found42/chief-of-staff-demo/issues/340#issuecomment-5623376786) after the owner chose explicit correction resolution before promotion and historical-evidence-versus-new-commitment review for later apparent recommitments. The linked comment is the canonical detailed specification and code investigation, including migration, recovery, application-path acceptance histories and downstream interfaces.

MWR-008–011 are now **specified, implementation and validation outstanding**; their disposition remains `planned`. MWR-061 retains only its narrower existing safeguard. All 64 recommendation IDs remain tracked with their existing primary owners and no exclusions. No new behavior is marked verified. Other contracts remain with their existing children; route assembly remains blocked until those decisions settle.

Rechecked branch and diff: `main` and remote main were both `bd80b089f401b4b1ea7486848742963022140385`, with no open PR. The existing modified full review is unchanged, with its recorded SHA-256. Native children/blockers/claims confirmed the identity ticket was first eligible; it was claimed for `nicolas-found42`. The final resolution closed only that ticket and added its pointer to the map. Assignee, labels and native dependency edges were retained; no other ticket or PR was changed and no new tracker item was created.

Fresh controlled-response baseline check:

```sh
pnpm --filter @chief-of-staff-demo/tests exec vitest run tests/src/api/action-items-routes.test.ts tests/src/api/tasks-routes.test.ts tests/src/api/legacy-action-migration.test.ts
```

**3 files, 75 tests passed** (Vitest reported 762 ms). This supports existing retry/reorder, dismissal/promotion, Task snapshot, restart and legacy-migration safeguards in those suites, including repeated legacy proposal positions. It does not verify the new reconciliation or migration design. The shared result currently loses candidate-to-output identity, read joins also hash content, promotion lacks expected-revision checks, and legacy migration depends on the old identity mapping. ADR-0078 already clarifies the old review-array reset boundary; the resolution extends it rather than treating the ADR-0037 wording as the current Workspace contract.

Local planning edits: glossary additions in `CONTEXT.md` and [Action Item identity survives proposal revisions](../adr/0080-action-item-identity-survives-proposal-revisions.md), alongside this register. The ADR is an accepted specification awaiting implementation. Preserve all these uncommitted files for the next session. No runtime code, configuration, Workspace data, source, model setting or saved demo was modified. No migration, live model call, commit, push or PR occurred. The four required checks were confirmed live as `check`, `test`, `e2e`, `image`; no delivery gate is claimed by this planning session.

The operating-contract spend and durability choices, source/route prerequisites, Mercury/Solar separation and conditional extractor alternatives remain unchanged.

## Transcript authorization investigation — 2026-09-10

Claimed [Authorize transcript routes and retention boundaries](https://github.com/nicolas-found42/chief-of-staff-demo/issues/341) for `nicolas-found42` after rechecking native map order, open blockers and assignments. It remains **open, awaiting owner choices**. The [code investigation and proposed acceptance contract](https://github.com/nicolas-found42/chief-of-staff-demo/issues/341#issuecomment-5623505531) records source/route grants, telemetry/artifact classes, deletion across consumers, restoration fencing, migration and synthetic acceptance cases. It is explicitly a draft, not a resolved specification.

Resolved only [Research OpenRouter transcript routing and retention controls](https://github.com/nicolas-found42/chief-of-staff-demo/issues/351#issuecomment-5623505108), a new map child with a historical native blocking edge into the privacy ticket. The cited local artifact is [provider retention research](meeting-wizard-provider-retention-research.md). Research was sequential in the current agent; no subagents or inference calls. Current endpoint declarations do not prove storage behavior, historical route compliance or private account settings. Inception's general policy is broader than OpenRouter's endpoint declaration; Solar has separate ordinary and ZDR endpoint variants. Effective-date checks avoided treating Upstage's future terms as current.

**MWR-051–054 remain planned; research complete, owner specification and implementation/validation outstanding.** All 64 stable recommendation IDs and their primary owners remain intact, with no exclusions or newly verified outcomes. The pending choices are authorized source scope/uses and authority; acceptance of the documented route boundary; retention of accepted Task evidence after source deletion; and newly proposed local retention periods. Review approval is not substituted for these answers.

Code findings refine E15: configured provider selection and folder consent are not versioned source/use/endpoint grants; routing lacks request privacy restrictions; the deletion composition registers Person Profile consumers but no Debrief/Action Item consumers; deletion removes a selected Catalog revision while tombstoning the source file; the receipt-after-removal boundary needs additional recovery coverage. Diagnostic captures, CLI content logs, mixed-source derivatives and independently stored campaign copies require explicit lifecycle/retention inventory.

Focused existing-behavior check, controlled synthetic data only:

```sh
pnpm --filter @chief-of-staff-demo/tests exec vitest run tests/src/modules/transcript-deletion.test.ts tests/src/api/transcript-delete-routes.test.ts
```

**2 files, 26 tests passed**, 756 ms. This supports existing Catalog tombstone and registered-consumer behavior only. No new retention, deletion, injection-resistance, provider policy, backup or restoration claim is verified.

Rechecked local and remote `main` at `bd80b089f401b4b1ea7486848742963022140385`, no open PR, and four required checks (`check`, `test`, `e2e`, `image`). Review SHA-256 remains the charting value. Preserved CONTEXT.md, ADR-0080 and the complete review unchanged. Edited this register and added only the research Markdown artifact locally. No runtime code/configuration, source/Workspace data, saved demo, model selection or branch was changed; no commit/push/PR or live evaluation. No non-research ticket was resolved. The privacy claim remains held so a continuation resumes it explicitly rather than selecting a second ticket.

## Owner follow-up: sources, retention and configurable models — 2026-09-10

The owner authorized both campaign-source use and regular Meeting Wizard use, selected preservation of accepted Task content/evidence after source deletion, and adopted the proposed retention periods. [Tracker record](https://github.com/nicolas-found42/chief-of-staff-demo/issues/341#issuecomment-5623545427). These choices are settled, not questions to repeat. Source rights are owner-authorized; actual account/route enforcement remains a delivery prerequisite.

The owner explicitly rejected hardcoded product model choices and selected `nex-agi/nex-n2.5-mini:free`, `deepseek/deepseek-v4.1-flash`, and `nvidia/nemotron-3.5-lightning`. This supersedes earlier intended-Mercury product assumptions. Runtime model strings/per-purpose overrides already exist; the pipeline must keep models configurable. Whether these replace the former fixed Solar release gate remains a separate pending choice. A chosen evaluation set must be recorded and frozen per campaign; model configuration is not permission to vary a comparison silently.

The extended primary-source research in [provider retention research](meeting-wizard-provider-retention-research.md) found ZDR-listed endpoints for DeepSeek and Nemotron, but not Nex free. OpenRouter lists Nex as no-training/30-day retention; the linked policy was not readable beyond a JavaScript shell. The only remaining owner questions are route-policy acceptance/Nex retention exception and release-gate role. No new source permission or local-retention approval is required. The earlier four-question pending summary is historical and superseded by this entry.

MWR-051–054 remain planned: some owner specifications are settled, route boundary is pending, implementation/validation outstanding. Preserve all 64 IDs. No code/configuration/source changes, live calls or new tests occurred in this follow-up. The prior 26-test result remains limited to existing deletion behavior.

## Transcript route/retention resolution — 2026-09-10

Resolved [Authorize transcript routes and retention boundaries](https://github.com/nicolas-found42/chief-of-staff-demo/issues/341#issuecomment-5623607764). Source use for campaign and regular Meeting Wizard use, accepted Task content/evidence preservation, local retention periods and the disclosed route boundaries are settled. The owner explicitly allowed all three selected models after disclosure of Nex's no-training/30-day-retention declaration and remaining provider-policy uncertainty. Do not re-ask these choices. The accepted exception is scoped; it does not assert ZDR for Nex or authorize arbitrary future unknown hosts.

The owner clarified that end users choose their provider/model; the three named models are for development tests of the pipeline and its output. This supersedes earlier Mercury-runtime and Solar-only development assumptions. Product behavior must remain configurable. [Comparison-ticket clarification](https://github.com/nicolas-found42/chief-of-staff-demo/issues/349#issuecomment-5623614725) owns the detailed frozen development manifest and per-model/aggregate acceptance protocol. That ticket remains open; the model-role question is no longer pending.

The [extended research resolution](https://github.com/nicolas-found42/chief-of-staff-demo/issues/351#issuecomment-5623606914) and [cited artifact](meeting-wizard-provider-retention-research.md) retain endpoint-policy facts and explicit limits. MWR-051–054 are **specified, implementation/validation outstanding**, disposition `planned`. All 64 IDs remain tracked with no exclusions or new verified outcomes. Historical pending-choice sections above are superseded by this resolution.

Added [Transcript deletion preserves accepted work](../adr/0081-transcript-deletion-preserves-accepted-work.md) and a Transcript Use Grant glossary definition, preserving all existing identity edits. Register/research/glossary/ADRs remain local and uncommitted. The complete review remains byte-for-byte unchanged. No code/configuration changes, live evaluation, source deletion, migration, commit/push or PR occurred. The existing 26-test deletion baseline remains the only new controlled verification from this decision session; it does not verify the new contract. Resolved one non-research ticket and its sequential research prerequisite. Claims, labels and historical dependency edges are retained.

## Association/time decision — 2026-09-10

Resolved [Define association confidence and meeting-time evidence](https://github.com/nicolas-found42/chief-of-staff-demo/issues/342#issuecomment-5623740742) after the owner selected trusted occurrence links or owner confirmation for association, and recorded/confirmed meeting timezone with no automatic Workspace-timezone fallback. The linked resolution is the canonical detailed contract, code investigation, migration requirements and acceptance histories. The review's preservation direction was already approved; no prior decision was reopened.

**MWR-043–045 are specified and planned; implementation and validation outstanding.** All 64 stable IDs and primary owners remain, with no exclusion or newly verified recommendation. Association, timing and identity are separate evidence; extraction snapshots and explicit correction preserve accepted work. Added glossary terms and [Meeting context requires evidence and preserves history](../adr/0082-meeting-context-requires-evidence-and-preserves-history.md), retaining ADR-0080/0081 and all existing uncommitted planning files. Existing fixed-Solar glossary/verification instructions describe the legacy implementation and must be updated in delivery under the settled configurable development-manifest contract; they are not a reopened model choice.

Rechecked local/remote `main` at `bd80b089f401b4b1ea7486848742963022140385`, diff, no open PRs, native dependencies/claims and live four-check ruleset. The first eligible child was claimed for `nicolas-found42`; only that non-research ticket was resolved. Posted its resolution, closed it and appended one map pointer, preserving labels, assignee and native edges. No new issue or implementation issue was created. The next expected child is [Define supported responsibility and automatic promotion](https://github.com/nicolas-found42/chief-of-staff-demo/issues/343); recheck claims before taking it.

Controlled existing-behavior verification:

```sh
pnpm --filter @chief-of-staff-demo/tests exec vitest run tests/src/modules/transcript-meeting-matching.test.ts tests/src/modules/meeting-join.test.ts tests/src/modules/meeting-debrief-messages.test.ts tests/src/unit/meetingFileName.test.ts
```

**4 files, 58 tests passed**, 196 ms reported by Vitest. This supports only the current matching/join/parser/message-helper behavior. It does not verify the new association/time/snapshot contract, migration or live semantic accuracy. E12 below records the narrowed premises. No live model call, runtime/configuration change, source/Workspace modification, migration, commit, push or PR occurred. Review SHA-256 remains the charting value. Spending, source/route/retention, model configurability and process/container-plus-tested-backup boundaries remain settled, with host/power-loss durability unclaimed.

## Responsibility/promotion investigation — 2026-09-10

Claimed [Define supported responsibility and automatic promotion](https://github.com/nicolas-found42/chief-of-staff-demo/issues/343) for `nicolas-found42` after checking map order and all three closed native blockers. It remains **open, awaiting two material owner choices**. The [investigation and proposed contract](https://github.com/nicolas-found42/chief-of-staff-demo/issues/343#issuecomment-5623824655) records code facts, the responsibility structure, conjunctive eligibility, first-extraction/policy receipts, acceptance histories, migration and downstream interfaces. It is not a resolution. No second non-research ticket was taken.

Pending choices: whether an assignment without the performer's acceptance can authorize automatic owner promotion (recommend requiring owner commitment or unambiguous acceptance), and whether lifting the demo restriction requires explicit enablement or resumes an existing enabled preference (recommend explicit enablement for future eligible first extractions, no backlog sweep). The review-only restriction and dedicated fixtures/live-output audit are already approved; these questions do not reopen that approval. Answers have not arrived; do not infer them from elapsed time or preselected options.

MWR-013–016 remain `planned`, with contract refinement in progress and implementation/validation outstanding. All 64 stable IDs and their existing primary owners are retained, with no exclusion or newly verified outcome. Added only the approved Action Item Responsibility Claim glossary term to CONTEXT.md; defer the ADR-0057 refinement ADR until the two choices settle. ADRs 0080–0082 and all prior local planning edits remain intact.

Rechecked local/remote main at `bd80b089f401b4b1ea7486848742963022140385`, no open PR, and the four live required checks. Controlled baseline: `pnpm --filter @chief-of-staff-demo/tests exec vitest run tests/src/api/auto-promotion.test.ts tests/src/modules/candidate-accounting.test.ts` — **2 files, 67 tests passed**, 1.13 seconds reported by Vitest. This supports existing behavior, including legacy-shaped automatic promotion and supplied responsibility judgments; it does not prove semantic quality or the proposed eligibility contract. Code infers first extraction from retained Action Items, leaving zero-action history unrepresented, and lacks durable policy/context eligibility receipts. The publication decision owns the recovery protocol.

Tracker writes this session: assignment and one sanitized investigation comment on the claimed ticket only. No closure, map-index change, label/dependency change or new issue. No runtime/configuration/source/Workspace changes, migration, live calls, commit, push or PR. Review SHA-256 remains the charting value. Next session resumes this existing claim rather than skipping it; only after resolution should the frontier advance to [Specify durable Debrief publication and Task promotion recovery](https://github.com/nicolas-found42/chief-of-staff-demo/issues/344).

## Responsibility/promotion resolution — 2026-09-10

Resolved [Define supported responsibility and automatic promotion](https://github.com/nicolas-found42/chief-of-staff-demo/issues/343#issuecomment-5623947689) after the owner answered “your recs for all remaining questions.” The two pending recommendations are now owner decisions: commitment or unambiguous acceptance of the exact obligation is required, and the passed demo evidence gate requires explicit enablement for future eligible first extractions without a backlog sweep. The linked resolution adopts the investigation's full contract and adds acceptance histories; its earlier pending-choice language is superseded.

**MWR-013–016 are specified and planned; implementation and validation outstanding.** All 64 stable IDs and primary owners remain, without exclusions or newly verified outcomes. Added [Automatic promotion requires accepted responsibility and enablement](../adr/0083-automatic-promotion-requires-accepted-responsibility-and-enablement.md) and refined the Action Item Policy glossary definition. All prior local planning edits, ADRs 0080–0082 and the complete review are preserved. These files remain uncommitted.

Rechecked local/remote main at `bd80b089f401b4b1ea7486848742963022140385`, working diff, no open PRs, native dependencies and the existing `nicolas-found42` claim. Code still shows the version-1 responsibility contract, conditional absent-handoff guard and queue-derived first-extraction history. The earlier 67-test baseline remains historical controlled evidence only; no tests or live evaluations were rerun for this prose-only continuation. The complete review checksum still matches the charting value.

Tracker writes: one resolution comment, closure of the claimed responsibility ticket and one linked map decision entry. Labels, assignment and native edges were preserved; no new issue or second non-research resolution. No implementation, runtime/configuration/source/Workspace change, migration, commit, push or PR. Publication/recovery, artifacts, handoff details and comparison retain their existing ownership; route assembly remains responsible for implementation issues when the route is clear. Next expected child: [Specify durable Debrief publication and Task promotion recovery](https://github.com/nicolas-found42/chief-of-staff-demo/issues/344), unclaimed at recheck; verify again before claiming.

## Publication/recovery decision — 2026-09-10

Resolved [Specify durable Debrief publication and Task promotion recovery](https://github.com/nicolas-found42/chief-of-staff-demo/issues/344#issuecomment-5624158213) under the standing approval and settled upstream decisions. The linked comment is the canonical detailed contract: actual write boundaries, immutable preparation and mappings, checked publication/completion, first-extraction/policy receipts, original Task Acceptance, migration, deletion fencing and controlled fault acceptance. No additional material owner choice was needed or settled choice reopened.

**MWR-002–007 and MWR-012 are specified and planned; implementation and validation outstanding.** MWR-062 retains only its existing narrower orphan-adoption safeguard. All 64 stable IDs and primary owners remain intact, with no exclusions or newly verified recommendations. Added Debrief Publication and Task Acceptance glossary definitions and [Debrief publication verifies durable work](../adr/0084-debrief-publication-verifies-durable-work.md). Prior glossary/ADR/research edits and the complete review are preserved. Planning files remain local and uncommitted.

Controlled baseline: `pnpm --filter @chief-of-staff-demo/tests exec vitest run tests/src/api/tasks-routes.test.ts tests/src/api/action-items-routes.test.ts tests/src/api/auto-promotion.test.ts tests/src/modules/meeting-debrief.test.ts tests/src/modules/meeting-debrief-review.test.ts` — **5 files, 120 tests passed**, 986 ms. These establish existing controlled behavior only. No process/container fault matrix, proposed protocol, migration, backup restore or live semantic quality is newly verified.

Inspection refined E02–E04: current materialization writes a whole batch, and the canonical Task cutover bundle overrides per-file stores. Run recovery sweeps only pending/running status; result/review file presence can bypass materialization reconciliation. Event parsing ignores malformed interior lines as well as a torn tail. Promotion can separately write open Task, completed state and relationship; existing orphan adoption can apply a changed retry body's completed flag. The resolved contract covers these boundaries without asserting a reproduced production incident. Its file-storage choice remains conditional on supported-fault acceptance.

Rechecked local/remote main at `bd80b089f401b4b1ea7486848742963022140385`, native blockers/claims, no open PRs, and four live required checks (`check`, `test`, `e2e`, `image`). Review SHA-256 still matches the charting value. Existing trailing whitespace in the private review was preserved; the new planning edits were reviewed separately. Only this non-research ticket was claimed and resolved; one resolution comment and one map index entry were written, retaining labels, assignee and historical native edges. No other ticket or PR was changed, no new issue was created, and no implementation issue was finalized while the route remains incomplete.

No runtime/configuration/source/Workspace change, inference, migration, commit, push or PR occurred. Preserve configurable product models, the frozen development-manifest boundary, source/retention decisions, cumulative spending, process/container-plus-tested-backup recovery and unclaimed host/power-loss durability. Next expected child is the artifact/completeness decision, subject to a fresh native frontier check.

## Accepted-artifact investigation — 2026-09-10

Claimed [Define accepted artifacts, targeted regeneration, and incomplete Debriefs](https://github.com/nicolas-found42/chief-of-staff-demo/issues/345) for `nicolas-found42` after the live native frontier showed its two blockers closed and no assignee. It remains **open, awaiting three owner choices**. The [investigation and proposed contract](https://github.com/nicolas-found42/chief-of-staff-demo/issues/345#issuecomment-5624326481) records code facts, dependency/version rules, rejected-field isolation, corruption distinctions, migration and proposed acceptance histories. It is not a resolution.

Pending choices: required versus optional completion sections; manual promotion from a checked incomplete revision; and immediate core publication versus exposure on required-work failure/stop or explicit early-review request. The last choice matters because settled policy makes incomplete publication permanently review-only: later enrichment cannot restore automatic eligibility. Recommendations were presented to the owner but are not answers. Scope approval and delivery authorization do not settle these choices. No non-research ticket has been resolved in this session.

**MWR-035–042 and MWR-059 remain planned; detailed specification pending, implementation and verification outstanding.** MWR-063 retains only its narrower existing safeguard. All 64 IDs, primary owners and conditional evidence gates remain intact, with no exclusion or newly verified outcome. The route-assembly ticket still has five open blockers; no delivery issue is ready or finalized.

Controlled baseline:

```sh
pnpm --filter @chief-of-staff-demo/tests exec vitest run tests/src/modules/candidate-accounting.test.ts tests/src/modules/meeting-debrief-review.test.ts tests/src/modules/meeting-debrief.test.ts tests/src/api/action-items-routes.test.ts
```

**4 files, 108 tests passed; Vitest duration 1.30 seconds.** These establish existing extraction/cache/regeneration/review behavior only. No new artifact protocol, fault recovery, migration, live semantics or owner-usefulness result is verified. No new test was written at an unconfirmed seam. Full delivery gates were not run for this investigation.

Rechecked main and remote main at `bd80b089f401b4b1ea7486848742963022140385`, recorded it as implement's starting review fixed point, inspected the diff, found no open PR and confirmed live required checks `check`, `test`, `e2e`, `image`. Read the handoff, complete review/critique, register, implementation prompt, retention research, glossary, relevant ADRs and settled resolutions. Review SHA-256 still matches the charting value. The combined overview call currently couples factual sections with coaching/effectiveness/recipient suggestions; final cardinality validation happens after enrichment, so a new core boundary must retain that validation. UI/API currently assume complete extraction and require section-aware availability. Raw-cache corruption and damage to an accepted/prepared artifact require different recovery paths.

Tracker writes were the claim and one sanitized investigation comment only. No map decision, issue closure, label/dependency change, new issue or unrelated tracker edit. This register is the only repository file edited in this session; all prior glossary, ADR and private research changes are preserved. No new ADR is asserted before owner decisions settle. No runtime/configuration/source/Workspace change, migration, model call, commit, push or PR occurred. Cumulative spend, configurable model selection, immutable context, accepted work, source deletion intent and the agreed durability boundary remain unchanged.

## Baseline and evidence limits

- Inspected `main` at `bd80b089f401b4b1ea7486848742963022140385`; local `origin/main` matched. Earlier working-tree implementation is merged in [feat: make meeting handoffs auditable and debrief retries resumable](https://github.com/nicolas-found42/chief-of-staff-demo/pull/337). No open PR was present at inspection.
- The pre-existing uncommitted change is `docs/research/meeting-wizard-architecture-review.md`; it is preserved byte-for-byte. This register is a new, uncommitted planning artifact. No baseline implementation branch, model setting, saved demo, Task or Workspace data was modified.
- Source review: `docs/research/meeting-wizard-architecture-review.md` (complete, 421 lines). Source brief: `docs/research/meeting-wizard-architecture-critique-brief.md` (491 lines). The brief describes an older local snapshot; its claims were checked against current code rather than assumed.
- Intended runtime remains Mercury (`inception/mercury-2.5`); current live configuration was not frozen or asserted. Solar (`upstage/solar-pro4`) remains the fixed Prompt Eval Gate. Prior PR explicitly does not claim a successful final Solar gate.
- Existing maps were closed and unrelated; open issues concern Person Profile research. No matching review map or delivery issue existed. Those issues and closed historical meeting work are context, not recreated or modified.
- No owner decision or recommendation exclusion was made during initial charting; the later blanket approval above now governs. Firm recommendations remain in scope; numeric thresholds, examples and mutually exclusive alternatives are identified separately. Examples become acceptance scenarios, not additional product features.

## Focused verification performed

Command (controlled responses, isolated test data; no live model calls):

```sh
pnpm --filter @chief-of-staff-demo/tests exec vitest run tests/src/api/action-items-routes.test.ts tests/src/api/tasks-routes.test.ts tests/src/api/auto-promotion.test.ts tests/src/modules/candidate-accounting.test.ts tests/src/modules/meeting-brief-gmail-delivery-provider.test.ts
```

**Result: 5 files, 130 tests passed**, 2026-09-10, Vitest reported 1.11 seconds. This supports only the existing narrow safeguards cited below. No new implementation is verified. Full static/deterministic, Solar, live Mercury, browser, Docker, restoration and crash-injection delivery gates remain outstanding under their owning tickets. Prose-only charting requires no whole-tree code gate; nothing was pushed.

## Coverage

Every row has one primary decision owner now. Once settled, assign its implementation issue without copying the decision resolution here. `already satisfied` is used only for a narrowly stated safeguard supported by inspected code and passing tests. `needs decision` does not authorize deferral or exclusion. Evidence keys link to the inspected baseline below; acceptance column states the proof still required unless explicitly recorded above.

| ID | Review source / strength | Requested change | Current evidence / missing proof | Owner | Disposition | Acceptance evidence | Merged delivery PR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MWR-001 | §1, §4; firm keep | Preserve Shell/Module/Catalog/Workspace ownership, single process, separate Brief/Debrief Runs and no shared Meeting lifecycle. | [E01](#e01) | [#358: feat: reconcile immutable Debrief publication and completion receipts](https://github.com/nicolas-found42/chief-of-staff-demo/issues/358) | planned | Architecture and application-path regressions retain ownership; no competing Meeting lifecycle. | — |
| MWR-002 | §1, §3; conditional alternative | Retain file storage initially; account for Alternative B (transactional records and durable graph) only against evidence of unsafe reconciliation, conflicting edits, granular recovery need or uneconomic long-source checks. | [E02](#e02) | [#354: feat: coordinate Workspace writes and safely commit artifacts](https://github.com/nicolas-found42/chief-of-staff-demo/issues/354) | implementing | Owner records file-durability decision and explicit escalation triggers; alternative is not silently rejected.  Resumed #354 review corrected coordination/version guards and added process/container evidence; updated PR #368 merge pending. | — |
| MWR-003 | F1, §4, Stage 1; firm | Introduce immutable extraction manifest with result checksum, contract/validator versions, completeness and expected output-to-Action-Item mapping. | [E03](#e03) | [#358: feat: reconcile immutable Debrief publication and completion receipts](https://github.com/nicolas-found42/chief-of-staff-demo/issues/358) | planned | Corrupt/missing manifest/result cannot complete; each output maps to the expected durable proposal. | — |
| MWR-004 | F1, §4, Stage 1; firm | Use a Module-owned idempotent commit/reconciliation and completion verifier instead of file-presence recovery. | [E03](#e03) | [#358: feat: reconcile immutable Debrief publication and completion receipts](https://github.com/nicolas-found42/chief-of-staff-demo/issues/358) | planned | Twice-recovered prepared result yields expected records exactly once with zero model calls; invalid or missing records prevent done. | — |
| MWR-005 | F1, Stage 1; firm | Supply safe artifact writes and serialized Workspace updates in Shell primitives without claiming a multi-file atomic transaction. | [E02](#e02) | [#354: feat: coordinate Workspace writes and safely commit artifacts](https://github.com/nicolas-found42/chief-of-staff-demo/issues/354) | implementing | Interrupted/truncated writes cannot publish invalid data; concurrent update semantics are explicit.  Resumed #354 review corrected coordination/version guards and added process/container evidence; updated PR #368 merge pending. | — |
| MWR-006 | F1, Stage 1; firm | Fault-test every final-write boundary, including materialization, review state, event append, disk full, corrupt artifacts and repeated recovery. | [E03](#e03) | [#354: feat: coordinate Workspace writes and safely commit artifacts](https://github.com/nicolas-found42/chief-of-staff-demo/issues/354) | implementing | Process termination and injected errors at each boundary preserve all owner decisions and converge twice.  Resumed #354 review corrected coordination/version guards and added process/container evidence; updated PR #368 merge pending. | — |
| MWR-007 | Stage 1; firm | Apply completion/reconciliation discipline to Task creation and Action Item promotion. | [E04](#e04) | [#355: feat: preserve Action Item identity and atomic Task acceptance](https://github.com/nicolas-found42/chief-of-staff-demo/issues/355) | implemented, tested, merged; not fully verified | Real fault matrix extends existing orphan adoption; no duplicate Task after Task-write/link-write interruption. | [PR #369](https://github.com/nicolas-found42/chief-of-staff-demo/pull/369), merged `3b7e2ce` |
| MWR-008 | F2, Stage 2; firm | Keep every existing Action Item ID opaque and unchanged; allocate opaque IDs for new proposals, independent of mutable display fields. | [E05](#e05) | [#355: feat: preserve Action Item identity and atomic Task acceptance](https://github.com/nicolas-found42/chief-of-staff-demo/issues/355) | implemented, tested, merged; not fully verified | No existing rekey; reorder/paraphrase/date/owner edits/new Runs do not accidentally define identity; identical display fields may represent distinct obligations. | [PR #369](https://github.com/nicolas-found42/chief-of-staff-demo/pull/369), merged `3b7e2ce` |
| MWR-009 | F2, Stage 2; firm | Store proposal revisions, source observations and materialization keys separately from semantic reconciliation. | [E05](#e05) | [#355: feat: preserve Action Item identity and atomic Task acceptance](https://github.com/nicolas-found42/chief-of-staff-demo/issues/355) | implemented, tested, merged; not fully verified | Exact retry keys replay once; lineage and changed proposal content remain inspectable. | [PR #369](https://github.com/nicolas-found42/chief-of-staff-demo/pull/369), merged `3b7e2ce` |
| MWR-010 | F2, Stage 2; firm | Make semantic matches explicit evidence attachments or amendment proposals, never silent Task edits or reversed dismissals. | [E05](#e05) | [#355: feat: preserve Action Item identity and atomic Task acceptance](https://github.com/nicolas-found42/chief-of-staff-demo/issues/355) | implemented, tested, merged; not fully verified | Accepted Task title/content/state/owner/date and dismissed history survive paraphrase, re-extraction and correction. | [PR #369](https://github.com/nicolas-found42/chief-of-staff-demo/pull/369), merged `3b7e2ce` |
| MWR-011 | F2, §6 essential; firm | Surface ambiguous matches for owner review; do not automatically merge later recommitments or equal-display distinct obligations. | [E05](#e05) | [#355: feat: preserve Action Item identity and atomic Task acceptance](https://github.com/nicolas-found42/chief-of-staff-demo/issues/355) | implemented, tested, merged; not fully verified | Representative multi-Meeting histories and equal-title examples have owner-approved outcomes and visible ambiguity. | [PR #369](https://github.com/nicolas-found42/chief-of-staff-demo/pull/369), merged `3b7e2ce` |
| MWR-012 | Stage 2, §6 essential; firm | Serialize conflicting Workspace writes or reject expected-version conflicts. | [E02](#e02) | [#354: feat: coordinate Workspace writes and safely commit artifacts](https://github.com/nicolas-found42/chief-of-staff-demo/issues/354) | implementing | Extraction, review, promotion and Task-edit races preserve decisions or show a conflict, never silently overwrite.  Resumed #354 review corrected coordination/version guards and added process/container evidence; updated PR #368 merge pending. | — |
| MWR-013 | F3; firm | Represent speaker, proposed performer, commitment/assignment and supporting turns as a structured responsibility claim. | [E06](#e06) | [#360: feat: gate automatic promotion on accepted responsibility and release evidence](https://github.com/nicolas-found42/chief-of-staff-demo/issues/360) | planned | Contract separates relationship roles; first-person, reported speech, request, shared work and quotation fixtures pass. | — |
| MWR-014 | F3; firm | Judge acceptance of the particular obligation and later updates; retain deterministic reference checks without treating grounding as semantic proof. | [E06](#e06) | [#360: feat: gate automatic promotion on accepted responsibility and release evidence](https://github.com/nicolas-found42/chief-of-staff-demo/issues/360) | planned | Later cancellation/correction and unsupported assignment cannot authorize owner work; live audit covers semantic errors. | — |
| MWR-015 | F3, §4; firm policy change | Require current supported handoff, confirmed owner, all existing eligibility checks and no unresolved reconciliation/completeness warnings for automatic promotion; legacy/incomplete goes to review. | [E07](#e07) | [#360: feat: gate automatic promotion on accepted responsibility and release evidence](https://github.com/nicolas-found42/chief-of-staff-demo/issues/360) | planned | Every contract version and changed identity is tested; unsupported, absent or incomplete handoff cannot auto-create Tasks. | — |
| MWR-016 | F3, Stages 0/6; firm policy change | Keep demo automatic promotion disabled/review-only until dedicated fixtures and live-output audit pass; never authorize through model confidence. | [E07](#e07) | [#360: feat: gate automatic promotion on accepted responsibility and release evidence](https://github.com/nicolas-found42/chief-of-staff-demo/issues/360) | planned | Temporary restriction and evidence-gated re-enable are approved; policy enforcement, dedicated fixtures and live audit remain outstanding. Live settings were not changed. | — |
| MWR-017 | F4, Stage 0; firm | Freeze current revision/diff, configuration, prompts/schemas/validators, binding, source and context hashes for reproducible baseline. | [E08](#e08) | [#353: feat: capture reproducible Meeting Wizard backups and restoration evidence](https://github.com/nicolas-found42/chief-of-staff-demo/issues/353) | implementing | Merged #353 evidence: 2,589 tests/224 files, 26 focused cases, two-restore browser journey, private baseline-4; empty live accepted-work/deletion denominators disclosed. Later lifecycle/campaign acceptance remains separate. | [PR #367](https://github.com/nicolas-found42/chief-of-staff-demo/pull/367) |
| MWR-018 | Stage 0; firm | Back up Workspace and test restoration; inventory Task content/state, Action Item IDs and review decisions before migration. | [E02](#e02) | [#353: feat: capture reproducible Meeting Wizard backups and restoration evidence](https://github.com/nicolas-found42/chief-of-staff-demo/issues/353) | implementing | Merged #353 evidence: 2,589 tests/224 files, 26 focused cases, two-restore browser journey, private baseline-4; empty live accepted-work/deletion denominators disclosed. Later lifecycle/campaign acceptance remains separate. | [PR #367](https://github.com/nicolas-found42/chief-of-staff-demo/pull/367) |
| MWR-019 | F4, Stage 0; firm | Run deterministic baseline and all 20 Goldens under the frozen development manifest; the review’s original fixed-Solar assumption is superseded by the owner’s configurable three-model test set. | [E08](#e08) | [#363: feat: record complete private Meeting Wizard validation campaigns](https://github.com/nicolas-found42/chief-of-staff-demo/issues/363) | planned | Complete retained outcome for every required Golden/model slot; no missing/failed result hidden. Comparison design owns detailed per-model/aggregate acceptance; historical Mercury/Solar evidence keeps its labels. | — |
| MWR-020 | F4, Stage 0; firm | Run three cold incident-transcript repetitions with empty/disabled request checkpoints. | [E08](#e08) | [#363: feat: record complete private Meeting Wizard validation campaigns](https://github.com/nicolas-found42/chief-of-staff-demo/issues/363) | planned | First-attempt completion, repairs, retries, elapsed time and full cost recorded; resumed attempt never called cold. | — |
| MWR-021 | F4, Stages 5/6; firm | Measure false/missed actions, wrong responsibility/dates/merges, false decisions and unsupported handoff details separately with denominators. | [E08](#e08) | [#363: feat: record complete private Meeting Wizard validation campaigns](https://github.com/nicolas-found42/chief-of-staff-demo/issues/363) | planned | Per-category counts, critical-error definition and passing criteria agreed; no critical semantic regression hidden by shape/accounting success. | — |
| MWR-022 | F4, §6 useful; firm | Human-adjudicate disagreements and audit passing outputs; measure Gate Model disagreement and admit valid extra actions missing from Goldens. | [E08](#e08) | [#363: feat: record complete private Meeting Wizard validation campaigns](https://github.com/nicolas-found42/chief-of-staff-demo/issues/363) | planned | Blind review protocol and retained judgments include false negatives and apparently passing outputs; model is not final authority. | — |
| MWR-023 | F5, Stage 3; firm | Put configurable global concurrency admission in shared provider path for normal calls, retries, repairs and fallbacks. | [E09](#e09) | [#357: feat: enforce shared model admission and cumulative operation budgets](https://github.com/nicolas-found42/chief-of-staff-demo/issues/357) | planned | Multi-Module controlled delay/rate-limit test never exceeds the cap for all attempt types. | — |
| MWR-024 | F5; firm | Use fair scheduling with time-sensitive priority and no permanent background starvation; expose queue age/wait. | [E09](#e09) | [#357: feat: enforce shared model admission and cumulative operation budgets](https://github.com/nicolas-found42/chief-of-staff-demo/issues/357) | planned | Controlled Brief/Debrief/background backlog demonstrates bounded wait and the approved priority policy. | — |
| MWR-025 | F5, Stage 3; firm | Enforce whole-operation deadline, input/output token and estimated-spend budgets across automatic recovery; make owner extensions explicit with cumulative cost. | [E09](#e09) | [#357: feat: enforce shared model admission and cumulative operation budgets](https://github.com/nicolas-found42/chief-of-staff-demo/issues/357) | planned | Retry/repair/restart cannot reset allowance; cancellation/exhaustion/extension outcomes are inspectable. | — |
| MWR-026 | F5; firm | Preflight every complete request against token allowance including ledger and output reserve; never silently truncate source or candidates. | [E09](#e09) | [#357: feat: enforce shared model admission and cumulative operation budgets](https://github.com/nicolas-found42/chief-of-staff-demo/issues/357) | planned | Oversize late-stage requests fail or take approved route before spend; retained accounting is complete. | — |
| MWR-027 | F5, §4, Stage 3; firm | Add operation cancellation and stale-write prevention, preserving settle-before-retry until safety is proven. | [E10](#e10) | [#357: feat: enforce shared model admission and cumulative operation budgets](https://github.com/nicolas-found42/chief-of-staff-demo/issues/357) | planned | Cancel at active request/repair/commit boundaries then recover without stale artifacts or duplicate work. | — |
| MWR-028 | Stage 3; firm | Build reconstructable operation/Run/request/repair/cache/commit timeline with queue/provider wait, duration, tokens, known/estimated cost, failures and validation outcomes. | [E09](#e09) | [#357: feat: enforce shared model admission and cumulative operation budgets](https://github.com/nicolas-found42/chief-of-staff-demo/issues/357) | planned | Every attempt belongs to an operation and Run; final state and cumulative cost can be explained without raw transcript text. | — |
| MWR-029 | F6, §4; firm experiment | Coalesce exact-overlap discovery observations before expensive checks, preserving every original candidate ID as an accounting alias. | [E10](#e10) | [#364: feat: evaluate consolidated extraction behind preserved quality gates](https://github.com/nicolas-found42/chief-of-staff-demo/issues/364) | planned | Exact duplicates reduce work without removing source observations or collapsing distinct obligations. | — |
| MWR-030 | F6, §3/4; conditional experiment | Trial consolidated batch status/facts/responsibility judgment with focused semantic challenges for disputed/high-risk rows and sample exclusions. | [E10](#e10) | [#364: feat: evaluate consolidated extraction behind preserved quality gates](https://github.com/nicolas-found42/chief-of-staff-demo/issues/364) | planned | Controlled comparison measures recall and quality of exclusions as well as retained rows; no enablement before owner gate. | — |
| MWR-031 | F6, §4; firm keep | Retain broad discovery, deterministic accounting/reference checks, full-source coverage and global completion/contradiction/deduplication checks initially. | [E10](#e10) | [#364: feat: evaluate consolidated extraction behind preserved quality gates](https://github.com/nicolas-found42/chief-of-staff-demo/issues/364) | planned | Later completion, scheduling versus attendance, conditional work and repeated-project fixtures retain distinct correct obligations. | — |
| MWR-032 | §3, Stage 5; proposed experiment protocol | Compare six representative Goldens, current versus Alternative A, three cold repetitions each (36 Runs) with fixed source/context/model/budgets. | [E08](#e08) | [#364: feat: evaluate consolidated extraction behind preserved quality gates](https://github.com/nicolas-found42/chief-of-staff-demo/issues/364) | planned | Protocol approved and campaign spending boundary specified; comparison ticket refines fixture selection and retains paired artifacts, including every failed attempt. | — |
| MWR-033 | §3, Stage 5; proposed threshold | Advance consolidation only with no new critical semantic errors and meaningful efficiency gain; proposed ≥25% input or cost reduction and no material latency regression. | [E08](#e08) | [#364: feat: evaluate consolidated extraction behind preserved quality gates](https://github.com/nicolas-found42/chief-of-staff-demo/issues/364) | planned | Numeric threshold approved; comparison ticket specifies no-material-latency-regression rule and evidence-based go/no-go, retaining human adjudication. | — |
| MWR-034 | §3, Stage 5; conditional alternative | Keep hardened current extractor when separate passes earn their cost; retain it as rollout fallback; investigate Alternative B only under recorded triggers. | [E10](#e10) | [#364: feat: evaluate consolidated extraction behind preserved quality gates](https://github.com/nicolas-found42/chief-of-staff-demo/issues/364) | planned | Explicit conditional delivery route and later evidence-based owner selection; no useful checks removed solely for count. | — |
| MWR-035 | F7, §4, Stage 4; firm product change | Publish explicitly incomplete Debrief revision only after source-status, responsibility, accounting, full-source coverage and deduplication checks establish the action core. | [E03](#e03) | [#361: feat: retain incomplete Debriefs and regenerate sections independently](https://github.com/nicolas-found42/chief-of-staff-demo/issues/361) | planned | Failed global check publishes no provisional Action Items; failed enrichment leaves checked proposals reviewable. | — |
| MWR-036 | F7, Stage 4; firm product change | Show missing sections, keep Run incomplete until full required contract passes, and prevent incomplete automatic promotion. | [E03](#e03) | [#361: feat: retain incomplete Debriefs and regenerate sections independently](https://github.com/nicolas-found42/chief-of-staff-demo/issues/361) | planned | UI accurately distinguishes unavailable enrichment from complete result and valid zero actions; policy gate cannot be bypassed. | — |
| MWR-037 | F7; firm | Treat unknown responsibility and conditional timing as valid uncertainty when supported, distinct from missing accounting or unsupported named responsibility. | [E06](#e06) | [#361: feat: retain incomplete Debriefs and regenerate sections independently](https://github.com/nicolas-found42/chief-of-staff-demo/issues/361) | planned | Approved examples can complete with honest uncertainty; invalid evidence/accounting cannot masquerade as uncertainty. | — |
| MWR-038 | F7/F8, §4, Stage 4; firm | Commit immutable checked action-core artifacts and retry enrichment independently without action rediscovery. | [E03](#e03) | [#361: feat: retain incomplete Debriefs and regenerate sections independently](https://github.com/nicolas-found42/chief-of-staff-demo/issues/361) | planned | Fail coaching then retry with zero discovery calls and unchanged reviewed Action Items/Tasks. | — |
| MWR-039 | F8; firm keep | Keep exact-request raw-response reuse and revalidate under current rules; a timeout-only change need not invalidate a usable answer. | [E11](#e11) | [#361: feat: retain incomplete Debriefs and regenerate sections independently](https://github.com/nicolas-found42/chief-of-staff-demo/issues/361) | planned | Change semantic validator without changing prompt and show revalidation; corrupt cache is safely recomputed. | — |
| MWR-040 | F8, Stage 4; firm | Distinguish accepted artifacts keyed by source revision, association/identity snapshot, upstream hashes and relevant contract/validator versions. | [E11](#e11) | [#361: feat: retain incomplete Debriefs and regenerate sections independently](https://github.com/nicolas-found42/chief-of-staff-demo/issues/361) | planned | Changed dependency invalidates/rechecks affected artifacts; raw response is never mistaken for accepted result. | — |
| MWR-041 | F8; firm | Record actual route and binding provenance without making every model call a durable Stage. | [E09](#e09) | [#361: feat: retain incomplete Debriefs and regenerate sections independently](https://github.com/nicolas-found42/chief-of-staff-demo/issues/361) | planned | Accepted artifacts trace execution route and binding; small Module dependency map suffices under approved contract. | — |
| MWR-042 | F8, Stage 4; firm | Regenerate only requested sections from immutable source and relevant checked facts, excluding rejected text as authority. | [E03](#e03) | [#361: feat: retain incomplete Debriefs and regenerate sections independently](https://github.com/nicolas-found42/chief-of-staff-demo/issues/361) | planned | Summary-only regeneration makes no discovery call and leaves Action Item IDs, decisions and Tasks unchanged. | — |
| MWR-043 | F9, §4; firm | Store association provenance and versioned source/association/identity extraction snapshot; uniqueness alone is not confidence. | [E12](#e12) | [#356: feat: preserve Meeting context and enforce source lifecycle grants](https://github.com/nicolas-found42/chief-of-staff-demo/issues/356) | planned | Weak unique match can remain unresolved and still receive transcript-backed Debrief; historical context remains inspectable. | — |
| MWR-044 | F9; firm | Use recorded meeting-time anchor and timezone for relative dates; preserve stated wording if uncertain; modification time must not silently become meeting time. | [E12](#e12) | [#356: feat: preserve Meeting context and enforce source lifecycle grants](https://github.com/nicolas-found42/chief-of-staff-demo/issues/356) | planned | Delayed upload and timezone-boundary fixtures separate source time from file time. Current extraction already uses filename-derived date; premise must be narrowed. | — |
| MWR-045 | F9; firm | Reassociation must not rekey Action Items, alter accepted Tasks or convert a name mention into confirmed identity. | [E12](#e12) | [#356: feat: preserve Meeting context and enforce source lifecycle grants](https://github.com/nicolas-found42/chief-of-staff-demo/issues/356) | planned | Accept Task then correct association: historical result/Task intact and proposed correction explicit. | — |
| MWR-046 | F10; firm | Separate supported requirements from suggested execution detail structurally and visually, including purpose, criteria, inputs and obtain-by proposals. | [E13](#e13) | [#359: feat: retain handoff provenance and stable Action Item references](https://github.com/nicolas-found42/chief-of-staff-demo/issues/359) | planned | No agreed method fixture clearly labels suggestion; missing-input suggestion cannot create an extra commitment. | — |
| MWR-047 | F10; firm keep | Preserve explicit/inferred labels through Task promotion rather than only in Debrief. | [E13](#e13) | [#359: feat: retain handoff provenance and stable Action Item references](https://github.com/nicolas-found42/chief-of-staff-demo/issues/359) | already satisfied | Existing promotion test and handoffNotes demonstrate labels survive into accepted Task notes; richer provenance remains separate work. | Existing baseline; no new delivery PR |
| MWR-048 | F10; firm product choice | Resolve internal dependencies to stable reconciled Action Item references; retain unresolved/external dependencies without invented targets. | [E13](#e13) | [#359: feat: retain handoff provenance and stable Action Item references](https://github.com/nicolas-found42/chief-of-staff-demo/issues/359) | planned | Rename and duplicate-title fixtures keep correct target or explicit unresolved state; clarify ADR-0054 exclusion of Task dependencies. | — |
| MWR-049 | F11; firm keep | Keep Brief composition and delivery separate with eligibility rechecks and receipt/reconciliation; no shared Meeting lifecycle. | [E14](#e14) | [#362: feat: verify Brief freshness and independent delivery recovery](https://github.com/nicolas-found42/chief-of-staff-demo/issues/362) | planned | Actual application-path tests cancel/change eligibility after compose and recover external acceptance before receipt without blind resend. | — |
| MWR-050 | F11; firm | Give researched Brief context explicit freshness/provenance and separate generation/delivery measurements and human usefulness rubric. | [E14](#e14) | [#362: feat: verify Brief freshness and independent delivery recovery](https://github.com/nicolas-found42/chief-of-staff-demo/issues/362) | planned | Representative Briefs assessed for accuracy, relevance and uncertainty; no inference from Debrief metrics. | — |
| MWR-051 | F12; firm | Document approved routes, transcript-use authorization and actual provider retention behavior. | [E15](#e15) | [#356: feat: preserve Meeting context and enforce source lifecycle grants](https://github.com/nicolas-found42/chief-of-staff-demo/issues/356) | planned | Current authoritative route/terms evidence and owner permission recorded privately as appropriate; unknown retention stays unknown. | — |
| MWR-052 | F12, Stage 3; firm | Separate bounded metadata telemetry from private requests/responses; keep transcript text and credentials out of ordinary logs. | [E15](#e15) | [#356: feat: preserve Meeting context and enforce source lifecycle grants](https://github.com/nicolas-found42/chief-of-staff-demo/issues/356) | planned | Synthetic redaction/log inspection covers success, retries and failures; private artifact retention is explicit. | — |
| MWR-053 | F12; firm | Define deletion and backup/restore retention while preserving accepted Task provenance. | [E15](#e15) | [#356: feat: preserve Meeting context and enforce source lifecycle grants](https://github.com/nicolas-found42/chief-of-staff-demo/issues/356) | planned | Inventory after deletion and restoration matches contract, with tombstone/reingestion behavior tested and Tasks preserved. | — |
| MWR-054 | F12; firm keep/test | Treat transcript as untrusted evidence; keep authorization, promotion and state transitions in code. | [E10](#e10) | [#356: feat: preserve Meeting context and enforce source lifecycle grants](https://github.com/nicolas-found42/chief-of-staff-demo/issues/356) | planned | Synthetic instruction-like source cannot change policy, invoke tools or bypass completion rules; prompt text alone is insufficient proof. | — |
| MWR-055 | Stage 6; firm validation | Run three cold repetitions of all 20 Goldens on selected design, separately test Brief delivery and mixed-Module backlog. | [E08](#e08) | [#365: test: verify complete Meeting Wizard delivery and recommendation coverage](https://github.com/nicolas-found42/chief-of-staff-demo/issues/365) | planned | 60 cold outcomes retained with quality, completion, queue delay and cost; Brief/backlog checks have independent results. | — |
| MWR-056 | Stage 6; proposed threshold | Demo target ≥95% cold completion without manual retry and empirical p95 processing ≤5 minutes, no critical regression or preservation failure. | [E08](#e08) | [#365: test: verify complete Meeting Wizard delivery and recommendation coverage](https://github.com/nicolas-found42/chief-of-staff-demo/issues/365) | planned | Approved targets and measurement method specified in the operating-contract resolution; delivery must retain all failures and report queue delay; no workload guarantee. | — |
| MWR-057 | F4, Stage 6; firm measurement | Report total spend across failed and successful operations divided by successful completions, including all retries/repairs. | [E09](#e09) | [#363: feat: record complete private Meeting Wizard validation campaigns](https://github.com/nicolas-found42/chief-of-staff-demo/issues/363) | planned | Cumulative operation costs reconcile to attempts; estimates labeled; no resumed-only cost claim. | — |
| MWR-058 | §6 useful; firm measurement | Measure transcript token distribution, candidate density, duplicate-observation rate, repairs by validator, arrivals and dependency-path durations. | [E09](#e09) | [#357: feat: enforce shared model admission and cumulative operation budgets](https://github.com/nicolas-found42/chief-of-staff-demo/issues/357) | planned | Corpus/load report quantifies distributions and bottlenecks with source-free telemetry. | — |
| MWR-059 | §6 useful; firm measurement | Measure post-action-core failures and owner edit/dismissal/duplicate-resolution rates to assess incomplete-publication and handoff usefulness. | [E03](#e03) | [#361: feat: retain incomplete Debriefs and regenerate sections independently](https://github.com/nicolas-found42/chief-of-staff-demo/issues/361) | planned | Privacy-approved instrumentation/report covers real usefulness; no invented measurements or gate assumptions. | — |
| MWR-060 | §5, overall judgment; firm sequencing | Prioritize baseline, preservation/publication/promotion and identity before enabling simplification; finish through complete owner experience validation. | [E08](#e08) | [#365: test: verify complete Meeting Wizard delivery and recommendation coverage](https://github.com/nicolas-found42/chief-of-staff-demo/issues/365) | planned | Dependency-ordered delivery issues map all IDs, tests and migration requirements; one PR at a time, four exact-head checks and squash merge. | — |
| MWR-061 | F2, Stage 2; existing narrower safeguard | Preserve existing IDs and decisions on same-content retries/reordering; preserve accepted Task snapshots. | [E05](#e05) | [#355: feat: preserve Action Item identity and atomic Task acceptance](https://github.com/nicolas-found42/chief-of-staff-demo/issues/355) | implemented, tested, merged; not fully verified | Focused action-items/routes and Task tests pass; guarantee explicitly does not extend to semantic equivalence across Runs. | [PR #369](https://github.com/nicolas-found42/chief-of-staff-demo/pull/369), merged `3b7e2ce` |
| MWR-062 | Stage 1; existing narrower safeguard | Adopt a Task whose creation succeeded before its promotion link was recorded. | [E04](#e04) | [#355: feat: preserve Action Item identity and atomic Task acceptance](https://github.com/nicolas-found42/chief-of-staff-demo/issues/355) | implemented, tested, merged; not fully verified | Existing tasks-routes interrupted-promotion regression passes; broader process/disk fault testing remains MWR-006/007. | [PR #369](https://github.com/nicolas-found42/chief-of-staff-demo/pull/369), merged `3b7e2ce` |
| MWR-063 | F8; existing narrower safeguard | Validate cached response shape and semantic callback on read; do not repeatedly reuse invalid responsibility repair. | [E11](#e11) | [#361: feat: retain incomplete Debriefs and regenerate sections independently](https://github.com/nicolas-found42/chief-of-staff-demo/issues/361) | already satisfied | Existing candidate-accounting checkpoint and invalid-repair regressions pass; accepted-artifact versioning remains MWR-040. | Existing baseline; no new delivery PR |
| MWR-064 | F5; existing narrower safeguard | Preserve ordered bounded parallel work and settle active calls before retry after failure. | [E10](#e10) | [#357: feat: enforce shared model admission and cumulative operation budgets](https://github.com/nicolas-found42/chief-of-staff-demo/issues/357) | already satisfied | Existing candidate-accounting worker-limit/retry regressions pass; global cap and cancellation remain MWR-023/027. | Existing baseline; no new delivery PR |

## Inspected evidence and premise corrections

### E01

Ownership is consistent with ADR-0001/0002/0050/0052/0053/0061 and separate Module implementations. No broad behavioral re-proof performed here.

Primary code/document: [docs/adr/0050-the-workspace-owns-a-durable-meeting.md](../../docs/adr/0050-the-workspace-owns-a-durable-meeting.md).

### E02

TaskStore uses synchronous whole-list read/write and atomicWriteJson temp+rename, optionally a cutover state.json bundle. Runs artifacts still use direct writes. No fsync in atomic helper; Docker bind-mounts ./workspace. A one-process synchronous path is not proof of a universal concurrent-writer defect, nor power-loss safety. Actual filesystem guarantees and fault matrix remain unmeasured.

Primary code/document: [apps/server/src/tasks/store.ts](../../apps/server/src/tasks/store.ts).

### E03

module.ts storeResult writes result.json before materialization/review. planRecovery selects review on result/review file presence. Extraction assembles all enrichment before storing; regeneration calls full extract(ctx, record, false). No manifest/action-core publication contract found in this path. Crash defect not fault-injected in kickoff.

Primary code/document: [apps/server/src/modules/meeting-debrief/module.ts](../../apps/server/src/modules/meeting-debrief/module.ts).

### E04

promotion.ts already searches Task source.actionItemId and adopts an orphan before creating work. tasks-routes.test.ts covers interrupted promotion and deleted Task history; focused run passed. Broader fault durability is not established.

Primary code/document: [apps/server/src/tasks/promotion.ts](../../apps/server/src/tasks/promotion.ts).

### E05

action-items.ts hashes Run+normalized title/owner/date and collapses equal display tuples. Same IDs preserve stored records and decisions; new content increments extractionRevision. action-items-routes.test.ts covers reorder, unchanged retry, dismissal/promotion retention and Task preservation; focused run passed. No semantic ledger or opaque-ID allocation present.

Primary code/document: [apps/server/src/tasks/action-items.ts](../../apps/server/src/tasks/action-items.ts).

### E06

candidate-extraction.ts separately judges status, facts and responsibility with binding/reference validators. extraction.ts and shared handoff have explicit/inferred/unknown responsibility. Speaker/name evidence is consistency, not proof of obligation acceptance. Controlled tests do not establish live quality.

Primary code/document: [apps/server/src/modules/meeting-debrief/candidate-extraction.ts](../../apps/server/src/modules/meeting-debrief/candidate-extraction.ts).

### E07

auto-promotion.ts gates handoff-specific requirements with if (item.handoff && ...), allowing legacy records past that branch; default stages all, first-extraction/confirmed-owner/duplicate guards already exist. auto-promotion.test.ts passes including legacy-shaped fixtures. No live policy setting was read or changed. The responsibility investigation rechecked 67 existing tests and found that first-extraction eligibility depends on retained queue records (no zero-action marker), the handoff lacks a durable structured acceptance relationship, and the policy seam lacks snapshot/version/completeness/reconciliation receipts. See the investigation pointer above; these are inspection findings, not new verified behavior.

Primary code/document: [apps/server/src/tasks/auto-promotion.ts](../../apps/server/src/tasks/auto-promotion.ts).

### E08

Baseline is main bd80b089f401b4b1ea7486848742963022140385, merged delivery of prior latency work. Prior PR reports deterministic/browser/Docker evidence but no successful Solar gate. This kickoff ran only 130 focused controlled tests; no cold quality/cost benchmark or backup/restore. Review numeric goals are now approved targets, still unmeasured.

Primary code/document: [docs/agents/verification.md](../../docs/agents/verification.md).

### E09

runner.ts has per-Runner Promise queue. providers.ts enforces per-request deadlines and emits attempt/usage facts, not a demonstrated global admission or durable Debrief operation budget. Candidate windows/limits use characters and counts. No complete-operation timeline/cost reconstruction or cross-Module load proof found.

Primary code/document: [apps/server/src/llm/providers.ts](../../apps/server/src/llm/providers.ts).

### E10

candidate-extraction.ts keeps full-source later checks, broad discovery, final audit, late dedupe, four-worker phases and settle-before-throw. Prompts say source is untrusted. candidate-accounting.test.ts passes controlled accounting, reference, overlap and checkpoint behaviors. Exact early coalescing/consolidation/injection resistance require their own proof.

Primary code/document: [apps/server/src/modules/meeting-debrief/candidate-extraction.ts](../../apps/server/src/modules/meeting-debrief/candidate-extraction.ts).

### E11

candidate-extraction.ts cache hash includes scope/prompts/schema/temperature/reasoning; safeParse and optional semantic validator run on reads. Repairs without validator are not cached. module.ts treats invalid checkpoint JSON as absent. No accepted-artifact dependency/version layer found; timeout omission is deliberate, not necessarily stale-cache bug.

Primary code/document: [apps/server/src/modules/meeting-debrief/candidate-extraction.ts](../../apps/server/src/modules/meeting-debrief/candidate-extraction.ts).

### E12

matching.ts requires exactly one qualifying Calendar Meeting using filename/title/time plus speaker/mtime signals (2h named-time, 24h broad tolerance). Catalog sets meetingDate from filename; extraction.ts uses that date with UTC date-only references. Therefore mtime-to-extraction-date premise is not demonstrated. Association is consumed live; a versioned contextual snapshot is missing from extraction boundary. The association/time decision rechecked that title plus speaker can qualify without a time bound; filename parsing can add UTC to zone-less forms; transcript-backed display time can fall back to mtime/current time; Calendar attachment does not change Catalog meetingDate. The date clamp leaves proposed dates untouched without an anchor, and the Module re-reads identity decisions after model work. Current Meeting records lack an explicit meeting-timezone provenance field. The 58-test baseline supports existing behavior only; the linked resolution specifies the replacement and historical preservation.

Primary code/document: [apps/server/src/meetings/matching.ts](../../apps/server/src/meetings/matching.ts).

### E13

handoffNotes already renders explicit/inferred completion, responsibility, missing-input and dependency labels and suggested retrieval; promotion snapshots those notes. action-items-routes preservation test passes. Required inputs are plain strings and dependencies use actionTitle; stable target references and full structural provenance remain unimplemented.

Primary code/document: [packages/shared/src/handoff-notes.ts](../../packages/shared/src/handoff-notes.ts).

### E14

Brief module has snapshot/enrich/compose/deliver and delivery rechecks/reconciliation. gmail-delivery-provider tests passed deterministic Message-ID and fail-closed reconciliation checks. Complete delivery crash matrix, freshness policy and human usefulness evidence are still needed; related Person Profile issues are separate existing work.

Primary code/document: [apps/server/src/modules/meeting-brief-generator/module.ts](../../apps/server/src/modules/meeting-brief-generator/module.ts).

### E15

Provider captures and local Run artifacts exist; transcript deletion already writes tombstones before cascading and has explicit repermitting. Existing deletion is not proof of provider retention, ordinary-log privacy or restoration behavior. Actual provider terms/routes/source authorization were not researched or assumed in charting.

Primary code/document: [apps/server/src/transcript-catalog/deletion.ts](../../apps/server/src/transcript-catalog/deletion.ts).

## Specification work after approval

- Operating/release contract: resolved in the linked operating-contract decision above. Delivery must collect the specified evidence; admission, comparison and privacy tickets retain their detailed implementation contracts. The approved targets are criteria, not measured results.
- Identity/reconciliation: specified in the linked identity/reconciliation resolution above. Implementation must preserve exact mappings, explicit owner resolution, accepted work and legacy history; the publication, promotion, artifact and handoff tickets retain their downstream contracts. ADR-0078 already separates legacy resets from canonical decisions.
- Promotion: specified in the linked responsibility/promotion resolution and ADR-0083. Owner commitment/acceptance and explicit post-gate enablement are settled. Implement the supported-contract, first-extraction/history, no-backlog and dedicated audit gates; no live setting was changed by planning.
- Incomplete Debrief: decide which sections are required, what manual review/promotion is allowed on a checked incomplete revision, and how Run status remains truthful. ADR-0061 currently defines completion after full extraction and materialization.
- Handoff dependencies: ADR-0054 excluded Task dependencies in the first version; choose source/proposal references versus a new Task dependency product concept before implementation.
- Association/date: specified in the linked association/time resolution; implement evidence-based association, recorded/confirmed timezone, frozen context and explicit correction/migration. Source uses/routes, accepted-work preservation and deletion/restoration retention are settled in the source/retention resolution. Neither is a pending approval question.
- Extractor alternatives: design a conditional quality experiment, then obtain owner rollout choice from real measurements. No premature acceptance of Alternative A, rejection of useful current passes or automatic database migration.

## Continuation state — active execution

Original effort fixed point: `bd80b089f401b4b1ea7486848742963022140385`. Session fixed point and current
`main`: `635cc9e562906b5e5d6638a10568fce21f395b3c`, where PR #366 merged with all four main CI checks
green. Branch `codex/353-workspace-backup` carries the #353 capture/restoration workflow; its
exact-head four-check CI and squash merge are the immediate next step at this checkpoint.
#353 is assigned to nicolas-found42 and is the ready issue; #354 is its first native dependent.
All 64 rows retain their IDs and delivery owners.

Private execution evidence and original uncommitted-input copies are retained at
`/Users/Nicolas/.codex/meeting-wizard-delivery/2026-09-10/`. This is not a Workspace backup or proof
of restoration. Preserve the modified review, CONTEXT.md, ADRs 0080–0085, retention research and this
register. No saved-Workspace format/config/source migration or live inference has occurred.

## Exact continuation prompt

```text
Use $mattpocock-skills-codex:implement to continue the entire Meeting Wizard review delivery in
/Users/Nicolas/Documents/github/chief-of-staff-demo. Load the actual installed implement skill at
/Users/Nicolas/Documents/github/mattpocock-skills-codex/skills/engineering/implement/SKILL.md,
plus installed TDD/code-review/domain-modeling. No subagents. No grilling.

Read the complete review/critique/register/implementation prompt/retention research, CONTEXT.md,
AGENTS.md, docs/agents guidance, relevant ADRs including 0080–0085, canonical map #338, its appended
execution authority https://github.com/nicolas-found42/chief-of-staff-demo/issues/338#issuecomment-5624501698,
all settled resolutions and native delivery dependencies. All recommendations and proposed thresholds
are approved; remaining engineering and rollout choices are delegated. Planning-only, one-ticket,
owner-interview and wait-for-artifact-answers instructions are superseded, including historical prose.

Inspect live branch/HEAD/diff/untracked files/PRs/claims. Preserve all uncommitted inputs. Original
review fixed point is bd80b089f401b4b1ea7486848742963022140385. PR #366 implements #352 on
1d8f39dc010067fb6f19cb745153126549bfe1f9; verify live merge/CI state before acting. If still open,
finish exact-head four-green-check squash delivery first. Then begin/continue #353 and follow native
delivery dependencies #354–365. Do not stop at one PR or a completed map. All 64 MWR rows identify
primary delivery issues; broader publication/identity/policy/migration/live acceptance is outstanding.

The six-file #352 patch preserves existing Task state on orphan retry, refuses duplicate or
contradictory lineage with HTTP 409, and avoids false completed migration counts. Evidence: red/green
HTTP tests, 69 focused tests, 2,563 full-suite tests/222 files plus full static gate, six Task browser
journeys, separate clean Standards/Spec reviews. This is deterministic stored-history recovery only,
not real crash/migration/live acceptance. Evidence files are private under
/Users/Nicolas/.codex/meeting-wizard-delivery/2026-09-10/.

Keep every current required Debrief section including coaching. Prepare checked core immediately;
expose incomplete work on downstream failure/stop or explicit early review. Incomplete publications
are permanently review-only; later completion never restores eligibility. Preserve IDs, proposal/
evidence/decision history, original Task Acceptance and later edits/completion/Trash/deletion,
immutable source/context, trusted-occurrence-or-owner association and recorded/confirmed timezone,
source grants/deletion/restore fences and zero-action/first-extraction/policy receipts. Intact prepared
recovery needs no model calls; corrupt accepted artifacts require exact restoration or visible error.

Before format changes quiesce writers, inventory/back up and prove isolated restoration; never reset
the Workspace or regenerate the demo. Product model/provider stays configurable. Development set:
nex-agi/nex-n2.5-mini:free, deepseek/deepseek-v4.1-flash, nvidia/nemotron-3.5-lightning. Frozen #349
protocol: 69 baseline, 108 comparison and 180 final slots across models, separate Brief validation;
all within unchanged USD 100 cumulative campaign/USD 2 per Debrief allowances, conservative
reservations, no retry/restart/variant reset and existing source/route/account prerequisites. No new
live inference authority. Retain true human adjudication and missing/failure denominators. Alternative
A remains gated; current extractor fallback and Alternative B evidence triggers remain in scope.

Use vertical TDD at pre-agreed public Module/provider, Workspace/store, HTTP and owner browser seams.
Regular focused tests/typecheck, full suite per issue and complete gate before push, applicable
browser/container checks. Separate current-agent Standards then Spec working-tree reviews against the
fixed point, distinguishing pre-existing inputs. Summarize tracker writes and selected files/message
before commits; authorization already granted. One PR at a time, inspect diff and check/test/e2e/image
for exact head, squash --match-head-commit; no direct main push/bypass. Continue all independent work
before requesting only concrete external prerequisites. Update this register with actual delivered,
tested, merged and fully verified evidence; a closed decision map is not delivery.
```
