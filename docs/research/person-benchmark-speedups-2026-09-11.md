# Speeding up Person Research arm runs without changing their behavior — 2026-09-11

Question: the acceptance arm for #258 spends ~16 min of research per 10 people and ~30–45 min for
the full 30-person population at `--concurrency 4`. Where can that wall time be reduced **without
changing what the pipeline reads, extracts, or judges**?

Method: attribution over every operation record the arm has written (5,067 operation-seconds,
35 operations), code reading at the points the numbers name, and five parallel research passes
(one local profiler; four literature/codebase scouts covering model-transport, parse hot paths,
comparable agent pipelines, and harness levers). Estimates are labelled as estimates; every
`MEASURED` figure comes from artifact JSON under `artifacts/person-benchmark/`. No benchmark run
was started for this study and no repository file was modified to measure anything.

## Bottom line

1. **In this design, wall-clock latency is an input to what gets read.** The per-host read+extraction
   time feeds lead scoring, which decides the read batch and which deferred leads are permanently
   rejected. Any change that makes reads or extraction faster can therefore change the dossier —
   it is a behavior change by construction, not a safe optimization.
2. **The behavior-neutral set is small and it is mostly already taken.** Streaming SSE, throughput
   routing, source-side ETag/304, keep-alive on source fetches, per-host pacing, judge research
   overlap, retry policy, and person-granular resume all exist. What remains sums to low single-digit
   percent of arm wall.
3. **The wall is latency, not compute.** Process CPU is 0.0–0.6 % of 10 cores; HTML/PDF parsing is
   ≈1 % of arm wall. Nothing local is hot.
4. **If faster arms are wanted, the productive change is to remove wall-clock time from the ranking
   signal** (see _Strategic finding_). Until then, arm speed and arm comparability trade against each
   other, and the honest lever is resume/carry, not parallelism.

## Where the wall actually goes

Attribution over 35 operation records (30-person arm `453489580a2bc969` plus live arm
`334574ff96efe9a0`), partitioning every gap between consecutive `attempts[]` entries by the stage of
the following event; the partition sums to the operation walls (head 17 s + tail 3 s + 5,047 s =
5,067 s):

| bucket | seconds | share |
| --- | --- | --- |
| model calls (extraction + planning) | 2,436 | 48.1 % |
| read path (fetch, parse, document decode) | 2,349 | 46.4 % |
| discovery (search passes) | 199 | 3.9 % |
| selection + publication | 63 | 1.2 % |

Within that, two buckets are pure loss rather than work: **641 s of transport time** (384 s of it
`request-timeout`) and **411 s waiting on model calls that subsequently failed at the model
boundary**. Worker occupancy at the people level is 3.92 of 4 slots (98 %), so the arm is not
under-scheduled — it waits on the network and the model route.

Per person (measured, six completed operations): research 47–474 s (mean 246 s), judge 5–77 s
(mean 41 s, 14 % of wall), 3–27 model calls of a 180-call allowance, 26 searches, 13 HTML reads.

## Why "same behavior" is a strong constraint here

Three couplings make timing semantic:

1. **Lead score consumes observed latency.** `scoreLead` multiplies every lead's score by
   `efficiency = clamp(0.5, 1.25, (0.75 + useful/reads) / (1 + milliseconds/reads/30000))`
   (`apps/server/src/person-profile/research-plan.ts:373-386`), where `milliseconds` accumulates
   `entry.readMilliseconds + (Date.now() - extractionStarted)` per host
   (`apps/server/src/person-profile/research.ts:1289-1292`). Extraction *and its retries* are in the
   signal.
2. **The batch floor rejects leads.** `selectReadBatch`'s last entry sets `batchFloor`, and deferred
   leads trailing it by more than `SELECTION_RETIREMENT_MARGIN = 2` score points become permanent
   `lead-rejected` dispositions (`research.ts:547-560`). Reordering by a changed efficiency term can
   flip a near-tie across that margin.
3. **The allowance bounds rounds.** The round loop runs while the operation's 900 s allowance holds.
   Saving wall time can therefore add a round for allowance-limited operations — different work, not
   the same work sooner.

`readBatchSize(readConcurrency) = readConcurrency * 2`
(`apps/server/src/person-profile/research-policy.ts:152`) ties the batch cut to the read concurrency
setting, so changing that setting moves both the batch and the retirement floor.

## Levers that are behavior-neutral by construction

| # | Lever | Effect | Proof of neutrality | Where |
| --- | --- | --- | --- | --- |
| 1 | **Resume/carry via `--retry`** (already used for this arm) | 100 % of every carried person's research + judge | Carried artifacts are the originals; conditions mismatch refuses the whole directory | `apps/server/src/person-benchmark/resume.ts` |
| 2 | **Judge/research overlap** (already implemented) | Removes the judge from the critical path; residual tail is 14–20 s per arm | Judge outputs reach no scoring input | `apps/server/src/person-benchmark/evaluate.ts:225` |
| 3 | **One pooled Chromium + fresh context per render** (only when `--render` is on; off for this arm) | est. 4–13 s/op at ~13 renders/op | Incognito-equivalent context isolation keeps navigation identical | `apps/server/src/source-adapters/browser.ts:52` |
| 4 | **Dedicated keep-alive undici Agent for the model API** | est. 1–4 s/op (22 calls × 50–200 ms handshake) | Transport only; identical bytes, earlier DNS/TLS | `apps/server/src/llm/providers.ts` (`postJson`/`postSseStream`) |
| 5 | **Blank `<style>` bodies before JSDOM** | MEASURED jsdom CSSOM cost 0.15 ms per KB of inline CSS → est. 1–3 s/arm | Readability deletes every `<style>` before extraction; textContent/title/anchors verified byte-identical on three real archived pages and 19 fixtures | `research-readers.ts:readHtml` before the JSDOM construction |
| 6 | **Lazy `textContent` in the readability pre-gate** | MEASURED 5.9 ms → 3.7 ms on a 300-candidate page; gate mean is 16.6 ms over 296 gate-negative pages | Read-only gate; same string returned | `research-readers.ts:probablyReaderable` shim |
| 7 | **Incremental JSON parse of streaming answers** | ≈0 (validation still needs the complete answer) | Only complete elements are validated; mid-stream detection already exists | `providers.ts:postSseStream` |

Ceiling of the safe set: **low single-digit percent** of arm wall (≈2–5 s per operation on the
measured 194 s operation), most of it only in render-enabled arms. Nothing here is worth a dedicated
arm.

## Levers that change the arm's conditions (for a future arm, not this one)

| Lever | Effect | What it costs |
| --- | --- | --- |
| Per-operation in-flight reads 4 → 8, **keeping the batch cut at 8** (split admission from transport, as Inspect AI and Firecrawl do) | est. 10–20 % of research wall: 30 operations averaged 5.7 reads/round against a cap of 4, i.e. most rounds lose a second wave | Per-read ms drifts, which re-feeds `efficiency`; needs an A/B against the cheaper incumbent arm before trusting it |
| Provider prefix/KV caching + sticky `session_id` on model calls | est. 5–30 s/op (18 extraction calls share a long system prompt) | Sticky routing can change the serving provider/quantization → wire-visible, must be recorded |
| `provider.preferred_max_latency` beside the existing throughput sort | targets the 47–474 s tails | Routing change → wire-visible, must be recorded |
| Raise the shared pipes (4 model documents, 8 readers globally) | Unknown; the only way to raise aggregate throughput | Provider contention; recorded, not asserted-equal |
| People concurrency above 4 | **No gain measured**: occupancy already 3.92/4 and the shared pipes bind | Guard edit plus the above |
| Shrink the population on both sides of a pair | Halves makespan | Legal only if both arms shrink; widens the detectable bar ≈√2 |

`conditionsComparable` (`apps/server/src/person-benchmark/report.ts:371-381`) asserts equality of
population, reference versions, judge provider/model/version, mode, and completeness — allowance,
concurrency, routing and caching are **recorded, not asserted**. That is exactly why they may be
changed for a future arm provided the report says so.

## Dead ends, with the evidence that kills them

- **Request hedging** (Tail at Scale): OpenRouter bills duplicate identical requests independently
  (no coalescing), and a hedge swaps which sample wins — verdicts are no longer reproducible.
- **Provider response caching** (`X-OpenRouter-Cache`): returns the cached answer verbatim
  regardless of temperature.
- **Swapping JSDOM for linkedom/cheerio**: not byte-identical (Readability issue #980 documents
  linkedom mangling `href` output; the maintainer cannot reproduce with jsdom).
- **Optimizing HTML/PDF parsing further**: measured ≈1 % of arm wall (10.3 s of recorded parse time
  over 137 operations; 296 gate-negative pages at 16.6 ms mean).
- **Cross-person read caching / dedupe**: MEASURED on the completed 30-person arm — **0 of 1,942
  investigated lead URLs were read by two people**. (The 304 URLs that appear in two people's
  attempt streams are selection/identity bookkeeping, not reads.) Within-person repeats are retry
  chains: 3,904 of 9,812 URL attempts.
- **Bypassing the pre-gate after a challenge is detected**: saves ~0.5 s/arm and changes the recorded
  diagnostics string.
- **Import-level costs** (jsdom 180 ms, pdfjs 122 ms once per process): a one-time cost per arm.

## Strategic finding

The reason almost nothing is safely available is that the pipeline ranks sources by their *observed*
cost, so making reading faster changes which sources it reads. If the intent is a faster product
(not just a faster arm), the enabling change is to replace wall-clock latency in the `efficiency`
term with an admission-independent prior (a fixed per-host cost expectation, or a bounded budget
counter). Once timing is no longer an input to ranking, transport and scheduling optimizations become
behavior-neutral and the 10–20 % read-wave win, the prefix-cache win, and future parallelism all
become available. That is a product decision with its own ADR and would need a fresh baseline arm,
because it changes research behavior by design.

## Limits

- This is an analysis, not an in-arm experiment: every effect is either measured on existing
  artifacts or labelled an estimate. The two estimates that matter (read-wave overlap, prefix
  caching) need a deliberate A/B before shipping.
- The 47–474 s per-person spread means single-person timings are not a reliable measure of an
  optimization; only arm-level spans are.
- Routing and cache behaviour is documented by providers, not measured here.
