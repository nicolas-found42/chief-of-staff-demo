# Person Profile LLM cost / latency — questionnaire results

## Executive summary

**Optimise E1 first. Do not start by batching C1, removing P1, or lowering the research ceilings.** E1 scales with documents and selected parts; C1 is capped per bootstrap, and P1 is already deliberately gated. Those facts establish the strongest initial target, but not how much waste actually exists. 

| Priority                    | Recommendation                                                                                                                                                                                             | Expected saving on the same research workload                                                                                                                                                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1 — first optimisation** | Reuse previously validated, exact-request E1 part results in `PersonResearch.processRead`, beginning with successful parts of resumable documents.                                                         | One avoided extraction invocation and its charge per eligible hit. A four-part document with three reusable successful parts needs one new call instead of four on resumption: **75% fewer calls for that retry**, not for the whole workflow. Unique cold requests gain nothing. |
| **R2 — runtime**            | Remove demonstrated idle time between `readPersonSource` and E1 within the already selected batch, preserving reader limits, four model permits, and sequential parts within each document.                | Normally **zero fewer model calls**. Runtime saving is bounded by critical-path idle time that can actually overlap independent work. Already-saturated execution gains nothing.                                                                                                  |
| **R3 — token cost**         | At `CompleteJson`, exploit exact-prefix input caching for E1 **only if the configured provider supports it and the discount is not already applied**. Initially leave prompts and selected text unchanged. | **Zero fewer model calls**. Saving is eligible repeated input tokens multiplied by their measured price discount, net of any cache charges. Output charges remain; latency improvement is not guaranteed.                                                                         |

**First engineering step:** the small measurement patch in Q2. **First optimisation release:** R1, provided the trace establishes eligible repeated work. Skip a candidate whose opportunity is absent; do not build a cache merely because it ranks first.

No baseline measurements exist yet, so the figures below are conditional estimates and worked examples—not measured forecasts. 

---

## Establish the baseline first

### Q1. What can you not determine from the attached document, and what would you need?

> **I cannot identify the measured bottleneck, promise a whole-workflow percentage saving, or name a best replacement model from this map.** The following gaps matter.
>
> **Actual workload and settings.** How often C1 runs relative to research operations; rounds and documents per operation; the distribution of one through four parts; repeat/resume frequency; selected versus actually extracted documents; actual settings and queue-derived allowances; and the split between `completed`, `bounded`, and `interrupted`. Defaults are not a production trace.
>
> **Actual requests and charges.** Resolved model/provider, input/output and any separately billed usage, cached-input usage, charges, latency, failures, and provider attempts per `CompleteJson` invocation. Production retries, correction calls, fallback routing, output-token ceilings, and billing for cancelled requests are not documented. The evaluation judge’s correction retry must not be assumed to exist in production.
>
> **Complete request dependencies.** The actual prompts and full schemas are unavailable. I do not know whether a later E1 part depends on earlier part output, current dossier state, identity signals, capture dates, or other context. A safe cache needs the complete request identity after configuration and binding resolution—not merely a source-text hash. E1’s `temperature: 0` setting is not a documented guarantee of identical outputs.
>
> **Existing reuse and freshness policy.** Content-addressed retained sources and resumability do not establish whether successful E1 parts are already reused. I need existing cache/checkpoint keys, invalidation rules, scope, and whether an explicit refresh intentionally re-extracts unchanged text to seek previously missed facts. The safe serialisation and replay boundary for a grounded part result is also unknown.
>
> **Scheduling and failure contracts.** The lifetime and scope of `WorkLimiter(4)` permits; its relationship to reading and `SourceScheduler`; whether operations share it; current read/extract overlap and commit ordering; cancellation and in-flight deadline enforcement; atomicity of `budget.takeModelCall()`; and precise `ExtractionHealth` transitions, including what resets the consecutive-failure count.
>
> **Acceptance fixtures and timed boundaries.** Available reference people and difficult identity cases; exact C1 evidence-agreement semantics; existing document-failure and publication tests; and whether the latency complaint means trigger-to-first-evidence, research completion, or visible UI completion. The map calls Path A synchronous while describing trigger surfaces as nonblocking, which is insufficient to infer the complete user-facing bootstrap request lifecycle. 
>
> **Evaluation cache identity.** The map says the judge cache is version-keyed but does not supply the complete key. Verify that changed dossiers, inputs, and judging configuration cannot accidentally reuse an old assessment. 
>
> These are **unknowns, not findings of defects**. Most should be resolved through the measurement patch and focused contract checks—not by delaying everything for a comprehensive codebase audit.

### Q2. What is the smallest measurement that would tell you where to cut?

> Produce **three decision summaries**, using one bounded model-call record plus a few enclosing phase timestamps. Do not instrument every function.
>
> **1. Calls and dollars by C1/E1/P1, with an exact-repeat estimate.** Instrument `makeCompleteJson` / `CompleteJson` in `apps/server/src/llm/providers.ts`. Attribute each invocation to `createPersonClaimExtractor`, `PersonResearch.processRead`, or `planNextLeads`: the purpose alone cannot distinguish C1 from E1. Record logical invocations separately from provider attempts, resolved configuration, actual usage/charge, outcome, and an opaque exact-request fingerprint. Identify repeated requests for which an earlier validated success exists. This reveals the main spender and the maximum candidate R1 reuse opportunity. The shared seam and purpose coupling are documented.  
>
> **2. Critical-path time, not summed service time.** At `PersonResearch.run`, `readPersonSource`, and the E1/P1 limiter boundary, record phase boundaries and enqueue/start/end times. Separate discovery/network/reading, runnable work waiting for capacity, model service, and other time. Specifically identify intervals with unused model capacity **and independent work from the same selected batch ready to proceed**. A slot idle because the only remaining document has sequential parts is not automatically reclaimable waste. Account for overlap and dependencies instead of adding parallel durations.
>
> **3. Useful output and termination alongside cost/time.** Record documents retained, documents successfully published, grounded evidence/coverage produced, first publication time, final conclusion and reason, and extraction/planner failures. This prevents a cheaper run that simply stops early from appearing better. Evidence counts are diagnostics, not substitutes for the quality evaluation in Q11.
>
> **Smallest useful pilot:** one representative bootstrap plus research operation, a replay with fixed search/read inputs, and a controlled failure/resumption of a multi-part document. Keep cold and warm results separate. Capturing search responses for replay is proposed test support, not something the map establishes already exists.
>
> That pilot exposes mechanisms; it does **not** establish a reliable p95 or population-wide saving. Expand to representative ambiguity and source-family cases before deployment.
>
> Log opaque identifiers, sizes, hashes, timings, and reason codes—not names, transcript bodies, raw prompts, or citation text. Separate evaluation and neighbouring-purpose charges from the production three-site total.

### Q3. Of the three axes — call count, dollar cost, wall-clock time — which ones actually move together here, and which trade against each other?

> **Removing a genuinely repeated E1 invocation can improve all three**, but its runtime benefit depends on whether it was on the critical path. Calls are not equally priced: token volume, output length, provider, and failures matter.
>
> **Concurrency primarily changes time.** Performing the same requests with less idle time does not inherently save tokens or calls. Speculation, throttling, and cancellation can instead increase paid attempts.
>
> **Prefix caching primarily changes dollars.** A fresh generation still occurs. Transport batching can similarly reduce HTTP envelopes without reducing model generations. Neither should be reported as a model-call reduction.
>
> **Models and routes can trade money against time and quality.** E1 requests `preferredMinThroughput = 50` tok/s. That is a speed preference—not proof of achieved throughput or a price premium. Relaxing it might reduce cost while worsening runtime; another compatible route might improve both. Measure actual routes. Changing the shared `personResearch` model also changes C1, not just E1. 
>
> **Released allowance can be reinvested.** `PersonResearch.run` continues while active and within budget. Saved calls/time can permit additional research. Report both savings on a fixed set of source parts and full-operation cost, coverage, and conclusion. A fuller dossier at the same ceiling is valuable, but is not a measured bill reduction. 

---

## Account for the calls and the wall time

### Q4. Write the call-count arithmetic for one research round.

> Let:
>
> \(r\) = read concurrency; \(B=2r\) = selected batch size; \(D\le B\) = documents in the round; \(p_i\) = selected parts for document \(i\); and \(g\in\{0,1\}\) = whether P1 runs.
>
> For a successful round that actually extracts all selected documents:
>
> $$
> N_{\text{round}}=\sum_{i=1}^{D}p_i+g,\qquad 1\le p_i\le4.
> $$
>
> Therefore:
>
> $$
> D\le N_{\text{E1}}\le4D,\qquad
> N_{\text{round}}\le4D+1\le8r+1.
> $$
>
> At the default \(r=4\), a full eight-document batch requires **8–32 E1 calls and optionally one P1 call: 8–33 total**. P1 is not automatic: its readability, allowance, and unchanged-context gates must pass. 
>
> For actual attempted work, replace \(p_i\) with the number of parts that reach `CompleteJson`. Reader failures, earlier part failures, the health latch, cancellation, and allowance exhaustion can reduce that number. Failed attempts still count. Internal provider retries, if any, require a separate attempt total.
>
> **C1 is outside this arithmetic.** A bootstrap invocation makes up to `min(8, number of returned results)` calls. Whole-session accounting is the sum of actual bootstrap calls plus E1 and P1 calls across rounds. Do not automatically attach eight C1 calls to every queued research operation.
>
> Other bounds are not additional model calls: discovery takes at most four pending query leads; `deriveLeads` proposes up to 12 queries and 12 URLs; one P1 response contains up to eight queries, eight URLs, 12 coverage targets, and 10 remaining questions. Provider fan-out also means four search queries do not imply four HTTP requests.   
>
> The default 180-call allowance is an operation ceiling, not a per-round target. Queue-derived allowances differ from the standalone defaults. Under a fully populated default batch, E1 is structurally the call-count majority; its actual dollar share remains unknown. 

### Q5. Wall-clock time is not call count. Where does the time actually go?

> The relevant unit is the **critical path from admission to publication/completion**, not the number of call-site executions.
>
> **C1:** `Promise.all` overlaps the first eight extractions. Its extraction segment is governed approximately by the slowest outstanding result, not eight times an average call. The 120-second small-call ceiling is not an expected duration. Search latency before C1 remains separate.
>
> **E1:** documents run under `WorkLimiter(4)`, but each document’s one to four parts are sequential. If \(L_i\) is document \(i\)’s total model-service chain and all documents are ready, an ideal model-stage lower bound is:
>
> $$
> T_{\text{E1}}\ge\max\left(\frac{\sum_iL_i}{4},\max_iL_i\right).
> $$
>
> Reading dependencies and capacity contention add constraints. For example, eight equal four-part documents with per-part duration \(t\) have an ideal extraction time of \(8t\). Parallelising their parts under the same four permits cannot turn that into \(2t\). A lone four-part tail is a different workload. The concurrency and sequential-part constraints are documented; this bound is derived from them. 
>
> **Reading and search:** `PublicSearch` fans out, while `readPersonSource` includes network, parsing, PDF/OCR, and caption routes under `SourceScheduler`. These can dominate even when E1 dominates calls. The default 20-second request timeout and 400-request network allowance do not justify estimating runtime as `400 × 20 seconds`: requests overlap and other bounds intervene. The timeout’s exact scope needs verification.  
>
> **Batch barriers and planning:** selection takes `2 × readConcurrency`, default eight. `deriveLeads` and then P1 follow reading/extraction. P1 can be a serial tail despite being one call; its importance depends on duration and the scope of the shared limiter.
>
> **Routing and presentation:** the 50 tok/s preference does not describe queueing, time to first output, or observed end-to-end latency. The queue’s two-second dispatch tick and panel’s four-second polling also affect perceived responsiveness without consuming model calls. Distinguish first server publication from first visible update. 
>
> Measure both operation completion and the timeline of useful evidence. Do not change UI polling and credit that as faster research.

### Q6. Which of the three call sites is the best target, and which is the worst?

> **1. E1 — strongest initial target.** It scales with documents times one to four parts across rounds. It also has serial per-document chains and a four-worker capacity constraint. Reuse, token-cost, and scheduling improvements have the greatest structurally plausible leverage.
>
> **2. C1 — second.** Up to eight calls per bootstrap is meaningful, particularly if bootstrap traffic is frequent. Its three-field task justifies testing a cheaper specialised model, but it already runs in parallel and its per-result attribution feeds identity consensus. Collapsing calls is therefore disproportionately risky.
>
> **3. P1 — weakest default call-count target.** It is at most one call per round, follows deterministic derivation, requires `pendingReadable < batchSize`, and has an unchanged-context attempt limit. Do not implement those guards a second time. 
>
> This ranks **structural opportunity, not observed spend**. If measurements show unusually expensive or slow P1 requests, or overwhelmingly frequent C1 traffic, promote that measured bottleneck for dollars/time without pretending its frequency bounds changed.

---

## Rank the candidate changes

### Q7. List every candidate change you can justify from the document, then rank them.

> **Ranking convention:** R1–R4 are the first measured opportunities to pursue; R5–R14 are progressively less attractive or riskier experiments; R15–R19 are rejected designs. Dependencies can require a lower-ranked prerequisite to land first.
>
> **Effort:** **S** = local change and focused tests; **M** = stage-level change with persistence/configuration or broader tests; **L** = cross-stage scheduling/durability or substantial behavioural qualification. These are relative implementation costs, not time promises. Q2 instrumentation is prerequisite **R0**, with no direct model saving.
>
> **R1. Validated exact-request E1 reuse and successful-part checkpoints.**
> **Touches:** `PersonResearch.processRead`, `parsePartial`, retained records in `dossier-store.ts`, and the resolved request at `CompleteJson`. Persist a reusable part result only after existing bounds/schema/grounding checks pass. Key it by the actual request and relevant source/profile/provenance/configuration versions—not content alone. Revalidate against the retained record and rerun deterministic identity/publication processing.
> **Saving:** one invocation and its avoided charge per eligible hit; three reusable successful parts in a four-part retry save three calls. Unique cold requests save zero. Runtime benefit depends on the critical path.
> **Effort M–L; risk medium.** Never publish a partly successful document, cache failure as success, or bypass `ExtractionHealth`. Verify reuse is not already implemented. Reuse freezes an earlier proposal: exclude repetitions whose intended purpose is a fresh attempt to recover previously missed facts.
>
> **R2. Fixed-batch read/extract pipelining and permit-lifetime correction.**
> **Touches:** `PersonResearch.run`, `readPersonSource`, `SourceScheduler`, `PersonResearch.processRead`, and `WorkLimiter(4)`. Where the trace proves idle capacity, overlap independent reading/preparation within the selected batch without holding model permits for unrelated work. Preserve reader limits, four model permits, per-document part order, required commit ordering, and the derive/planner barrier.
> **Saving:** zero calls; approximately unchanged model dollars on fixed work; runtime improvement bounded by genuinely avoidable critical-path idle time. Twenty percent reclaimable idle time would be an upper bound near 20%, not a forecast.
> **Effort L; risk medium–high.** Failure, allowance, and publication ordering must survive. Do nothing if the existing scheduler already overlaps this work.
>
> **R3. Exact-prefix provider input-cache utilisation for E1.**
> **Touches:** `CompleteJson` / `makeCompleteJson` and E1 request construction. Verify provider support, actual cache billing, and unchanged request bytes; do not initially reorder prompts.
> **Saving:** eligible repeated input tokens multiplied by the discount per token, minus applicable cache charges. Calls and output-token charges remain. For illustration, caching 10% of billed input at a 75% discount saves **7.5% of input charges**, not 75% of the total bill.
> **Effort S–M; risk low if generation semantics and data policy remain unchanged.** No incremental value if unsupported or already effective. Extend to C1/P1 only when their measured eligible prefixes justify it.
>
> **R4. Same-model E1 route optimisation around `EXTRACTION_PREFERRED_MIN_THROUGHPUT = 50`.**
> **Touches:** E1 request options and routing through `CompleteJson`. Compare compatible routes with the same model, inputs, schema, and binding requirements. Preserve `preferredBinding: "forced_tool_call"`, `temperature: 0`, and `compactWireNames: true` unless separately qualified.
> **Saving:** measured route-charge and critical-path latency differences; no direct call reduction. Do not assume a lower throughput preference is cheaper or call a cheaper-but-slower route an improvement on all axes.
> **Effort S–M; risk medium.** Provider changes still require output, truncation, timeout, and failure tests. The existing settings are documented; their realised cost/performance is not. 
>
> **R5. Isolate purposes, then qualify a cheaper/faster E1 model.**
> **Touches:** `MODEL_PURPOSES` in `packages/shared/src/schemas.ts`, `configStore.getForPurpose` in `apps/server/src/config.ts`, and C1/E1 purpose assignments. Give C1 a distinct purpose, initially copying the existing configuration; leave E1 on `personResearch`. Persist the independent mapping rather than a live fallback that follows later E1 changes. Prove the split alone changes no request, then trial E1’s replacement with unchanged passage selection and output/failure contracts.
> **Saving:** at equivalent accepted work, if measured all-in E1 cost becomes a fraction \(r\) of baseline, approximately \(C_{\text{E1}}(1-r)\). No inherent call reduction.
> **Effort L; risk high.** Reduced recall or more failures can erase savings. Purpose separation itself saves zero.
>
> **R6. A cheaper C1-only model after purpose separation.**
> **Touches:** `createPersonClaimExtractor` in `person-profile/claims.ts:39` and its new purpose mapping. Preserve isolated per-result inputs, all available first-eight proposals, `ClaimsSchema`, per-result failures, and `PersonProfileResolver.observedClaim`. The three-field task is narrower than E1, which justifies testing—not assuming—a smaller model.
> **Saving:** \(C_{\text{C1}}(1-r)\) at equivalent accepted work; zero direct call reduction. Latency remains sensitive to the slowest parallel result.
> **Effort M–L; risk high at the identity boundary.** Fewer correctly resolved people is not an acceptable cost saving. 
>
> **R7. Exact successful C1 reuse across repeated bootstrap requests.**
> **Touches:** `createPersonClaimExtractor` and its validation boundary. Reuse only a validated result for identical result input, identity context, provenance, prompt/schema, and resolved configuration. Re-run resolver agreement; do not copy a conclusion into multiple evidence slots or cache the failure catch’s `{}`.
> **Saving:** one invocation per eligible repeated result, limited by actual first-eight work. Runtime savings depend on which parallel calls disappear.
> **Effort M; risk medium–high.** Freshness and apparent corroboration are sensitive. Search-result caching neither establishes that this exists nor that it is needed.
>
> **R8. Trial E1’s structured-wire options on C1.**
> **Touches:** C1’s `CompleteJson` options in `claims.ts`, specifically forced-tool preference and compact wire names where supported. Preserve decoded `ClaimsSchema` and per-result failure isolation.
> **Saving:** measured request/schema-token reductions and any demonstrated reduction in malformed-output work. Do not invent production correction retries. Calls normally stay unchanged, and the small schema limits potential savings.
> **Effort S–M; risk medium.** Do not simultaneously change C1 temperature or model.
>
> **R9. Lossless prompt/payload simplification at E1 or P1.**
> **Touches:** request assembly in `PersonResearch.processRead` or `evidenceSoFar` serialisation in `planNextLeads`, whichever has measured overhead. Preserve selected passages, evidence items, identity qualifiers, output requirements, and untrusted-input instructions. The actual prompts are unavailable, so no particular instruction has been established as redundant.
> **Saving:** removed input tokens multiplied by their price, at equivalent outputs; zero direct call reduction.
> **Effort M; risk medium–high.** Even content-preserving presentation changes need evaluation. Summarising away evidence or shrinking passages is not this candidate.
>
> **R10. Raise only E1 model capacity, not `readConcurrency`.**
> **Touches:** `WorkLimiter(4)` admission around extraction, after its scope is verified. Preserve batch size, P1 threshold, shared-capacity fairness, and atomic allowance admission.
> **Saving:** if four slots are saturated with independent ready documents, moving to \(k\) slots has an ideal speedup ceiling of \(k/4\) on that segment, further limited by document count, serial chains, provider capacity, and other stages. Calls do not fall; paid failures can increase.
> **Effort M–L; risk high.** Require clean load, cancellation, and boundary tests.
>
> **R11. Parallel E1 parts within one document.**
> **Touches:** the sequential part loop in `PersonResearch.processRead`. First establish that later requests do not depend on earlier outputs. Preserve whole-document failure, `ExtractionHealth`, cancellation, and allowance accounting.
> **Saving:** a lone \(p\)-part document has a theoretical model-latency speedup of at most \(p\le4\) with spare capacity. A saturated multi-document workload may gain nothing. Successful call count is unchanged; failure can cost more because later parts have already launched.
> **Effort L; risk very high.** Defer. Naive `Promise.all` is rejected, not a drop-in improvement.
>
> **R12. Transport batching with genuinely independent model inputs.**
> **Touches:** `CompleteJson` and E1/C1 dispatch, only if the provider supplies suitable per-item result, failure, and cancellation semantics. Keep existing prompts, input bounds, and logical generations separate.
> **Saving:** request-envelope overhead or a verified batch discount—not model-generation count. Incremental publication might become slower.
> **Effort M–L; risk high; support unknown.** This is not permission to place multiple documents in one model context.
>
> **R13. Reuse repeated deterministic preparation of retained sources.**
> **Touches:** `research-readers.ts` and `extraction-passages.ts`, anchored to immutable retained content and versioned reader/selector behaviour. Avoid only measured re-parsing, re-rendering, or re-selection of the same captured input. Do not suppress required fresh fetches or give old content a new capture date.
> **Saving:** zero direct model calls or model dollars; runtime saving no greater than measured repeated preparation cost.
> **Effort S–M; risk low–medium.** Existing retained-source resumability might already cover this.
>
> **R14. Cheaper P1-only model.**
> **Touches:** `planNextLeads` and `researchPlanning`. Preserve gates, `PlanSchema` bounds, lead-registry handling, and interruption on failure.
> **Saving:** measured P1 cost difference; no direct call reduction. A weaker plan can increase downstream work or silently lose discovery opportunities.
> **Effort M–L; risk high.** Last among model substitutions by default because P1 is already scarce. Promote it only when measured cost/latency warrants it.
>
> **R15. REJECT: one shared-context C1 call for all results.**
> **Touches:** `createPersonClaimExtractor`. Eight calls could become one, saving at most seven per full bootstrap. But cross-result inference, attribution contamination, and a shared failure boundary change the evidence feeding `observedClaim`. An array-shaped response does not restore isolated inputs.
> **Effort M; behavioural risk unacceptable.**
>
> **R16. REJECT: merge E1 parts or documents into one model context.**
> **Touches:** `PersonResearch.processRead` and its part boundary. Four part calls becoming one saves 75% of calls for that document, but changes the specified bounded input. Combining documents additionally couples attribution and document failures.
> **Effort M–L; behavioural risk unacceptable under this specification.** Independent transport batching is R12 and does not deliver this generation-count reduction.
>
> **R17. REJECT: remove P1, suppress its remaining opportunities, or memoise an unchanged-context plan as automatic convergence.**
> **Touches:** `planNextLeads`, its gate, and quiet-context handling. At most one call is saved in an affected round, but novel aims can disappear and allowed quiet-context attempts change meaning. Skipping the planner can also avoid an interruption that should follow an actual P1 failure.
> **Effort S–M; behavioural risk unacceptable as a blanket rule.** Existing gates already eliminate known unnecessary planning.
>
> **R18. REJECT: lower ceilings or omit difficult inputs as the optimisation.**
> **Touches:** `MAX_CLAIM_EXTRACTIONS`, `extraction-passages.ts`, `ResearchAllowance`, quiet rounds, source families, or reader routes. Work decreases by accepting changed coverage, agreement opportunities, or termination.
> **Effort usually S; behavioural risk unacceptable without a product decision.** Q14 gives the consequences.
>
> **R19. REJECT: replace deterministic authority with one agent/model decision.**
> **Touches:** identity, scoring, completion, or publication in the deterministic pipeline. Reducing apparent call sites or orchestration does not justify moving those decisions into a model. No trustworthy saving is established.
> **Effort L; behavioural risk unacceptable.** It contradicts the central invariant rather than optimising within it. 
>
> **Do not double-count savings.** Evaluate each candidate on the residual workload after earlier changes. A part eliminated by R1 cannot also contribute its old input charge to R3’s projected saving.

### Q8. Which single change would you do first, and why that one?

> **R1: validated successful-part reuse in `PersonResearch.processRead`, preceded by the Q2 measurement patch.** It is the clearest candidate for reducing actual invocations, dollars, and waiting while preserving selected text, model, output contract, and deterministic authority.
>
> Start narrowly: resume the same retained document under unchanged extraction dependencies after some parts succeeded. Do not begin with a global semantic cache or cross-person reuse.
>
> The qualification is concrete: if the fingerprint trace finds no eligible repeated E1 work—or shows successful-part reuse already exists—stop R1 before building a redundant cache. Pursue the highest measured opportunity among R2–R4 instead. The map does not justify promising a cache hit rate.

### Q9. Are there changes that are only safe *after* another one lands, or that must land together?

> **R1 requires source retention, validated replay representation, versioned keys, and accounting/failure tests together.** Cache hits must not bypass `active()`, clock/allowance checks, grounding, identity recomputation, or document publication rules. Specify their treatment in `ExtractionHealth`; never silently reset failure history merely because data came from disk. On a miss, retain `budget.takeModelCall()` admission before dispatch. Report hits separately from real calls and verify allowance semantics before reinvesting saved capacity.
>
> **R2 precedes R10/R11.** Establish permit ownership, overlap, merge/publication requirements, atomic admission, and cancellation before increasing parallelism.
>
> **Purpose separation precedes independent model substitutions.** R5 includes the no-op configuration migration enabling both its E1 trial and R6. Changing shared `personResearch` first contaminates both experiments.
>
> **Prompt/model/schema/binding changes require coordinated R1/R7 invalidation.** Reader/selector changes similarly invalidate R13 results. Otherwise an old extraction contract can be replayed under a new one.
>
> **R3/R4 require provider verification—not an invisible prompt rewrite.** Establish compatible bindings, billing, cache behaviour, data policy, and routing outcomes. R9 remains a separate experiment.
>
> **Every release requires hard invariant tests and comparable quality evaluation.** Keep the judge independent of the tested extraction model and ensure its cache cannot mask candidate-output changes. 

---

## Preserve the behaviour

### Q10. State precisely what “the same behaviour” means for this workflow, in terms you can test.

> **1. Deterministic authority remains deterministic.** Production model requests remain confined to C1/E1/P1. Collection, reading, passage selection, identity decisions, scoring/dedupe, completion, storage decisions, and publication gain no model dependency. `observedClaim` retains its HIGH-confidence agreement policy. `parsePartial`, `identify`, `combine`, `datedByCapture`, `decideIdentity`, and `PublicationGate` continue rebuilding decisions from retained records rather than trusting model assertions. 
>
> **2. Evidence remains bounded and grounded.** Retain the source before E1. Preserve the first-eight C1 bound, opening-plus-ranked-non-opening passage selection, 16,000/15,000-character windows, four-part maximum, output/schema bounds, and applicable allowances. Every stored/published citation quote must be a verbatim substring of its correctly attributed retained record. Cached results receive no exemption. Preserve the coverage plan’s eight dossier areas and every source family as research aims—not as a claim that every aim is necessarily recovered.  
>
> **3. Failure containment remains unchanged.** Failed C1 loses that result’s claims, not its evidence. Failed E1 fails the whole document while retaining resumable source work; successful earlier parts do not become partial publication of that failed document. Failed P1 interrupts the operation instead of returning an empty successful plan. Preserve the three-consecutive-boundary-failure health policy and honest cancellation/allowance handling.
>
> **4. Planning remains subordinate.** `deriveLeads` runs before `planNextLeads`; derived leads outrank planned leads. Planned items pass the same deduplication and scoring rules. The planner never decides identity, authority, publication, or completion. These failure and authority requirements are explicit invariants. 
>
> **Completion remains truthful:** `evaluateCompletion` requires `pending == 0 AND quiet >= quietRounds`. Exhausting a budget is `bounded`, not `completed`; interruption is not success.  
>
> Under deterministic replay, require equivalent durable evidence and decisions, ignoring only genuinely nondeterministic bookkeeping. For live-model changes, require those hard contracts plus no loss of supported reference coverage, identity correctness, or usefulness on the qualification set. Quote matching alone does not establish entailment or recall. Finite evaluation supports preservation; it cannot prove equivalence for every future web document.

### Q11. For your top three candidates, how would you know behaviour was preserved?

> Use **two layers**: frozen-input/fixed-model-output replay for authority and failure semantics, then paired production-path evaluations with live models. The existing rig exercises production E1/P1 through `composePersonProfiles` and `research.runNow(profileId)`; it does not replace operational or C1-specific tests. 
>
> **R1 — exact-result reuse/checkpoints.**
> **Saving observable:** outbound E1 invocations, charges, and runtime for cold versus eligible replay/resumption.
> **Preservation observables:** selected-part fingerprints, grounded evidence attribution, identity/dating decisions, document publication state, conclusion, and allowance/health transitions.
>
> Test a four-part document with three successful parts and a failing fourth. It must not publish. Source and eligible grounded checkpoints remain, and resumption must validate the whole document before publication. Changes to retained text, attribution, identity context, prompt/schema, model/provider settings, or any request dependency must invalidate reuse. Never serve failure or ungrounded output, relabel old evidence as newly captured, bypass cancellation, or manufacture extra corroboration.
>
> **Judge coverage:** J1 recovery and J2 support/usefulness/overclaims can reveal missing or incorrect evidence; J4 can assess earlier-cutoff quality. They cannot prove cache-key completeness, invalidation, atomic publication, latch behaviour, or allowance enforcement. Those require fixtures and traces.
>
> **R2 — fixed-batch pipelining.**
> **Saving observable:** less avoidable critical-path idle time and earlier grounded publication—not just higher utilisation.
> **Preservation observables:** unchanged selected batch, per-document dependencies, reader/model limits, permit release, required combine/publication ordering, and derive-then-plan barrier.
>
> Inject reader failure, part failure, the third consecutive boundary failure, cancellation, and a mid-batch allowance boundary. Assert no over-admission, forbidden partial publication, or incorrect terminal state. With frozen outputs, compare semantic durable results and causally required ordering.
>
> **Judge coverage:** J1/J2 assess final quality; J4 assesses progress quality. Neither proves semaphore ownership, cancellation correctness, or what caused a speedup.
>
> **R3 — exact-prefix provider caching.**
> **Saving observable:** actual cached-input usage and net charges on identical requests, with unchanged logical call count.
> **Preservation observables:** unchanged semantic request, passages, configuration/binding, validation, failure handling, and source attribution.
>
> Confirm cold/warm billing and appropriate misses after changes. A locally computed matching prefix does not prove a provider discount. Run adversarial grounding fixtures and paired quality checks.
>
> **Judge coverage:** J1/J2 can expose output-quality changes, but not billing errors or cache eligibility.
>
> J3 collection/capability checks and deterministic ambiguity guards supplement these tests. Direct C1 input-isolation and `observedClaim` fixtures remain necessary. Keep the judge independent and its cache identity correct. **No aggregate quality improvement excuses a hard-invariant regression.** 

### Q12. Which of your candidates are *not* behaviour-preserving, and should be dropped or flagged as a product decision instead?

> **Drop R15–R19 under this brief.** Their savings come from changing an input boundary, evidence-isolation boundary, research opportunity, amount of research, or deterministic authority.
>
> The important per-item case is **C1**. `createPersonClaimExtractor` asks what **one result** says, while `PersonProfileResolver.observedClaim` relies on agreeing HIGH-confidence evidence. A joint prompt can let one result supply an employer that the model then assigns to several result objects. Apparently agreeing objects are not equivalent to separately attributed evidence. The architecture does not establish statistical independence of websites or models; it preserves per-result input attribution. That is the boundary not to erase.  
>
> **R11 is not approved as a naive parallel rewrite.** Request independence, spare capacity, whole-document failure, health ordering, and budget handling must first be established.
>
> **R4–R6, R8–R10, and R14 are experiments, not automatically safe changes.** Keeping validators does not prove preserved recall or research quality. A cheaper model that finds less is not an accepted optimisation.
>
> **R1/R7 also require freshness and exact-context qualification.** URL-only reuse, cross-context reuse, and caching intended fresh extraction attempts are not the proposed design.

---

## Traps worth naming

### Q13. Which “obvious” optimisations should be rejected, and why?

> Beyond the ranked rejections:
>
> **Changing `personResearch` globally to optimise C1:** it also changes E1. Separate purposes first.
>
> **Adding “plan only when readable leads are scarce”:** `plannerIsWorthACall` already does that, and `deriveLeads` already precedes P1. Duplicating the guard is not an established saving.
>
> **Trusting cached final dossier fields or model-supplied identity/date/authority:** that bypasses recomputation from retained evidence. Reuse qualified proposals/checkpoints, not authority decisions.
>
> **Treating `parsePartial` as proof that a smaller model is equally good:** a verbatim quote can still be irrelevant, misleadingly attributed, or insufficient for a conclusion. Missing evidence also passes a precision-oriented guard.
>
> **Disabling judges to reduce production cost:** they are evaluation-only. Optimising Meeting Debrief is likewise a separate project, not a C1/E1/P1 saving.  
>
> **Speculating P1 before extraction and derivation finish:** that changes its evidence/pending-pool context and can buy a plan that should never have been requested.
>
> **Removing retries, shortening timeouts, or returning empty success on errors:** production retry details are unknown, and earlier abandonment changes recovery or evidence. In particular, P1 failure must remain interruption. Faster failure is not faster equivalent research. 

### Q14. The configured bounds are ceilings, not targets. What breaks if someone lowers them?

> **Lower `MAX_CLAIM_EXTRACTIONS = 8`:** fewer proposals can remove supporting or conflicting evidence required for a correct `observedClaim` decision.
>
> **Reduce four parts, shorten windows, or retain only the opening:** evidence in selected non-opening windows disappears; context and usable verbatim quotes can also be lost.
>
> **Lower model, network, or wall allowances:** more operations can become `bounded` before comparable research is done. They must not become `completed` merely because the new limit was reached.
>
> There is an important coupling: the queue computes network allowance as `max(1, settings.profileCalls × 8)`. Lowering `profileCalls` can therefore reduce search/read capacity as well as model spend. Do not confuse queue-derived formulas with the standalone 180/400/900,000 defaults. 
>
> **Lower `quietRounds`:** fewer quiet rounds and allowed unchanged-context planner attempts can declare completion before the old stopping policy would.
>
> **Lower `readConcurrency`:** parallelism decreases **and** `batchSize = 2 × readConcurrency` changes, affecting selection grouping and the P1 threshold. Raising it changes those semantics too; it is not an isolated model-speed knob.
>
> **Lower request timeouts:** slower valid sources or requests, wherever the timeout applies, can fail sooner. Waiting decreases because less evidence is accepted.
>
> **Lower P1 output limits or discovery breadth:** fewer aims and source opportunities can change what is found.
>
> Smaller research budgets can be legitimate product choices. They are not equivalent-work optimisations and must retain honest terminal states.

### Q15. Where does the workflow already cache, reuse or throttle, such that a proposed change would duplicate work that already exists?

> **Collection already reuses work.** `PublicSearch` / `source-adapters/**` already provide deterministic deduplication, app-wide caching, and cooldowns. A generic search cache or duplicate cooldown logic needs a demonstrated gap, not an architectural assumption.
>
> **Sources and dossiers are already durable.** `dossier-store.ts` holds revisioned dossiers and content-addressed sources. Source retention precedes extraction, and E1 failure leaves the source resumable. R1 adds only missing validated-part reuse; R13 adds only missing preparation reuse. Neither should rebuild source durability.  
>
> **Work and planning already have controls.** `SourceScheduler`, `WorkLimiter(4)`, `selectReadBatch`, `scoreLead`, `retireSurpassedLeads`, and `LeadRegistry` already govern work. `deriveLeads` precedes P1; `plannerIsWorthACall` checks readable work; unchanged-context attempts are bounded. `ResearchAllowance` and `ExtractionHealth` are existing safeguards.
>
> **E1 already has wire/routing optimisation choices.** It already uses forced-tool preference, zero temperature, compact wire names, and a 50 tok/s throughput preference. C1 does not specify those options. Moving a qualified option to C1 is not a new E1 optimisation. 
>
> **Evaluation already controls repeated judging.** J1/J2 run concurrently; judge phases have one correction retry and a version-keyed disk cache. These are not production calls. Verify the cache’s full identity before relying on it across changed outputs. 
>
> The map does **not** establish production extraction memoisation, effective provider-prefix caching, or absence of read/extract overlap. Treat each as unknown rather than a confirmed missing implementation.

---

## Sequencing

### Q16. Write the implementation order, with a checkpoint after each step.

> **Step 0 — narrow baseline and invariant harness.** Add Q2’s call/charge/fingerprint and critical-path records. Capture a cold run, fixed-input replay, and controlled resumption; test the hard contracts with deterministic fixtures.
> **Checkpoint:** stage shares, reusable E1 requests, ready-work idle intervals, and eligible prefix charges are known. If evidence remains ambiguous, refine the relevant probe—not the whole architecture.
>
> **Step 1 — R1, starting with same-document part resumption.** Introduce versioned, grounded checkpoints and replay through existing validation, identity, and publication boundaries. Use a reversible switch; establish eligible hits before serving them.
> **Checkpoint:** fewer live E1 calls on targeted replay/resumption with equivalent semantic evidence and failure behaviour. Skip or stop if reuse already exists, opportunities are negligible, stale entries appear, or an invariant fails.
>
> **Step 2 — R2, against demonstrated idle time.** Keep batch and capacity settings fixed. Correct permit lifetimes or overlap independent reading/preparation with extraction.
> **Checkpoint:** reduced critical-path waiting and earlier valid evidence, unchanged fixed-work model requests, and clean cancellation/failure/allowance tests. Stop if idle time is intrinsic, execution already overlaps, or extra paid work offsets the gain.
>
> **Step 3 — R3, exact-prefix billing reuse.** Verify support and actual cold/warm charges before changing transport options. Initially preserve prompt bytes.
> **Checkpoint:** measured net input-cost reduction with equivalent requests and no quality/failure regression. Skip if already applied, unsupported, insignificant, or incompatible with data handling. Do not silently broaden this into prompt rewriting.
>
> **Step 4 — R4, one same-model route experiment at a time.** Preserve schema/binding requirements; compare realised charges, first useful evidence, total runtime, and failures.
> **Checkpoint:** retain a route only when it improves the intended dimensions without an unapproved trade or behavioural regression. A cheaper-but-slower route is a trade-off, not an all-axis win.
>
> **Step 5 — no-op purpose separation, then R5/R6 model trials.** Prove C1/E1 retain their original resolved settings after separation. Then change one stage’s model, not both.
> **Checkpoint:** hard tests and paired recovery/support/ambiguity evaluations pass; operation cost/runtime improve at comparable quality. Stop on lost reference coverage, incorrect resolution, more boundary failures, or extra downstream research that consumes the apparent saving.
>
> **Step 6 — rerank residual opportunities.** Consider R7–R14 only where the new trace justifies them. R10 needs saturated independent work; R11 needs independent parts and a material tail to accelerate.
> **Checkpoint:** retain changes only when incremental savings justify complexity and failure risk. Do not implement R15–R19.
>
> At every checkpoint, separate cold/warm, fixed-work/full-operation, first-publication/completion, and terminal-state results. Keep rollback switches and cache/configuration versioning.
>
> A change from `bounded` to `completed` is welcome **only when the unchanged completion predicate is genuinely met**—never through relabelling.

---

## Anything else?

### Q17. Anything the owner should know that this questionnaire did not ask?

> **There may be little removable model work.** If E1 requests are unique, every selected part is required, and existing gates already suppress unnecessary P1, large call-count reductions are not established by this architecture. Cost and runtime can still improve through tokens, routes, models, and scheduling. Call count may be the least movable axis under unchanged behaviour.
>
> **Count the right things separately:** logical extraction tasks, `CompleteJson` invocations, provider generation attempts, HTTP envelopes, and billed dollars. Wrapping requests in a batch or hiding retries can make one metric fall while another rises. Keep C1 bootstrap traffic separate from per-operation accounting.
>
> **A call ceiling is not a dollar budget.** Identical call counts can have different token charges. Changing `profileCalls` also affects queue-derived network allowance. Those couplings should remain visible rather than disappear into one “efficiency” score.
>
> **Cache isolation must include private-source cases.** Although the task is described as public-web research, the architecture includes confirmed Transcripts as research inputs. Scope reuse to the appropriate workspace/profile/source context and retained-source data policy. Do not log raw personal content or justify cross-profile reuse solely by matching text. 
>
> **Qualification and maintenance costs count, but separately.** Keep the independent judge and use its cache correctly. The eventual break-even calculation is:
>
> $$
> \frac{\text{implementation + qualification + ongoing maintenance cost}}
> {\text{measured saving per operation}}.
> $$
>
> Actual operation volume and prices are missing, so break-even is unknown.
>
> The first iteration should be willing to conclude that a tempting optimisation has **zero eligible opportunity**. Avoiding a redundant cache or unsafe batching rewrite is preferable to reporting a reduction obtained by researching less or weakening the evidence contract.
