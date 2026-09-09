# Getting Person Research to ≈5 minutes end-to-end

Research date: 2026-09-09. Requested by Nicolas ("no reason this should take more than 5 mins total").
Follow-up to `docs/research/person-research-speed-2026-09-09.md`, whose §1–5 recommendations are
already implemented via ADR-0075 and are not re-proposed here. This is a proposal and evidence
record, not a change to the research contract, model pins, ceilings, or completion conditions
(ADR-0063/0074/0075 remain fixed; anything touching them is listed under Owner decisions).

## Recommendation

The live run `129458a747d3e069` (post-ADR-0075, in flight, read-only) shows research alone now
lands at 2.6–7.7 min for 7 of the first 10 people, with the judge phase adding another
≈37–152 s per person after research finishes. Typical people need ≈2 min removed; outliers
(Bong Joon-ho: 13.7 min research, 36 rounds, 116 model calls) need a stopping-policy decision,
not engineering. Ranked by expected minutes saved per implementation risk:

1. **Overlap the judge's two calls** (safe-now, ≈1–2 min/person): `judgePerson` awaits the
   recovery call and the support call sequentially; their inputs are independent, so they can
   run concurrently with identical shapes.
2. **Deadline the search fan-out per pass** (safe-now, ≈1–3 min/person): every discovery round
   awaits all ~40 providers including the slowest; proceed on a soft deadline and keep late
   results opportunistically.
3. **Pool HTTP connections** (safe-now, ≈0.5–2 min/person): all collection goes through global
   `fetch` with no connection reuse tuning; 122–444 requests per operation each risk a fresh
   TLS+TCP handshake.
4. **Gate HTML parsing, then re-measure the parser** (safe-now, ≈0.5–1.5 min/person): every
   page pays full JSDOM + anchor harvest + Readability, including the dozens per operation that
   yield no text; skip the expensive half on doomed pages and A/B linkedom only if probes
   justify it.
5. **Slim extraction inputs** (safe-now with a quality A/B, ≈0–1 min/person): each part call
   carries up to 80 outbound URLs plus the full person envelope; cut the parts that never
   change the answer, then verify recovery is unchanged.
6. **Budget retry sleeps** (safe-now, ≈0–0.5 min/person, tail only): per-request retry waits
   (up to 8 s) sit inside read slots; cap their contribution to the operation's critical path.

What safe-now work cannot fix: a 36-round outlier is expansion policy, and expansion policy is
ADR-0063 completion conditions — an owner decision (§Owner decisions). Likewise judge input
shape, reasoning effort, the 4-model-document limit, call shapes, and cross-person reuse stay
owner decisions; each is quantified below so the decision is priced.

## What the new evidence actually shows

### Post-ADR-0075 live run `129458a747d3e069` (in flight; first 10 operations)

Per-operation research elapsed (`startedAt`→`finishedAt`), model-call sums from
`model-call-metrics` attempts, and judge-phase wall time (`finishedAt`→`person.assessedAt`,
which includes judge-queue wait under the concurrency-4 limiter — the right number for
end-to-end math, not pure call latency):

| Person | Research | Rounds / requests / model calls | Model median / p95 | Model sum | Judge phase | End-to-end |
| --- | ---: | ---: | --- | ---: | ---: | ---: |
| Anders Danielsson | 205 s (3.4 min) | 12 / 122 / 16 | 4.5 s / 6.9 s | 78 s | 72 s | **4.6 min** |
| Cary Fowler | 155 s (2.6 min) | 11 / 109 / 3 | 4.4 s / 4.4 s | 14 s | 37 s | **3.2 min** |
| Devi Shetty | 261 s (4.4 min) | 22 / 204 / 11 | 4.8 s / 5.3 s | 55 s | — | — |
| Doug McMillon | 292 s (4.9 min) | 14 / 141 / 44 | 4.6 s / 7.0 s | 224 s | — | — |
| Achim Steiner | 292 s (4.9 min) | 20 / 184 / 17 | 5.4 s / 8.5 s | 94 s | 44 s | **5.6 min** |
| Cristiano Amon | 348 s (5.8 min) | 25 / 239 / 44 | 5.2 s / 7.6 s | 247 s | — | — |
| Arvind Krishna | 372 s (6.2 min) | 23 / 220 / 48 | 4.6 s / 6.4 s | 234 s | 104 s | **7.9 min** |
| Ana Botín | 462 s (7.7 min) | 27 / 258 / 40 | 4.7 s / 6.8 s | 191 s | 152 s | **10.2 min** |
| Chimamanda Ngozi Adichie | 544 s (9.1 min) | 18 / 176 / 82 | 5.2 s / 7.5 s | 421 s | — | — |
| Bong Joon-ho | 824 s (13.7 min) | 36 / 343 / 117 | 5.2 s / 8.6 s | 643 s | 102 s | **15.4 min** |

Sources: `artifacts/person-benchmark/live-discovery-expanded-129458a747d3e069-*.operation.json`
and the matching `*.person.json` (`assessedAt`) in the `chief-of-staff-239-arm` checkout (read-only).
Two people already meet the ≈5-minute end-to-end goal; the median needs ≈2 min removed and the
tail needs policy, not plumbing: Bong's 643 s model-sum over 824 s elapsed is model-bound, and
his 36 rounds are the completion contract working as written, not a scheduler failure.

### Completed 4-person validation run `db8939daf4ad079e` (same shapes, older code)

| Person | Research elapsed | Requests / calls | Model sum | Identity-unmatched discards |
| --- | ---: | --- | ---: | ---: |
| Achim Steiner | 279 s | 140 / 14 | 73 s | 70 |
| Ana Botín | 368 s | 189 / 29 | 155 s | 78 |
| Anders Danielsson | 386 s | 233 / 19 | 85 s | 127 |
| Arvind Krishna | 713 s | 444 / 63 | 305 s | 188 |

Sources: `live-discovery-expanded-db8939daf4ad079e-*.operation.json` (`operational.elapsedMilliseconds`,
`requests`, `modelCalls`) and attempt-stage censuses in the `chief-of-staff-speed-validation`
checkout. Consistent with the live run: model time is the largest single component, HTTP volume
is second (122–444 recorded requests per operation — the operation's accounting, not a census of
every downstream request inside provider fan-out), and 54–188 fetched documents per operation
are discarded at identity matching after their fetch cost is already paid.

### Judge anatomy (Ana Botín, `db8939daf4ad079e`)

Her `modelAttempts` record two judge calls on `z-ai/glm-5.3-flash` at high reasoning effort:
call 1 with 19,834 input chars (recovery: statements only), call 2 with 68,097 input chars
(support: full claims plus citations), the second retrying once after a 90 s `request_timeout`
(`timeoutMs: 90000`) before succeeding (6,179→24,163 input tokens, ~3–3.8k output tokens each).
Source: `live-discovery-expanded-db8939daf4ad079e-ana-botin.person.json`, `result.assessment.modelAttempts`.
The judge's reasoning effort pin (`JUDGE_REASONING_EFFORT = "high"`,
`apps/server/src/person-benchmark/judge.ts:21`) and 300 s-class ceilings are ADR-0074
conditions — the *shape* of the judge phase (two sequential independent calls) is not.

## Evidence table

| Fact | Source |
| --- | --- |
| Research 155–824 s, 11–36 rounds, 122–444 requests, 3–117 model calls per operation | `129458a747d3e069-*.operation.json` (`startedAt`, `finishedAt`, `rounds`, `requests`, `modelCalls`) |
| Model calls median ≈4.4–5.4 s, p95 ≈5.3–8.6 s; sums 14–643 s per operation | same, `attempts` with `code: model-call-metrics`, `observed.modelCallDurationMilliseconds` |
| Judge phase adds 37–152 s per person after research | same run, operation `finishedAt` vs person `assessedAt` |
| Judge = recovery (19.8k chars) + support (68.1k chars) at high reasoning; one 90 s timeout+retry | `db8939daf4ad079e-ana-botin.person.json`, `result.assessment.modelAttempts` |
| 4 model documents globally; 8 readers globally, 2 per host (1 after slow/failing reads) | `apps/server/src/person-profile/research.ts:207`, `source-scheduler.ts:15,52-53`, `pipelines.ts:71-80` |
| Read batch = 2× readConcurrency (= 8); as-ready handoff already implemented | `research-policy.ts:152-154`, `research.ts:1149-1158` |
| Research/judge queues already separate; next research starts while judging runs | `person-benchmark/evaluate.ts:225-249` |
| All model calls already stream over SSE with idle/silent/absolute ceilings | `llm/providers.ts:539-860` (`postSseStream`), `packages/shared/src/llm.ts:16-77` (300 s / 120 s / 30 s / 90 s / 250k chars) |
| Search fans out over ~40 providers per query and merges only after all settle | `source-adapters/search.ts:192-274`, `providers/index.ts` (registration order pinned per ADR-0049) |
| Per-provider 20 s deadline; provider latencies already diagnosed per pass | `search.ts:65` (`IO_TIMEOUT_MS`), `search.ts:53-62` (`PublicSearchDiagnosticEvent` with `ms`) |
| Every HTML page pays JSDOM + full anchor harvest + Readability, even failures | `person-profile/research-readers.ts:744-765` |
| Readability ships `isProbablyReaderable` fast pre-check and tunable thresholds | [Readability README](https://github.com/mozilla/readability) (`isProbablyReaderable`, `charThreshold`, `maxElemsToParse`) |
| No connection-pool, keep-alive, DNS-cache, or dispatcher tuning anywhere | repo-wide grep for `Dispatcher|setGlobalDispatcher|keepAlive|autoSelectFamily|cacheable` finds only unrelated `lookup` matches; `source-adapters/http.ts:86-132` builds plain global-`fetch` transports |
| Built-in `fetch` is undici-powered with automatic gzip/deflate/br; the `undici` module adds pooling control, pipelining, and faster paths | [undici docs](https://undici.nodejs.org/) ("Undici vs. Fetch", benchmark tables) |
| undici `Agent` exposes `connections`, `pipelining`, `keepAliveTimeout`, `keepAliveMaxTimeout`, `connectTimeout`, `bodyTimeout`, `headersTimeout`, installable via `setGlobalDispatcher` or per-request `init.dispatcher` | [undici Agent](https://undici.nodejs.org/api/Agent) and [Fetch](https://undici.nodejs.org/api/Fetch) docs (second-agent verified) |
| Production proof of the exact spelling: pnpm tunes the global dispatcher (`keepAliveTimeout: 30000`, `keepAliveMaxTimeout: 600000`, `connect: { autoSelectFamily: true }`); gemini-cli and promptfoo ship keep-alive/timeout-tuned global dispatchers | [pnpm dispatcher.ts](https://github.com/pnpm/pnpm/blob/main/pnpm11/network/fetch/src/dispatcher.ts), [gemini-cli fetch.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/fetch.ts), [promptfoo fetch](https://github.com/promptfoo/promptfoo/blob/main/src/util/fetch/index.ts) |
| CORRECTION: Node documents no DNS result cache — `lookup()` uses OS `getaddrinfo` on the threadpool; Happy-Eyeballs `autoSelectFamily` defaults true on `net` sockets but false/250 ms on the undici `Client` | [Node DNS docs](https://nodejs.org/api/dns.html) (lookup, setDefaultResultOrder, implementation considerations), [undici Client](https://undici.nodejs.org/api/Client) |
| Per-request retries sleep up to 8 s (rate-limit) / 4 s (transport) inside the read | `research-readers.ts:1961-2018` |
| Conditional GET is plumbed but person-research readers never send validators | `source-adapters/http.ts:103-104` sends `if-none-match`/`if-modified-since` when given; only content-scout adapters pass them (`rss.ts:138-141`, `reddit.ts:222-225`, `website.ts:45-48`) |
| Extraction parts of one document run strictly sequentially inside one model slot | `research.ts:779-780` (`for … of partTexts.entries()`), executed inside `modelWork.run` (`research.ts:1203-1221`) |
| Each part call carries `outboundUrls.slice(0, 80)` plus the full person envelope | `research.ts:784-807` (`partUser`); Ana averaged ≈12.4k input chars per call (359,802 chars / 29 `model-call-metrics`) |
| Judge recovery and support inputs are independent; calls are awaited in order | `judge.ts:236-275` (recovery), `judge.ts:362-384` (support, built from `claims` + source metadata only) |
| linkedom states linear scaling and anti-bloat goals vs JSDOM, but publishes no comparative numbers — only a local benchmark command | [linkedom README](https://github.com/WebReflection/linkedom) (FAQ "Why 'not too close'?", "Benchmarks") |
| Adaptive per-host throttling prior art: delay = latency/N, errors must not speed the crawler up | [Scrapy AutoThrottle](https://docs.scrapy.org/en/latest/topics/autothrottle.html) (algorithm rules 2–4) |
| Curated consensus: cheerio (20 lists) dominates server scraping, but Readability needs a `Document`, which cheerio does not provide — linkedom stays the candidate for the Readability path, with production composition proof (`parseHTML` → `new Readability(document)` in openclaw, n8n, brigade) | context-awesome corpus survey; [openclaw extractor](https://github.com/openclaw/openclaw/blob/main/extensions/web-readability/web-content-extractor.ts), [n8n fetch-and-extract](https://github.com/n8n-io/n8n/blob/master/packages/cli/src/modules/instance-ai/web-research/fetch-and-extract.ts) |
| Negative result: no public-repo file combines many-fetch fan-out + soft deadline + keep-fast + abort-stragglers (only fail-fast aborts and bare `allSettled`) — the pass deadline must be hand-rolled, not copied; none of Bottleneck/p-queue/p-limit advertises per-task deadline semantics | public-repo code search; curated descriptions via context-awesome |
| Judge-cascade papers: calibrated escalation cuts inference cost 31% at fixed quality ([UCCI](https://arxiv.org/abs/2605.18796)); small-model agreement gating cuts price/token 2–25× ([ABC](https://arxiv.org/abs/2407.02348)); long-prompt serving analysis ([Sarathi-Serve](https://arxiv.org/abs/2403.02310)); yield-based crawling matches prior recall with 21% of URLs ([Craw4LLM](https://arxiv.org/abs/2502.13347)) | arXiv abstracts via arXiv MCP |
| Prompt-split papers: modular decomposed prompts beat monolithic ones ([Decomposed Prompting](https://arxiv.org/abs/2210.02406)); sequential subproblem grounding ([least-to-most](https://arxiv.org/abs/2205.10625)); mid-context underuse ([Lost in the Middle](https://arxiv.org/abs/2307.03172)); atomic-fact verification within <2% of human error ([FActScore](https://arxiv.org/abs/2305.14251)); whole-response judgments mask per-item failures ([MCJudgeBench](https://arxiv.org/abs/2605.03858) — a 2026 paper, treat as early evidence) | arXiv abstracts via arXiv MCP |
| Production proof of staged extraction and decomposed judging: claim-ledger synthesis, `_extract_claims` → per-claim verification loops, covariate extractors feeding later summarize calls, RAGChecker `extract_claims` → `check_claims` gated by metric requirements, per-window faithfulness composed later, nano-graphrag cheap/best model tiering | [deep_research_lab](https://github.com/ed-donner/agents/blob/main/2_openai/community_contributions/eliza_zadura/deep_research_lab/research_manager.py), [Shannon verify.py](https://github.com/Kocoro-lab/Shannon/blob/main/python/llm-service/llm_service/api/verify.py), [GraphRAG extract_covariates](https://github.com/microsoft/graphrag/blob/main/packages/graphrag/graphrag/index/operations/extract_covariates/extract_covariates.py), [RAGChecker](https://github.com/amazon-science/RAGChecker/blob/main/ragchecker/evaluator.py), [deepeval](https://github.com/confident-ai/deepeval/blob/main/deepeval/metrics/turn_faithfulness/turn_faithfulness.py), [nano-graphrag](https://github.com/gusye1234/nano-graphrag/blob/main/nano_graphrag/graphrag.py); curated via [awesome-llm](https://github.com/hannibal046/awesome-llm) (27k stars), [awesome-llm-apps](https://github.com/Shubhamsaboo/awesome-llm-apps) (137k), [awesome-llm-judges](https://github.com/haizelabs/awesome-llm-judges) (ChatEval, G-EVAL, JudgeBench) |

## Safe-now levers

### 1. Overlap the judge's two calls (≈1–2 min/person, low risk)

The seam is `judgePerson` (`apps/server/src/person-benchmark/judge.ts:212-463`): the recovery
reply (references × statement-only claims) is awaited, its verdicts are mapped to judgements,
and only then is the support reply (full claims with citations + retained-source metadata)
requested. The support input does not depend on the recovery output — both are built from the
function arguments — so the two `judgeReply` calls can run concurrently with byte-identical
inputs, schemas, bindings, and validation. Ana's record shows why this matters: two
high-reasoning calls, the larger at 68k input chars with a 90 s timeout and a 500 ms-delayed
retry, sequenced end to end. Overlapping them removes roughly one judge-call latency from
every person's end-to-end time (observed judge phases: 37–152 s), at zero semantic cost.
Measure in `result.assessment.modelAttempts` (attempt counts, outcomes, token usage must match
the sequential baseline arm); A/B the full 30-person arm once, since the judge-queue wait
component only shows at population scale. This does not change pins, ceilings, prompts, or the
judge version — the already-separate research/judge worker queues
(`evaluate.ts:225-249`) are untouched.

### 2. Deadline each search-fan-out pass (≈1–3 min/person, low–medium risk)

The seam is `runPass` (`apps/server/src/source-adapters/search.ts:169-315`): one `Promise.all`
over ~40 providers with a 20 s per-provider deadline, and the merge — and therefore the round —
waits for the slowest provider. With 11–36 discovery rounds per operation, every second of
straggler tail is paid per round. The fix is a soft pass deadline, not a provider cut: resolve
the merge when the historically fast, high-yield providers have answered plus a short grace
period, keep accepting late results opportunistically into the next round's pool, and cancel
stragglers with the `AbortController` pattern the readers already use. No provider becomes
ineligible (ADR-0063/ADR-0049 intact), registration-order dedupe is unchanged, and the
`PublicSearchDiagnosticEvent` `ms` field (`search.ts:53-62`) already records per-provider
latency to pick the deadline and to prove which providers were cut how often. Quality risk is
a slow provider's unique results arriving one round late rather than on time; bound it by
exempting the first round (seed coverage) and by logging cut-provider yield. Needs a live A/B:
replay cannot reproduce provider tail latency. This is the largest research-phase lever because
it multiplies across rounds instead of adding once.
Code search sharpens the build-vs-buy answer: no public-repo file demonstrates the full soft-deadline fan-out (many fetches, keep fast results, abort stragglers) — found only fail-fast shared-abort fan-outs and bare `Promise.allSettled` keep-fast patterns — so this lever is custom scheduling at the `runPass` seam, not an adopted snippet. Likewise the curated queue libraries do not solve it: Bottleneck (11 endorsements) is the only true throttler but none of Bottleneck/p-queue/p-limit advertises per-task deadline/`AbortSignal` semantics in its curated description, so deadline logic stays hand-rolled regardless of which, if any, is adopted for bookkeeping.

### 3. Pool HTTP connections (≈0.5–2 min/person, low risk)

The seam is `createHttpFetch`/`createHttpBytesFetch` (`apps/server/src/source-adapters/http.ts:86-132,
157-190`): plain global-`fetch` calls with per-call `AbortController` timeouts and no dispatcher
configuration, despite 122–444 requests per operation scattered across dozens of hosts. Each
cold host pays TCP+TLS setup before the first byte; connection reuse removes it. The primary
sources draw the boundary precisely: Node's built-in `fetch` is undici-powered with automatic
gzip/deflate/br handling, while the `undici` module exists for "fine-grained control over
connection pooling", "HTTP/1.1 pipelining support", and measurably faster request paths on
their own benchmarks ([undici docs](https://undici.nodejs.org/)). So: install a shared
dispatcher with keep-alive tuning behind the existing `PublicHttpFetch` signature (no caller
changes), keep the 20 s per-request ceiling and the SSRF guard exactly as they are, and
measure handshake vs transfer time per host from the existing `elapsedMilliseconds`
observations plus a new connect-timing probe. Exact knobs are confirmed in the official
[Agent](https://undici.nodejs.org/api/Agent) docs (`connections`, `keepAliveTimeout`,
`keepAliveMaxTimeout`, `connectTimeout`, `bodyTimeout`, `headersTimeout`) with the
production spelling proven by pnpm/gemini-cli/promptfoo (global dispatcher + keep-alive
timeouts + `connect.autoSelectFamily`). DNS deserves its own line item rather than a vague
"cache" mention: Node documents *no* DNS result cache (`lookup()` = OS `getaddrinfo` on the
threadpool), so every request re-resolves from scratch today, and the undici `Client` leaves
Happy-Eyeballs `autoSelectFamily` off (250 ms) where `net` sockets default it on — both are
verified ([Node DNS](https://nodejs.org/api/dns.html), [undici Client](https://undici.nodejs.org/api/Client))
against the `dns-failed` failure class the codebase already tracks
(`research-diagnostics.ts:218-220`).
All estimates: handshake savings are per-request milliseconds × hundreds of requests, so this
needs a live A/B against the run-log baseline; it changes no semantics, only sockets.

### 4. Gate HTML parsing, then re-measure the parser (≈0.5–1.5 min/person, low risk)

The seam is `readHtml` (`apps/server/src/person-profile/research-readers.ts:738-823`): construct
a full JSDOM, harvest up to 200 outbound URLs, then run Readability — on every page, including
the 13–93 per-operation pages that end as `document-empty` and the challenge pages that are
then parsed *again* on the render path (`tryRender`, second JSDOM at line ~833). Three
ordered steps, each safe: (a) move the outbound-URL harvest after the Readability success
check so failed pages skip it; (b) gate Readability with its own fast pre-check —
`isProbablyReaderable` exists precisely "to avoid bogging down a time-sensitive process …
with the complex logic in the core of Readability"
([Readability README](https://github.com/mozilla/readability)) — while keeping the current
behavior as the fallback when the gate disagrees, logged so false-negative rate is measured,
not assumed; (c) only then A/B the DOM itself. On the DOM swap, the honest position is that
linkedom claims linear scaling and freedom from JSDOM's bloat/slowness in its FAQ but
publishes no comparative numbers (benchmarks are a local `npm run benchmark` command —
[linkedom README](https://github.com/WebReflection/linkedom)), and Readability's own Node
example uses jsdom ([README](https://github.com/mozilla/readability#nodejs-usage)), so
Readability-over-linkedom compatibility and fidelity must be proven on saved hostile pages
(tracking wrappers, CJK content, multi-byte offsets — citation offsets must be byte-identical)
before any cutover. Add a parse-time probe first (`dom-parse` milliseconds on the attempt
record): if JSDOM averages single-digit milliseconds, kill this lever; the current code has no
such probe, so parser cost is today an unmeasured belief. Offloading parse to
[worker threads](https://nodejs.org/api/worker_threads.html) stays a fallback if probes show
parse blocking the event loop rather than just costing microseconds of CPU.
Two corpus findings qualify the parser choice. First, the curated consensus favors cheerio
(20 endorsing lists) over jsdom (3), linkedom (2) and happy-dom (1) for server scraping —
but cheerio provides no `Document`, which Readability requires, so adopting cheerio would
mean replacing Readability with selector-based extraction, a far larger change than swapping
the DOM under Readability. linkedom therefore stays the candidate for *this* seam, and it
now has production composition proof: openclaw, n8n's web-research module, and brigade all
run `parseHTML(html)` → `new Readability(document).parse()` in production code (links in the
evidence table). Second, the `isProbablyReaderable` gate is likewise proven in the wild
(OpenCLI's article path gates on it with a force bypass; Joplin's clipper uses it as its
readability pre-check).

### 5. Slim extraction inputs (≈0–1 min/person, needs a quality A/B)

The seam is the `partUser` construction (`apps/server/src/person-profile/research.ts:784-807`):
every one of the up-to-four part calls per document carries `outboundUrls.slice(0, 80)` — up to
80 URLs, several kilobytes, on a call whose job is extracting facts from *this* part's text —
plus the full person envelope repeated per part. Ana's 359,802 input chars over 29 calls
(≈12.4k/call) show the scale. Trim the parts with no plausible extraction value (cap outbound
URLs to a small relevant handful or drop them where expansion demonstrably never consumes
them; hoist the invariant person envelope out of per-part repetition only if the call shape
allows — anything that changes part boundaries or the schema is an owner decision, §Owner
decisions). Two honest caveats: output discipline is already harvested (`compactWireNames`
cut output tokens 21% and wall time 15% per the comment at `research.ts:847-852`, issue
#232), so the remaining input-side win is bounded; and whether Mercury's diffusion decoding
is input-size-sensitive at all is unproven in this repo — per-call durations correlate weakly
with input chars across the two runs, so this lever could measure near zero. The A/B must
score supported-reference recovery, not just minutes, because prompt text changes are prompt
changes even when pins are untouched.
Serving-side theory supports cutting input length where it is free: Sarathi-Serve's analysis
shows long prompts stall throughput via prefill/decode imbalance, addressed with
chunked-prefills and stall-free scheduling ([paper](https://arxiv.org/abs/2403.02310)) — on
hosted OpenRouter routes we cannot reschedule the server, so the actionable half is keeping
prompts short and chunked, which is exactly what the part envelope plus slimming does.

### 6. Budget retry sleeps (tail only, ≈0–0.5 min, low risk)

The seam is `request` (`apps/server/src/person-profile/research-readers.ts:1925-2022`): up to
three attempts with `min(8000, 500·2^attempt)` sleeps on rate-limits and `min(4000, …)` on
transport errors, inline in each read slot. With 23–64 `retrieval-recovered` events per
operation these sleeps are usually overlapped across the 8-reader pool and invisible — except
at the round tail, where one sleeping slot holds the handoff queue open. Cap the *sum* of
sleep per round (or let the round close around sleeping reads and admit them next round),
keep honoring `Retry-After` within the cap, and keep the per-request recovery records so the
census of upstream behavior survives. Small by construction; do it only with the other
levers, never alone.

## Explicitly killed (evidence refutes or preempts)

- **"Add streaming to model calls."** Already streams: `postSseStream`
  (`llm/providers.ts:539-860`) with 30 s idle / 90 s silent / absolute ceilings and runaway
  (repetition/overrun) early-abort. Nothing to add without changing what a call *means*.
- **"Negotiate brotli/compression."** Already automatic: built-in fetch handles gzip, deflate,
  and br per the [undici docs](https://undici.nodejs.org/).
- **"Add conditional GETs to person research."** Plumbed (`http.ts:103-104`) but pointless
  within one operation: the lead registry dedups exact URLs (predecessor §1, implemented), so
  revalidation rarely triggers; cross-person revalidation is the run-scoped-reuse owner
  decision below, not a transport ticket.
- **"Overlap judge with next person's research."** Already overlaps: separate `judgeWork`
  limiter, workers take the next person immediately (`evaluate.ts:225-249`). The remaining
  judge latency is the two sequential calls *within* one person's assessment (§1), not queueing.
- **"Parse in parallel / raise reader concurrency."** Readers are already as-ready with
  head-of-line avoidance (`source-scheduler.ts:8,66-84` — a busy host cannot block another
  host's read). The serial part is *within* one document's extraction parts (§next); raising
  the 8/2/1 scheduler limits or the 4-model-document limit is an owner decision (below), and
  doing it blind multiplies provider contention the limiters exist to prevent.
- **Within-document part parallelism without a limiter redesign.** Parts run inside one
  `modelWork.run` acquisition (`research.ts:1203-1221`); acquiring the same capacity-4 limiter
  from inside its own slot deadlocks when all slots nest. Safe only with a separate part-level
  queue — real redesign for a bounded win (most documents need 1–4 parts while 4 documents
  already extract concurrently). Park until probes show part-serialization on the critical path.

## Owner decisions (measurement-condition changes — priced, not proposed)

These change call shapes, pins, ceilings, reuse scoping, or completion semantics, so under
ADR-0063 they belong to Nicolas. Each carries its measured price tag:

1. **Per-person time slicing / stopping policy.** Bong Joon-ho (36 rounds, 116 calls, 824 s)
   and Chimamanda (82 calls, 544 s) prove the tail is expansion policy: deterministic
   expansion plus quiet-rounds keeps spending while *anything* is found. A discovery cutoff
   (e.g. stop opening new leads at minute 4, spend the last minute extracting/publishing)
   would cap every person near 5 min — at the cost of redefining `completed` and the 24/30
   threshold semantics. ADR-0075 already ranks selection by yield/latency; a cutoff goes
   further and needs a new acceptance comparison.
   A research direction with hard numbers now backs yield-first scheduling: Craw4LLM shows
   downstream-equivalent recall from 21% of crawled URLs by prioritizing expected influence
   ([paper](https://arxiv.org/abs/2502.13347)) — the licensed version of "stop opening leads
   that will not move recovery," still a completion-semantics change, still owner-owned.
2. **Judge input shape and effort.** The 68k-char support call is the biggest single call in
   the pipeline; judging claims-only, sampling claims, or lowering the high-reasoning pin
   would attack it directly — and would change the judge version/configuration that every
   comparison holds fixed (`judge.ts:21-32`, ADR-0074). Price of the status quo: ~1–2.5 min
   of judge phase per person plus the observed 90 s-timeout retry class.
   Two judge-cascade papers price the alternatives: calibrated cheap→strong escalation cuts
   inference cost 31% at fixed quality ([UCCI](https://arxiv.org/abs/2605.18796)), and
   small-model agreement gating cuts price/token 2–25× ([ABC](https://arxiv.org/abs/2407.02348)).
   Both change the judge configuration comparisons hold fixed — owner-owned, but no longer
   unpriced.
3. **Raising the 4-model-document limit.** Model sums (up to 643 s) dominate elapsed, but the
   limit is shared across 4 concurrent people and guards provider contention plus cost;
   raising it needs a `modelWork` queue-wait probe first (unmeasured today) and reprices the
   whole arm, not one person.
4. **Call-shape changes (coalescing / re-slicing).** Fewer, bigger calls (or a different part
   envelope than four 16k parts) reverses ADR-0074's small-call finding and re-opens the
   `answer_not_json`/binding-recovery failure mode it fixed. Any such experiment needs its
   own conditions row and arm.
5. **Run-scoped cross-person source reuse.** Shared list/organization pages (e.g. employer
   Wikipedia pages) are re-fetched per person because ADR-0075 scopes exact reuse
   per-revision-plus-operation deliberately (independence of evidence). Widening the scope
   would save fetch time across the arm but lets one fetch corroborate two dossiers —
   exactly what the scoping forbids.
6. **Ceilings and allowances.** 120 s small-call ceiling, 300 s judge ceiling, 180 calls /
   900 s per operation are ADR-0074 pins; the 90 s silent ceiling already bit once (Arvind's
   support assessment in the predecessor run). Shortening ceilings saves minutes only by
   abandoning work, which is a quality decision wearing a latency costume.
7. **Granular prompt-split seams.** A dedicated agent mapped all four prompt seams and priced
   every split against the 180-call allowance at ~5 s/call. Two survive to A/B, both
   owner-decisions on call-shape grounds: **E2 extract-then-structure** — call A extracts
   claims + verbatim citations + current-state facts, call B builds works + expertise +
   connections + sections on A's claim IDs (least-to-most grounding, halves per-call
   constraints, moves middle rules out of the lost-in-the-middle zone; production template:
   claim-ledger synthesis and `_extract_claims` → verify loops above). Typical operations
   grow ~20→35 calls (+~75 s model-sum, fits 180); heavy ones (~100 calls) would reach ~190
   and go bounded — so E2 ships only with recovery parity plus a no-rise in heavy-op
   bounded rate. **J2b scores-vs-overclaims** — split the support call into usefulness
   scoring and overclaim hunting (FActScore/MCJudgeBench: different judgments sharing one
   call today; RAGChecker's gated `extract_claims` → `check_claims` is the template); +1
   slow call (+~20–75 s), research calls unchanged. Killed with reasons: 3-way extraction
   split (triples price, no paper prices 2-way→3-way gains); planner split (input already
   ~8k chars — not a long-prompt problem, and it taxes 36-round outliers most); discovery
   claim split (already the atomic seam); per-fact / per-section recovery (N×20–75 s blows
   the 300 s judge ceiling 10–100×). Central missing number everywhere: no paper measures a
   quality-vs-calls Pareto for extraction splitting — it must be measured internally via
   fixed-document A/B with confusion-error counts (broadening-as-recovered, passage-quoted-
   as-claim, namesake, claimed-vs-demonstrated, personal-vs-team). Static cheap/best tiering
   (nano-graphrag) and learned task routers exist but route across *models*, which ADR-0074
   pins — doubly owner-owned. Retrieval early-exit sentinels (`NO_SEARCH_NEEDED`) are proven
   code but gate retrieval, not LLM support calls; per-claim confidence skipping has no
   convincing example and stays unproven.

## What this does to the 30-person arm (concurrency 4)

Per-person end-to-end ≈ research elapsed + judge phase. Safe-now levers remove an estimated
≈2–4 min from a typical 6–8 min person (judge overlap ≈1–2, fan-out deadline ≈1–3 shared with
research, transport/parsing ≈0.5–2 combined — overlapping savings, never additive), putting
typical people at ≈4–5 min without touching quality. Arm wall clock ≈ Σ(research)/4 +
judge-drain overlap: at 300 s median research × 30 / 4 ≈ 38 min research with the judge
draining concurrently behind the 4-wide `judgeWork` limiter. Outliers stay outliers until
owner decision 1: one Bong-class person occupies a worker for 14 min regardless of plumbing.
Recommendation: land levers 1–3 first (all measurable in existing artifact fields), A/B the
full arm once, then decide whether the remaining tail justifies a stopping-policy change.

## Measurement plan (what needs a live A/B to prove)

Deterministic replay first (saved discovery/reads with fixed provider responses), then a small
live cohort chosen for aliases, source noise, long documents, sparse footprints, and ambiguous
names — then the full 30-person acceptance population with corpus, provider, model, judge,
cache state, and network conditions recorded, per ADR-0075's comparison rule. Probe gaps to
close before claiming anything: per-read DOM-parse milliseconds (none exists), `modelWork`
queue-wait time (none exists), per-provider fan-out tail distribution (exists:
`PublicSearchDiagnosticEvent.ms`), per-host connect vs transfer split (partial:
`elapsedMilliseconds` only). Compare supported recovery, identity/integrity failures,
completion rate, first useful publication, total latency, request count, and provider cost —
and warm-cache effects against cold runs, never mixed.

## Research provenance and limits

Read-only investigation; no tracked file modified except this new note, no benchmark process
touched. Repo seams read at the pinned lines above; timings computed from the
`129458a747d3e069` (in-flight) and `db8939daf4ad079e` (completed) artifact families in the
`-239-arm` and `-speed-validation` checkouts. External claims cite the projects' own docs
(undici, linkedom, Readability, Scrapy, Node), arXiv abstracts, public-repo code, and
awesome-list curation; linkedom's speed advantage over jsdom is an unmeasured vendor claim
here, stated as such. Six parallel subagents gathered the web evidence via the arXiv,
context-awesome, and gh_grep MCP servers (papers, curated-tool rankings, real-world code
proof, prompt-split seams and creative examples) plus official-doc verification; their
negative results (no soft-deadline fan-out in the wild, no corpus entry for DNS caching or
JS trafilatura ports, no quality-vs-calls Pareto paper, per-claim skip unproven) are
reported, not hidden. Minute estimates are estimates from observed component sizes, labeled
per lever, and explicitly non-additive. No production change, model sweep, or acceptance
arm was introduced by this research.
