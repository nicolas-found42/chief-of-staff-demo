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

## Step 3 — Provider exact-prefix input caching (R3): skipped, unverified

The configured provider/model is `openrouter` / `inception/mercury-2.5`
(read from the Workspace's live `config.json`; no purpose overrides are set,
so C1, E1, and P1 all resolve to it today). No request-side prompt/prefix
caching code exists anywhere in `apps/server/src/llm/` — no `cache_control`,
no explicit cache directive of any kind. The repo's own research already
contains **two directly conflicting measurements** of whether this provider's
routes cache repeated input at all:
`docs/research/person-extraction-boundary-diagnosis-2026-09-06.md` reports a
repeat call at 99.9% cached tokens; `docs/research/
meeting-wizard-provider-retention-research.md` (dated one day later) reports
both inspected ZDR endpoints as *not* supporting implicit caching. R3's own
gate text requires verifying "actual cold/warm billing" before touching any
transport option — that verification needs a live, paid, controlled
before/after comparison against the real provider, which a code-reading
session cannot establish and should not simulate by guessing.

Separately: Person Profile extraction sends no `routePolicy` and no
`SourceLifecycleGrant` today (`grep` over `person-profile/**` confirms this),
so no ZDR/data-collection restriction currently rides on these calls at all.
ADR-0081 already names authorizing named ZDR endpoints for retention as "an
accepted specification awaiting implementation and validation" — a decision
for the Workspace owner, not something this cost-cutting change should fold
in as a side effect of adding a caching directive.

**Skipped.** Reopen only behind a live, measured before/after comparison of
identical requests' cached-input usage and net charges, and only after the
owner has settled the routePolicy/data-collection question this step would
otherwise entangle with.

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
experiment, not a code change.

**Skipped**, for the same reason as Step 3: no code-only measurement can
stand in for the live comparison the gate requires. This is the natural next
use of the Step 0 decision-summary module once the owner wants to fund a
route trial.

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

## Step 6 — Model trial and residual re-ranking: not started, correctly gated

R6 (a stage-specific model trial) and the re-rank of residual candidates both
require a paired live-model evaluation against the fixed acceptance pair with
an independent judge (the existing benchmark rig,
`scripts/person-research-benchmark.mts`) — real cost and a quality judgment
call that this session did not have standing authorization to spend. This
stays open, waiting on the Workspace owner choosing a candidate replacement
model and funding the comparison run.
