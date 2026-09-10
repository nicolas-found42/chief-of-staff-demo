# September 9 Meeting Debrief latency investigation

Observed run: `run_20260910-140016_b8c66a61`. Private transcript and model replies remain in the ignored Workspace. This report contains operational measurements only.

## Final outcome

The September 9 meeting completed with `inception/mercury-2.5` at 15:41:49.867 UTC. The saved debrief contains 17 pending Action Items, three decisions and three open questions. The browser visibly showed “Debrief ready” and “Review 17 action items”. No review approval or outward communication was performed.

The final resumed attempt began at 15:40:58.005 UTC and completed in 51.862 seconds, reusing 34 completed model requests. It made 21 new provider attempts with reported cost USD 0.02565506394. Its candidate ledger accounts for 61 provisional observations and 17 retained actions. This is a recovery measurement, not a cold-run benchmark; earlier Mercury attempts and the original GLM run are not included in that time or cost. The final-coverage stage had already succeeded in 10.924 seconds on an earlier retry, compared with two 90-second silent-progress failures in the original run.

Final local verification: `pnpm run check` passed 2,509 tests across 217 files plus TypeScript, lint, format and Knip. The focused accounting suite passed 51 tests. The Meeting-page browser regression passed, and the production Docker image was rebuilt and booted. The final saved result and browser view were verified directly. The separate Solar prompt-evaluation release gate was not run, and these changes remain local within the existing working tree; this report does not claim a merged release or a fresh-run latency guarantee.

## Original failure

The run began at 14:00:16 UTC and failed at 14:29:57 UTC. A one-off ingestion process exited before its queued extraction settled; the server recovered it at 14:00:19. This explains an abandoned first discovery request, not the subsequent half-hour critical path.

The recovered GLM run discovered 89 candidate observations. Candidates are provisional, not approved Tasks. Nine groups of at most ten were classified and verified serially. Responsibility checks ran after each group, with seven semantic repair calls. Deduplication and individual enrichment were later stages, so repeated observations incurred verification cost before deduplication.

Artifact modification times give this approximate stage breakdown (includes time spent in provider retries):

| Stage | Requests | Elapsed seconds |
| --- | ---: | ---: |
| Discovery | 5 | 56.7 |
| Source coverage | 5 | 87.9 |
| Source status | 9 | 368.0 |
| Fact verification | 9 | 656.7 |
| Responsibility including repairs | 16 | 427.0 |
| Final coverage, two timed-out attempts | 1 logical request | about 180 |

There were 47 provider attempt events: 44 successes, two retrying failures, one terminal failure. Successful attempts reported 1,135,260 input tokens, 153,316 output tokens and USD 0.1755621252. These are provider-reported usage totals, not a billing reconciliation; failed calls may have unreported charges.

Most later requests repeated the complete transcript with high reasoning effort. The failing final audit contained 228,253 user-message characters, of which 135,209 were the disposition ledger. Repeated literal source quotations contributed to this expansion.

The terminal timeout was the 90-second stream progress ceiling, not the 300-second absolute request ceiling. HTTP 200 and approximately 5 KB of traffic were observed, but no usable progress before the timer expired. An automatic same-binding retry also timed out. HTTP success alone did not prove useful semantic progress or acceptable total latency.

## UI explanation

The Meeting read model reports saved pending Action Items. Materialization occurs only after the entire extraction validates. While extraction was running, zero saved records rendered as “Review 0 action items,” suggesting a completed empty result. The Transcript association was correct; the final extraction did not exist.

## Changes

- Independent discovery windows, candidate batches, and retained-action enrichment use a maximum of four concurrent workers. Dependent checks within a batch remain ordered. Results retain source ordering. A failure stops scheduling new work and drains active workers before returning, avoiding artifact writes racing a subsequent retry.
- Exact-request checkpoints preserve successful schema-validated responses. Keys incorporate provider/model scope, prompt, user context, schema, temperature and explicit reasoning effort. Replays pass schema validation and all downstream semantic checks. Regeneration deliberately avoids checkpoint reuse.
- Stage progress events identify started, completed and reused calls, with durations for completed calls. Logs contain stage metadata, not transcript text.
- Final coverage uses immutable source IDs in place of uniquely identifiable repeated quotations. Literal evidence remains in stored output; ambiguous excerpts stay literal.
- Meeting detail displays “Extracting action items…” during a first extraction, and an unavailable message after failure, instead of treating zero as a completed count.
- Mercury exposed blank source-line citations: blank lines no longer receive displayed evidence references. Original spoken-line IDs remain stable.
- Mercury also returned a bare discovery array. The discovery-only compatibility path restores its one-field envelope, then applies the unchanged strict schema. Other malformed shapes remain errors.

No evidence checks were removed, no candidate limit was lowered, and no provisional candidates were promoted as a substitute for a finished extraction. These changes reduce critical-path latency and retry waste; they do not prove the model's semantic accuracy or guarantee a fixed completion time.

## Reproduction and verification

The production MeetingDebriefHost test seam reproduced serialization with 11 candidates: maximum simultaneous classification calls was one. A second test injected a late overview failure and demonstrated that discovery was repeated on retry. Both failed before their fixes and passed after them. Additional regressions cover literal evidence preservation, blank evidence references and Mercury's discovery envelope.

Browser regression exercises processing, failed and ready counts on the real Meeting page. Processing/failed states show no “Review 0 action items”; a completed result can legitimately show zero.

The initial full gate passed 2,502 tests; the blank-line revision passed 2,503. Final verification and live Mercury outcome must be recorded separately rather than inferred from these earlier checks.

## Live retry caveat

The app configuration changed from GLM to `inception/mercury-2.5` before the first fixed retry. Provider/model-scoped checkpoints correctly refused the earlier GLM replies. Mercury failed rapidly on blank evidence references, then on a missing discovery envelope. These are distinct model-output failures, not repeats of the 25-minute serialization defect. The user explicitly selected Mercury for continued testing.

### Continued Mercury verification

The later retries exposed semantic repairs citing nonexistent/blank source lines or expanding a nickname to a full-name responsibility without literal identity evidence. These outputs were rejected. Repair prompts now identify invalid evidence and explain literal-name versus inferred-role handling. Batch names in status/responsibility failures distinguish the failing worker from other workers that finish while the pool drains.

Checkpoints must not trap retries on a schema-valid but semantically invalid repair. Repair checkpoints are now enabled only for stages supplying a semantic validator; that validator runs both before writing and when reading a repair. Unvalidated repairs are never cached. Regression coverage proves that an invalid repair gets a fresh provider response on retry and that a validated responsibility repair survives a later overview failure without a repeated provider call.

The complete static/unit gate passed 2,505 tests across 217 files before the final semantic-checkpoint refinement; the focused 47-test accounting suite passed after that refinement. The browser regression passed for processing, failed and completed-zero states. Docker was rebuilt and booted with the changes. Live completion and final gate outcome remain separate requirements.

The status repair now sends a constrained provider output schema whose evidence enum contains only spoken source IDs. The parser retains compatibility with existing captured literal replies; the live provider receives the narrower grammar. A regression verifies that a blank-line reference is rejected by that schema and a real spoken-line reference is accepted. For transcripts without parsed speaker turns, the original schema remains available. With this change, Mercury passed the repeatedly failing status-50 repair in 8.8 seconds on the 15:27 UTC retry and reused 25 prior requests.

Final static/unit verification after these changes: `pnpm run check` passed, including 2,506 tests across 217 files, TypeScript, lint policy probes, formatting and Knip. The production Docker image rebuilt and booted. These are local verification results; they do not constitute the repository's separate Solar prompt-evaluation release gate or a merged PR.

Responsibility repair also receives an output schema separating explicit, inferred and unknown bindings. Explicit bindings enumerate source IDs that satisfy the existing source-speaker/name test; inferred bindings still require grounded spoken source IDs, and unknown bindings contain no names. The runtime validator remains authoritative because a provider can return output violating its requested schema. A live Mercury reply did this for one binding, and was rejected.

A further regression reproduced repair instability: the model was asked to rewrite every responsibility row, allowing an already-validated assignment to become invalid while another row was repaired. Responsibility repair now scopes its request and schema to the invalid rows and merges validated replacements into the untouched valid rows. Missing/duplicate/extra IDs still require full accounting repair. The new two-action test failed before this change and passed afterward; the focused suite now contains 49 passing tests.

The 15:34 UTC Mercury retry passed the previously failing final coverage audit in 10.9 seconds, then reached deduplication in approximately 80 seconds. Deduplication rejected timestamp-shaped references such as `@line:17:42`. Evidence resolution now recognizes that form only when the timestamp exactly and uniquely identifies an original source turn. It never treats a timestamp as an integer line number or selects a nearby turn. Regressions cover successful exact resolution plus ambiguous and nonexistent timestamps; the existing invalid-reference fixture now uses a nonexistent timestamp. The focused accounting suite has 51 passing tests.
