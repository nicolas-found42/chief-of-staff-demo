# LIVE-01 continuation — September 14, 2026

LIVE-01 remains open while the new extraction experiments and source-based human
review are completed. This record supplements, and does not replace, the
[original failure baseline](live-01-qwen-validation-2026-09-14.md).

## Scope and controls

The owner authorized implementation, bounded exact-model experiments, retrieval
comparisons and delivery. Every new inference request specifies
`qwen/qwen3.7-flash` through OpenRouter, Alibaba only, `allow_fallbacks: false`,
`data_collection: deny`, under the existing explicit non-ZDR exception. Current
model and endpoint metadata are retained per experiment. Reservations use the
highest advertised context tier: $0.20 input / $0.80 output per million tokens.
The same durable ledger retains the original $5 cumulative allowance and $2
operation control. No billing changes or purchases were made.

Private evidence root: `REPO/../../private-evidence/live-01-qwen-2026-09-14`.
Each continuation has a distinct directory, frozen implementation/corpus hashes,
route guard negative controls, requests, terminal outcomes and cost records.
Original manifests, failures and references remain retained. No stored Workspace
format changed, and no business Workspace was activated or modified.

## Changes and evidence

| Observed issue | Change and regression | Live disposition |
| --- | --- | --- |
| Separate-line speaker/timestamp headers lost responsibility evidence | Parse the immediately preceding header without changing source bytes or line IDs. Tests cover blank gaps, explicit labels, anonymous labels and colons in speech. | C01 reached responsibility validation with correctly recognized spoken evidence; further response defects remained. |
| Initial responsibility response could use unknown-with-bindings or header-only evidence | Apply a constrained initial response schema; unknown has empty names/bindings, evidence references spoken turns. Initial verification may still discover an executor named in speech. | C02 passed responsibility checks; it later failed deduplication. |
| Fact verification returned incomplete accounting | Constrain response length and candidate-ID enum, while retaining duplicate/support validation and refusing invented dispositions. Tests reject missing/unknown IDs. | C03 passed the fact checks, then failed on an upstream shared-pool rate limit. |
| Relationship verification and its repair both cited header lines | Constrain initial and repair citation fields to actual spoken source IDs. A regression reproduces the repeated invalid citation, then requires a valid first response. | C06 recovered the previously unresolved document-review commitment. A different relationship still had incorrect acceptance evidence and remained unresolved; completion alone did not pass quality. |
| TED browser exceeded 100 resources while waiting for background requests | Read at DOMContentLoaded, then abort/close/drain resources. Existing network, size, time and redirect limits remain. A held-resource regression proves snapshot does not wait for unrelated work. | Packaged browser retrieved all three selected sources. Fourteen containment groups passed with zero forbidden destination requests and one positive-control request. |
| Valid source IDs in handoff details lost their support during normalization | Resolve exact spoken line IDs before literal grounding, ignoring model-supplied speaker metadata. Invalid/header references still produce no support. Regression and retained-answer replay cover the loss. | Nine supported details in four retained answers resolve to literal transcript text, with zero new inference. |
| Resumption reference disagreed with extraction categorization | Owner explicitly requires both an Action Item and a Decision. New private reference records that judgment, exact source spans and assistant-authored paraphrase/attribution provenance. | Owner also confirms that the later editing commitment covers both pricing rows. The owner also confirms that the clarified narrative/presentation separation must be a Decision. These are three specific judgments, not a complete semantic review. Other thresholds remain. |

Further issue-to-evidence links:

| Observed issue | Regression and scoped change | Latest measured disposition |
| --- | --- | --- |
| Small future obligation missed in broad discovery | Focused sections retain complete boundary turns and the broad audit; regression verifies complete coverage and recovery of a small commitment. | C08 retained the future obligation with its event trigger; C09 reached the same checked obligation before transport failure. |
| Status discarded a future-triggered obligation as insufficiently immediate | Explicitly distinguish completed preparation from a later committed check. | Recovered in C08; no invented calendar date. |
| Earlier model judgments biased role and overview checks | Remove provisional role/status explanations from role input and all candidate dispositions from overview input; synthetic regressions inspect those boundaries. | Reviewer recovered in C09, but pricing role still wrong; further diagnostic blocked by HTTP 429. |
| Adoption confused with implementation completion | Direct adopted/not-adopted response, normalized to existing internal states; positive pending-implementation and negative unagreed-proposal regressions. | Two diagnostic calls passed; C09 did not reach final Decision sections. Full-case evidence is pending. |
| Duplicate list omitted a repeated obligation | Require one match/no-match per candidate, normalize complete chains into groups, then retain existing source/fact reconciliation. Missing, repeated and cyclic mapping regressions pass. | Two diagnostic calls passed; complete affected-case rerun pending. |
| Header metadata could support a Decision through literal fallback | Reject speaker-header metadata while preserving genuine unlabelled prose; both cases have regressions. | Local checks pass; C09 did not reach final Decision sections. |

The earlier same-model diagnostic flag for unsupported handoff purpose concerned
content explicitly marked `suggested`, with no factual source claim. The output
contract allows suggestions. Preserve that flag as diagnostic history; it does
not establish an unsupported factual assertion. Other semantic findings still
require source inspection and human adjudication.

## Separately frozen extraction experiments

| Experiment | Implementation | Protocol | Outcome |
| --- | --- | --- | --- |
| C01 | `360ca501aeb75a1bc6e141b00c7b72b8e2b75a15` | One affected case, serial calls, no repair/recovery | Failed responsibility validation; three of five rows invalid, rather than the generic error count of eight. Ten live requests; $0.00861984882 reported cost. |
| C02 | `dd501d63da0cfd36dd219bed56642e688317d5a8` plus frozen private diff `03ff004018de9d9eb4171a129fe873bb63dc56309e3b9f00957683dd14ebd7bf` | Exact-request replay, then live; no repair/recovery | Passed responsibility checks, failed deduplication. Two of four groups combined conflicting responsibility facts. Twelve live requests; $0.00838709982 reported cost. |
| C03 | `00183f6a94fe1cfcbf2432d6f541268134dd8c96` | Exact-request replay, then live with existing bounded validator repair; provider retry veto retained | Nine calls completed; the tenth received Alibaba shared-pool HTTP 429. No complete extraction. $0.00587830122 reported plus $0.007346 estimated/unverified. |

C03 is a new recovery protocol, not a relabeling of C01/C02 as passes. Replayed
requests must match system, user, schema, temperature and generation limits
exactly; their source hashes and request hashes are recorded. They pass through
the current validators. Replays are not fresh independent model samples.
C04 continues the affected case after a separately recorded two-minute cooldown for the C03 shared-pool rate limit. It rechecks model availability and reuses exact successful request artifacts; it does not retry within a provider call or change routes.

C04 produced a complete output (four actions; all seven sections available), but failed quality: Golden decisions 0/3, actions 3/4, questions 1/2. Source inspection found a wrong executor, a missing future freshness check, and adopted decisions rejected because implementation was incomplete. Cost: $0.00824992146 reported, no estimated charges. New prompt corrections address those source-grounded failures without changing reference floors.

C05 stopped after two successful responsibility calls, a shared-pool 429 and two routing 404s. Process-wide route rest added the sole allowed endpoint to `provider.ignore`. C06 adds an experiment-level stop after 429/404 and a fifth negative control rejecting that self-excluding route. The production route-rest default is unchanged. C05 reports $0.00121587444 provider cost and $0.0235806 estimated/unverified; final reconciliation is authoritative. C06 evaluated the prompt, relationship-state and detail-grounding fixes on the affected case. It completed all seven sections in 944,765 ms using twenty live calls, costing $0.01382295816 reported and zero estimated charges. Quality still failed: Golden decisions 1/3, actions 3/4 and questions 1/2. Both editing responsibilities were unknown despite the source commitment confirmed by the owner. The later freshness check remained absent.

Serial pacing begins before the provider timeout starts and waits ten seconds
between completed calls. The 30-second wire-idle boundary and 300-second call
ceiling remain unchanged. Each tranche has a finite request/wall-time limit.

The later source-only responsibility change removes provisional role and status
rationales from the independent verifier input, retaining the obligation and
source occurrences. Decision verification also stops receiving assembled actions
that biased it toward judging implementation instead of adoption. Regressions
cover both input boundaries.

A separately frozen two-request discovery probe found the missed future refresh
in a 4,000-character section but not an 8,000-character section. This is diagnostic
evidence, not a population-level recall estimate. C07 consequently divides each
existing discovery window into sequential 4,000-character sections, including
boundary turns whole, before the original broad coverage audit. This increases
calls for longer transcripts without increasing concurrency or reducing the
existing source limit. A regression covers a missed obligation, complete section
coverage and preservation of the broader audit.

C07 freezes all these changes against `a1d0c91d4c2d26efc07fc4f45ec6d633fb1c3da3`
plus retained diff `11eb731ff106bd8b605903eeff7c95886f08d37444c17713484be0d7a8df7b13`.
It completed all seven sections in 1,696,609 ms, with 35 live requests and
$0.02548835982 reported charges, zero estimated. Golden scores were decisions
0/3, actions 2/4 and questions 1/2. It failed quality: discovery recovers the future refresh, then status excludes it
using an invented immediacy cutoff. Responsibility verification also misapplies
the editing-suggestion caveat to a promised document review. These retained
answers are the failing examples for C08, which explicitly retains future
triggered obligations and matches review/edit promises to the corresponding
executor. C07 found 38 candidates versus C06's 11, increasing verification work;
a larger candidate list is not itself a quality gain. The two matched actions were
the review and rebuild. The pricing action's generic title lost the reference's
custom/portfolio scope even though its Decision named both rows; the reference
was not broadened to hide that loss.

C08 also removes provisional candidate/disposition text from overview generation.
A regression reproduces loss of an adopted choice when unfinished action
classifications are supplied to either overview or decision verification. C08
freezes against the same `a1d0c91` base plus diff
`5b1bb2d467839b04f3d77590de78d7531297a8e483dd5e7382901f91cb69d1c5`.
C08 completed all seven sections in 1,767,636 ms with 38 live requests and
$0.0253818873 reported charges, zero estimated. It still failed: the future
refresh is retained, but review responsibility is unknown, both pricing actions
name the proposer incorrectly, an extra comment action survives, and one pricing
title substitutes the advisory retainer for the custom program. Adopted scope
is still filtered as pending work. A speaker header also passed as Decision
evidence; a subsequent regression reproduces and fixes that fallback while
preserving genuine prose with unknown speakers.

Subsequent small diagnostics test property ordering, removal of duplicate name
fields, a flat responsibility enum and a shorter instruction. None of the first
four resolves the responsibility failures, so they are not promoted as fixes.
They share the exact model/route and durable ledger. Their plans freeze runner,
source-request and schema hashes but omitted the repository HEAD field; a
post-dispatch check establishes that the provider/grant code is unchanged from
`a1d0c91`. They remain diagnostics, not acceptance evidence. Any acceptance rerun
must freeze the complete implementation before dispatch.

The later deduplication input change removes prior role/status explanations,
retaining the outcome, timing and evidence. Existing code still independently
reconciles differing roles before accepting a merge. Those earlier checks passed 3,124 tests in 266 files and 122 browser tests.
They apply only to the implementation measured at that time.

Two subsequent diagnostics established useful response contracts. Executor
bindings express the source finding and each person once; code derives the
existing responsibility fields, validates each binding with its own basis and
retains compatibility with older responses. Decision verification asks whether
the choice was adopted, independently of whether implementation is complete. A
negative control rejects an explicitly unagreed suggestion. Synthetic
regressions cover both contracts, source grounding and legacy parsing.

C09 freezes these changes for the affected case, including the header-grounding
fix and the clarified overview instruction for confirmed design requirements.
Its `pnpm run check:all` passed 3,130 tests in 266 files and all 122 browser tests.
The rebuilt image passed isolated health and fourteen containment groups, with
zero forbidden destination requests and one positive-control request. The
created Compose services were removed. C09 failed before completing output generation; the small successful
diagnostics are not a complete acceptance pass.

C09 subsequently exposed an unconstrained duplicate-repair evidence field: the
model supplied a timestamp instead of the requested spoken source ID. That
particular timestamp resolves uniquely through the existing compatibility path,
so it did not itself fail the C09 validator. A regression now
requires that the actual request schema reject that reference while accepting a
real source line. Both initial and repair duplicate schemas now constrain the
candidate IDs and spoken evidence vocabulary; 79 candidate-accounting tests
and typechecking pass. This later change is outside the frozen C09 implementation.
The C09 coverage gate also passed, independently of live semantic quality.

## Browser coverage and limits

The TED failure reproduced at 100 resources. An optional-media filter trial still
failed and was not promoted. The document-ready snapshot trial succeeded at 98
resources. Comparisons cover the selected Wikipedia biography, Open Library
metadata and TED talk via ordinary browser, HTTP and the production sandbox.
Expected source passages remained present. Fully hydrated TED controls differ
from the DOMContentLoaded snapshot; this is not a promise to wait for arbitrary
late page updates. Public HTML working copies were reduced to bounded excerpts,
with original hashes and byte counts retained. No safety ceiling was raised.

## Verification and delivery

At `00183f6a94fe1cfcbf2432d6f541268134dd8c96`, `pnpm run check` passed 3,118 tests
in 266 files, plus typecheck, lint, formatting, knip and workflow validation.
`pnpm run test:e2e` passed all 122 browser tests. Production Compose build and isolated health check passed. The final image also
passed all fourteen browser containment groups. Created Compose services were
removed. Browser and live artifacts are in `continuation-browser/` and
`continuation-03/` under the private evidence root.

[PR #416](https://github.com/nicolas-found42/chief-of-staff-demo/pull/416) contains
the surgical fixes and synthetic regressions. Its description disables automatic
CodeRabbit reviews with `@coderabbitai ignore`; a successful automation status is
not a human or model review claim. The four required checks passed for `00183f6a94fe1cfcbf2432d6f541268134dd8c96` in CI run `34900833465`. Documentation delivery and merge still require checks for their own current head.


C09 froze base `a1d0c91d4c2d26efc07fc4f45ec6d633fb1c3da3` plus diff
`dd34e2deaf46b341fd261669274ccdc3454ebf7f1bd6f35bf31ab18abdb055ce`.
It stopped on request 22 after 968,873 ms with Alibaba shared-pool HTTP 429
(`limit_requests`, no Retry-After). Further dispatch stopped. There was no
complete output: Golden failure means incomplete extraction, not a complete
semantic assessment. Twenty-one successful live calls cost $0.01327904622;
the failed call reserves $0.0078556 estimated/unverified. Intermediate evidence
still showed wrong pricing responsibility and incomplete duplicate grouping.
The full local check and coverage gate passed, which does not resolve those
live failures. Two two-request diagnostics were prepared under the same ledger;
they require a fresh availability check and a separately recorded cooldown.


The total-duplicate-mapping diagnostic completed two live requests after fresh
availability metadata and a recorded cooldown. All twelve retained candidates
were accounted for, with five distinct outcomes; the previously omitted rebuild
was matched. A separate four-candidate control preserved two different document
rows and grouped only their repeated descriptions. This did not repair the
incorrect pricing scope in the input facts. The implementation converts these
complete mappings into groups for the existing fact reconciliation, rejecting
missing IDs, repeated IDs, forward/cyclic links and matches without evidence.
All 82 candidate-accounting tests passed, including legacy response compatibility.

The separate diagnostic removing provisional evidence from responsibility input
received another Alibaba shared-pool HTTP 429 on its first call. Its second slot
was blocked before dispatch. That hypothesis has no result and was not
implemented. A fifteen-minute cooldown was selected before further exact-route
checks; no model or provider fallback is permitted.


After the total mapping change, `pnpm run check:all` passed 3,133 tests in 266
files and all 122 browser tests. `pnpm run test:coverage` passed the configured
floors (86.31% statements, 76.29% branches, 88.70% functions, 88.53% lines).
The rebuilt image passed isolated health and its Compose services were removed.
Private `continuation-duplicate-map-probe/local-verification.json` binds these
measurements to the checked source-file hashes; they are not a live quality pass.


After the fifteen-minute cooldown, a separately frozen repeat of the evidence-
removal diagnostic completed both calls. It failed the hypothesis: one answer
added the proposer as an inferred co-executor, and the other again selected the
proposer alone. The evidence-removal change remains unimplemented. Source-name
presence is necessary but does not establish that the person undertook the work;
a direct assessment of that distinction is the next bounded diagnostic.


The executor-support diagnostic completed two calls and passed its declared
checks: the retained reviewer and rebuild performer were supported, the pricing
proposer was rejected, and the synthetic proposer/editor control separated the
two roles correctly. This check now sends unsupported bindings through the
existing bounded repair. Repaired bindings must pass again before being cached.
A regression reproduced the stale semantic-repair cache and then passed, along
with corrected and still-unsupported cases. This adds model calls for nonempty
bindings; exact-request checkpoint reuse remains available. C10 is the planned
complete affected-case experiment for these and the duplicate-mapping changes.


C10 freezes base `a1d0c91d4c2d26efc07fc4f45ec6d633fb1c3da3` plus diff
`63d62eed8795cc82c28d0352f9a1c71f01b97914cc7ac3dfc9724c2cc0ac05cc`,
corpus `d5cb6da0451a8764a004ce4a74206b559568796f2430cc3c24ecec312fcdb848`.
Its full local gate passed 3,136 unit tests and all 122 browser tests, and the
rebuilt image passed isolated health before removal. The experiment uses the
existing 100-request cap and 45-minute dispatch window. An already dispatched
request remains subject to the existing 300-second ceiling, so that window is
not a hard process-kill deadline.

During C10 inspection, a repaired executor was correct but its binding still
cited the earlier suggestion. A later support check found the actual commitment,
but that evidence was not carried into the displayed action. A synthetic case
with only the suggestion in the earlier facts reproduced the loss; the fix adds
grounded positive-support evidence to the binding before assembly. All 86
candidate-accounting tests pass. This code change is later than C10's freeze and
requires a new affected rerun; C10 cannot be credited with it retrospectively.


The post-C10 evidence-carrying fix passes `pnpm run check` with 3,137 tests.
Its first synthetic fixture already contained the commitment and did not
reproduce the loss; the revised source-supported fixture did reproduce it and
then passed after the fix. Both results are retained. The private verification
record binds this later check to source-file hashes and does not reuse C10's
image or live measurements as proof for changed code.
