# Person Profile LLM cost cut — Steps 2–6 outcomes (issue #381)

Step 0 (measurement harness) and Step 1 / R1 (validated Extraction Part reuse)
landed first, on `677be28`. This records what each later step's own gate
measured and why it was built, corrected, or skipped — per the issue's own
rule that a step whose measurement shows no opportunity is skipped rather
than built anyway, and that zero opportunity is a valid, reportable outcome.

## Step 2 — Pipelining (R2): built, narrowly

Reading `PersonResearch.run`'s per-source pipeline (`research.ts`) found the
read batch already overlaps reading and extraction: each selected source runs
as its own independent worker (`mapLimit` with worker count equal to batch
size), a read releases its `SourceScheduler` slot before extraction begins,
and there is no all-reads-then-extract barrier. Building a pipelining layer
on top of that would have re-implemented what the existing worker structure
already does.

What the same reading found instead: the four-permit `WorkLimiter` that
should gate only model calls wrapped the *entire* per-source pipeline —
retaining the source, the whole Extraction Parts loop, publication through
the shared `PublicationGate`, and post-publish bookkeeping. None of that is
model work, so a fifth ready source's model call could not start until one of
the four in-flight sources finished retaining, publishing, and checkpointing
— work with no model dependency at all. This is the exact invariant R2 names
("correct permit lifetimes so a model permit is never held during unrelated
work"), already violated on the current code, independent of any new
pipelining logic.

**Fix landed:** the model-work permit now wraps only the individual model
call each Extraction Part spends (`research.ts`), matching the shape the
planner call already used. See ADR-0092. Proven with a hard-invariant test
(`tests/src/modules/person-research-speed.test.ts`) asserting that five
concurrent sources are all retained and checkpointed even while every one of
their model calls stays open — which plateaus at four under the prior code.

Zero fewer model calls; the saving is bounded critical-path idle no longer
spent waiting on an unrelated document's disk I/O or publication turn.
Nothing broader (capacity increase, in-document part parallelism) is
justified by this measurement and none was built.

## Step 3 — Provider exact-prefix input caching (R3): built, from a live measurement

The Workspace owner authorized a live measurement this session
(`scripts/debug/mercury-prefix-cache-probe.mts`, kept as a permanent
diagnostic alongside the existing `scripts/debug/mercury-timeouts.mts`).
Using the real `OPENROUTER_API_KEY` and the production `makeCompleteJson`
seam, unmodified, the probe sends an identical ~13,000-token prefix three
times in a row and records each call's `cachedInputTokens` and `costUsd`
from the provider's own reported usage.

**Five runs, 15 calls total, exact same script and prefix throughout.** Two
early exploratory runs (identical construction to what is committed) each
showed one cache hit: one run's third call reported `cachedInputTokens:
11406` of 13,027 input tokens (87.5%) at `costUsd: 0.000152`, a 73% charge
reduction against that same run's uncached calls (`costUsd: ~0.00056`); a
second run showed a hit on its *first* call instead (residual cache from the
prior run), then two immediate misses. Three later runs of the exact
committed script — used to confirm the numbers above are reproducible by
the committed artifact, not an artifact of a script since edited — recorded
**zero** hits across all nine calls. Total: 2 hits in 15 calls.

**What this measures, precisely:** OpenRouter + `inception/mercury-2.5`
*can* and *does* serve automatic exact-prefix input caching with real,
substantial billed savings (73% on the observed hit) — support is real, not
hypothetical, and no request-shape or transport change is required to get
it. But the hit rate observed this session is low and inconsistent (roughly
2 in 15 calls), consistent with OpenRouter's documented non-sticky route
selection across upstream backends (`apps/server/src/llm/providers.ts`'s own
comments on `sort: "throughput"` route diversity): a repeated exact prefix
only benefits from the provider's cache when it happens to land on the same
upstream route as its predecessor, and nothing in the current request pins
that.

This settles R3's gate more precisely than the two conflicting measurements
this doc previously cited from other research files, and supersedes them:
**the provider supports automatic caching and the discount is real when it
lands, but it is not reliably applied under the current, unpinned routing.**
Per R3's own text ("dollars only — never reported as a call reduction") and
"request bytes unchanged initially," no transport, routing, or prompt
change is warranted this release. Raising hit *consistency* would mean
pinning a route — that is R4 territory (route tuning), which the owner did
not approve this session, and this measurement is exactly the trace a
future R4 route trial should start from.

**What was built:** the one legitimate remaining action — making the
already-recorded cache utilization visible in the existing Step 0 report,
regardless of how often it fires. `ModelTimelineEntry.cachedPromptTokens`
was already captured per call but never aggregated; `CallSiteCostSummary`
(`apps/server/src/llm/decision-summary.ts`) now carries a `cachedTokens`
field summing it per call site, alongside the `dollars` field that already
reflected the discount automatically (the provider's own `usage.cost` is
billed net of any cache hit). Proven with a new `summarizeCallSites` test
(`tests/src/unit/decision-summary.test.ts`) asserting the sum treats a
missing or null `cachedPromptTokens` as zero.

The ZDR/data-collection question this doc previously raised as a blocker
does not apply here: no request bytes or routing changed, so no new
data-collection surface was introduced.

## Step 4 — Same-model route tuning (R4): skipped, no comparison exists

ADR-0071 already documents the one route preference in force
(`preferred_min_throughput: 50`, opt-in, a preference not a pin) and the
measurement that justified it (#232: losing routes ran at 24–28 tok/s against
66–75 tok/s on completing routes). R4 asks for "one same-model route
experiment at a time," comparing realised charge, first-evidence time, total
runtime, and failures against the current preference — that comparison does
not exist yet for any alternative route, and producing one means dispatching
real paid extraction traffic against a live workload and holding schema,
binding, and input fixed while only the route preference changes: a live
experiment, not a code change. The Workspace owner did not approve Step 4
this session (approval covered Steps 2, 3, and 6 only).

**Skipped.** This is the natural next use of the Step 0 decision-summary
module — now including the `cachedTokens` field Step 3 added — once the
owner wants to fund a route trial.

## Step 5 — No-op purpose separation (R5): built

Claim extraction (C1) and dossier extraction (E1) shared one Settings purpose
(`personResearch`) before this change — `createPersonClaimExtractor` was
wired to the same `complete` function `PersonResearch` itself used. A new
`personProfileClaims` purpose is added (`MODEL_PURPOSES`,
`PurposeModelsSchema`), wired independently in `composeShell`
(`completeForPurpose("personProfileClaims")`) and passed to
`createPersonClaimExtractor` via a new optional `completeClaims` composition
dependency that falls back to the shared `complete` when absent.

Proven as a no-op two ways (`tests/src/unit/config-store.test.ts`): a
Workspace with no purpose overrides resolves both purposes to the same base
model; a Workspace that had already overridden `personResearch` before this
purpose existed keeps answering claim extraction with that same model — the
override is seeded into `personProfileClaims` once, at load, and persisted,
not re-derived from `personResearch` on every read, so a later change to
`personResearch` alone cannot silently move claim extraction with it. See
ADR-0093.

## The model directive: OpenRouter defaults to `inception/mercury-2.5`

The Workspace owner directed that `inception/mercury-2.5` serve every LLM
call. `DEFAULT_MODELS.openrouter` changed accordingly, and
`defaultModelPriceEvidence()` gained the price row the change requires (a
budgeted call to a model with no price row throws
`UnknownModelPriceEvidenceError`).

**This is not R6's paired-evaluation trial gate satisfied** — R5/R6's own
text requires changing "one stage's model" at a time, each "gated on paired
evaluations at equivalent accepted work," kept "only on measured all-in
improvement." No paired evaluation ran; every purpose changed at once, not
one stage. What happened instead is the owner exercising decision authority
to choose the model outright, superseding the trial process rather than
completing it. R6's own gate — a stage-specific model trial against the
fixed acceptance pair — stays open and unmet; record it that way, not as
R6 done.

See ADR-0094 for the full decision, including the consequence it knowingly
accepts (the evaluation judge, which has no explicit override in the live
Workspace, now also resolves to `inception/mercury-2.5` — the same model as
the extraction under judgment) and the one-line Settings reversal if the
owner wants an independent judge back.

## Step 6 — Residual re-rank (R7–R14): investigated, nothing cleared the bar

Every remaining candidate from the questionnaire's ranked list was read
against the code this session landed (Steps 1, 2, 5) — no live traffic,
static code-shape questions only, plus one throwaway micro-measurement for
R13 (deleted afterward, no source file touched):

| Candidate | Finding | Verdict |
| --- | --- | --- |
| **R7** — C1 exact-result reuse across bootstraps | No reuse seam exists for C1; an identical `(result text, signals)` pair can recur across bootstraps (the search layer already dedupes/caches app-wide) but nothing at `createPersonClaimExtractor` reuses a prior answer. | Skip — medium-high risk, needs freshness/exact-context qualification the same way R1 did, not built this session. |
| **R8** — Trial E1's structured-wire options on C1 | Real gap: C1 sends no `preferredBinding`, `temperature`, or `compactWireNames`, so it resolves to `response_format` today instead of E1's forced tool call. | Deferred — a request-shape change needs a paired live-model evaluation to prove the decoded answer is unchanged; that evaluation is out of reach this session. |
| **R9** — Lossless prompt/payload simplification | No redundancy established in code (E1's system prompt: 2,458 chars; C1's: 254; P1's evidence block already bounded). | Deferred — the questionnaire's own words apply unchanged: "no particular instruction has been established as redundant." |
| **R10** — Raise E1 model capacity beyond 4 | The four-permit `WorkLimiter` and the shared `ModelAdmissionService` both cap at 4 by default; raising only the local limiter is inert. | Deferred — needs a trace showing the four slots saturated with independent ready work, which this session's harness has not captured. |
| **R11** — Parallel E1 parts within one document | Request independence is present (each part's request depends only on its own passage and read/profile metadata), but per-part admission, health-latch ordering, and mid-loop failure discard all assume sequential parts. | Skip — very high risk; Q7/Q12 explicitly reject a naive parallel rewrite, and sequential parts are a preservation item of the landed Step 2 fix. |
| **R12** — Transport batching | No batch construct exists at the model seam; per-item result/failure/cancellation semantics would have to come from the provider and cannot be established from code. | Skip — support unknown, and building speculative batching machinery against an unconfirmed provider capability is exactly what R0's "measure first" rule exists to prevent. |
| **R13** — Reuse of deterministic retained-source preparation | Already reused: a resumable source rebuilds its read result from the retained record without repeating fetch/parse/render/OCR. The one residual duplicate — `extractionPassages` runs twice per successfully extracted document — measured 0.14 ms/call at 52k characters and 1.96 ms/call at the 500k ceiling (roughly 3.9 ms worst case per document) against multi-second model calls. | Skip — zero material opportunity, measured. |
| **R14** — Cheaper P1-only model | The purpose seam already exists (`researchPlanning`) and `planNextLeads` already uses forced-tool binding, zero temperature, and a bounded schema. | Deferred — a model substitution needs the same paired evaluation R8 needs; P1 is intentionally scarce, so risk stays high regardless. |

**Nothing was built.** No candidate cleared this session's bar of
low-to-medium risk, no live paired evaluation required, and a real
code-confirmed opportunity. Four (R8, R9, R14, and R10's saturation
question) need live measurement or a paired quality evaluation this session
cannot produce, the same reasoning already used for Steps 3's original pass
and Step 4. Three (R7, R11, R12) fail the risk bar outright per the
questionnaire's own rating. R13's only measured duplicate is sub-millisecond
against a multi-second model call — a real finding, not a missing
investigation, and exactly the "zero eligible opportunity" outcome the issue
names as acceptable.

Incidental, unrelated finding from the R13 investigation, noted but not
acted on per this project's surgical-change rule: `research.ts`'s retained
`extractionRanges` field is written on every retain but read by no runtime
code.
