# Person research overlaps judges and bounds discovery passes

The post-ADR-0075 run produced the first `completed` research operations (17 of 17 concluded)
with per-call timing evidence. The wall-clock mass that remains is sequential: the judge's two
independent calls run back to back, every discovery round pays the slowest search provider,
each of hundreds of HTTP requests pays its own TCP+TLS setup and DNS lookup, and pages that
never yield text still pay the full parse. The maintainer accepted the speed research
(`docs/research/person-research-speed-v2-2026-09-09.md`) and its safe-now levers on 2026-09-09.

We overlap the judge's recovery and support calls — both inputs are built from the function
arguments, so they run concurrently with byte-identical shapes, bindings, retries and version.
Each discovery pass after the run's first resolves on a soft deadline (8 seconds, or 80% of the
bundle settled, whichever first); cut providers keep running and merge into the shared pool when
they land — deferred a round, never dropped — and every cut is recorded on the search
diagnostics. Collection HTTP pools through one shared keep-alive dispatcher (30 s keep-alive,
600 s max, 10 s connect timeout, Happy-Eyeballs on) with TTL-honoring DNS caching, scoped to the
source-adapter transports only. The expensive HTML parse is gated behind Readability's
`isProbablyReaderable` pre-check (fail-open on gate errors); the outbound-anchor harvest runs
after the gate and before Readability so gate-positive pages keep today's exact anchor behavior,
and gate-negative pages skip JSDOM, harvest and parse while recording the decision. The gate runs
with zeroed score thresholds, so it can only skip pages carrying no text-bearing `p`, `pre`, or
`article` at all — the defaults (minScore 20, minContentLength 140) rejected single-short-paragraph
pages the full parse retains. A per-request retry-sleep budget was considered and REJECTED: its
only binding effect was skipping server-issued `Retry-After` waits past 8 s, which overrides
upstream pacing the composition contract pins ("the wait is honoured rather than rejected") and
rates escalation risk above a marginal saving, since self-chosen backoff waits (≤ 2 s each)
never reach the budget on their own. A parse-time probe rides reader attempt records so the DOM
choice is measured, not believed.

Completion conditions, model pins, ceilings, allowances, call shapes and prompt text are
unchanged (ADR-0063, ADR-0074). Source-version reuse scoping is unchanged (ADR-0075). A cut
provider's results are deferred, not discarded, and the deferral is visible per provider in the
run's own artifacts. Extraction-input slimming was probed and refuted — across 726 recorded
model calls, duration correlates with input size at r = 0.110 and binned medians move only
4.5 s → 5.1 s → 5.2 s across a four-fold input range — so a prompt change is not adopted for it.

The owner re-pinned the #239 acceptance population to 10 people with at least 8 completed
operations (issue body, 2026-09-09). The 10-person arm runs on these levers under its own
recorded conditions; the stopped post-ADR-0075 partial (17 of 17 concluded operations completed)
remains its pre-lever comparison baseline.
