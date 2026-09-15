# Why the extraction Result Shape is "unusable" for small models — and how to make any model serve it

_Researched 2026-09-14. Repo facts are pinned to file and line; external findings were gathered by
three parallel primary-source agents (§4) and cite their owning documents. Builds on, and does not
repeat, [structured-extraction-determinism.md](structured-extraction-determinism.md) (the same seam,
determinism axis), [person-research-github-patterns.md](person-research-github-patterns.md)
(orchestration prior art), and ADR-0074 (the small-call shape this note assumes)._

## 1. The failure, as observed

A Person Research Operation extracts each retained document in bounded Extraction Parts (≤16k
characters, ≤4 per document — ADR-0074). On the configured model `inception/mercury-2.5` via
OpenRouter, every extraction part call fails the same way, while planning calls on the same model
succeed in the same window:

| Observation | Value | Where recorded |
| --- | --- | --- |
| HTTP status | 200 (the request is accepted and answered) | container probe, 2026-09-15T03:1xZ |
| `content` | `null` — no answer bytes at the binding's field | model timeline ledger, `person-research:extraction` |
| `finish_reason` | `"length"` — the answer stopped at a token budget | same probe, same call |
| Wall clock | ~1 s | ledger |
| Classification | `unusable_shape` | ledger; text: "the reply carried no answer where the binding puts it" (`apps/server/src/llm/failure.ts:346`) |
| Same model, small schema | HTTP 200, populated answer, <1 s | container probe with a reduced schema |
| Same key, plain completion / small `json_schema` / `json_object` | all succeed | container probes, same window |

So "unusable shape" does not mean the shape is invalid. It means the reply carried nothing where
the binding puts the answer, and the operation's Extraction Health latched: zero Person Claims
published, operation interrupted ("Model-provider failure interrupted research" — mislabeled; the
provider answered promptly and correctly structured small answers all along).

## 2. Why the shape is unusable for this model — the mechanism

Three facts compose, each grounded in the seam:

1. **The binding demands a full conformance tree in the output.** `wireJsonSchema`
   (`apps/server/src/llm/providers.ts:382-391`) converts our zod schema for the OpenAI-style strict
   binding with the comment: "caller's (all fields required, nullable optionals) because OpenAI
   strict json_schema rejects non-required properties" — every field becomes `required`, optionals
   go nullable. The shape is large: 11 top-level fields (`sourceIds, claims, works, expertise,
   connections, sections, fullName, employer, sourceClass, author, publishedAt`), and each claim
   item carries 13 fields including nested `citations`, `supports`, `supersedes` arrays. The wire
   schema serializes to **~8.0 KB compact (~2.3k tokens) with everything inlined**
   (`zodToJsonSchema(..., { $refStrategy: "none" })`, `extraction-parts.ts:61-63`). Whatever the
   model writes must instantiate that tree even where the part's text supports nothing.

2. **The request sets no output budget; the upstream's default decides, and reasoning bills
   inside it invisibly.** `chatCompletionBody` (`providers.ts:1376-1426`) sends `model`,
   `messages`, optionally `temperature`/`seed`/`reasoning`, and the binding — **no
   `max_tokens`/`max_completion_tokens`** (the Anthropic-shaped wire sends `max_tokens: 8192`
   explicitly, `providers.ts:1317-1318` — the asymmetry is ours). OpenRouter documents that an
   absent sampling parameter "is omitted … so the provider applies its own default", so Inception's
   default governs: `max_completion_tokens` — "including visible output tokens and reasoning
   tokens" — defaults to **16,384** for `mercury-2.5` (65,536 only at `reasoning_effort: "high"`),
   with effort defaulting to `medium` (docs.inceptionlabs.ai, §7). Our body sends
   `reasoning: { exclude: true }` (`providers.ts:1399-1406`): reasoning still runs, still bills as
   output tokens, and never lands in `content`. Under that wiring a completion can be spent
   entirely on invisible reasoning under a strict schema and arrive legally empty — Inception's own
   response schema permits `content: null` with `finish_reason: "length"`. [INFERENCE] the ~1 s
   reply cannot have burned the full 16,384 at Mercury's documented 1,107 tok/s, so the effective
   termination point sits lower and is documented nowhere; repo fixtures record the same empty
   answer under `finish_reason: "stop"` too (`tests/fixtures/debrief-golden/candidate-accounting-wide-final-2026-09-10/inception-mercury-2.5/…transcript….md.error.json`),
   so budget truncation is one compatible mechanism, not the only one.

3. **The recovery layer has no rung for this signature.** Binding recovery steps down only when
   the answer is *populated but unusable* ("unusable shape with content populated" — the
   mercury-answered-prose case, #239's addendum) or `answer_not_json`
   (`providers.ts:1826-1845`). An answer "empty everywhere" keeps its report and ends the call,
   because "an answer that is empty everywhere is not going to be better at the next binding".
   That rationale was written against the prose signature; under the output-budget mechanism the
   same empty answer *can* succeed at a smaller output obligation (§3.2, §3.4). The gateway adds
   nothing: OpenRouter's Zero Completion Insurance recognizes only "zero completion tokens AND a
   blank/null finish reason" — a `length` finish is not the insured class
   (openrouter.ai/docs/guides/features/zero-completion-insurance).

Mechanism summary: **the binding obliges an output the model's effective token budget cannot
deliver, and the reply is therefore empty at the only field the binding reads.** The schema text in
the request (~2.3k tokens) is secondary; the obligation in the *output* is what kills the call.
Nothing here indicts the provider transport: the probes answer in <1 s with HTTP 200.

## 3. Levers that let any model serve the shape — without changing the desired outcome

The desired outcome is fixed by the schema itself: per retained document, validated
`Extraction` (claims with verbatim citations + identity fields). Levers below keep that contract;
each is tagged (R) request-param/seam, (C) code post-processing/merge, (S) schema change with the
same downstream contract.

| # | Lever | Tag | Effort | Mechanism | Quality risk |
| --- | --- | --- | --- | --- | --- |
| 3.1 | **Send an explicit output budget and pin reasoning effort** — `max_completion_tokens` sized to the worst-case answer, and `reasoning.effort: "instant"`/`"low"` for extraction calls, as Inception's own prompt guide recommends for high-volume automations | (R) | S | Reasoning tokens bill inside the completion budget and are invisible under `exclude: true`; an explicit budget + pinned effort makes the visible answer dominate the spend | None — budget and effort only change what may be produced, never what is required |
| 3.2 | **Split the shape per dossier slice**: claims-only, identity-only, works/expertise/connections calls (per call, a small required tree); merge in code with the existing per-part id-prefix scheme | (C)+(S) | M | Each output obligation shrinks by an order of magnitude; union = today's shape | Merge conflicts across calls; covered by existing citation-grounding validation |
| 3.3 | **Binding recovery for the empty signature**: one bounded step-down to `forced_tool_call` (and its smaller effective constraint) before keeping the report | (R) | S | A weaker binding still constrains shape; some upstreams enforce it differently | Bounded: one extra call per part, then the report stands |
| 3.4 | **Model cascade per part**: cheap default stays; an empty-shape failure retries that part on a stronger configured purpose before the report stands | (C) | M | Fails over only the failing call; `extractionPartKey` already keys reuse by model identity, so checkpoints stay coherent | Equivalence provable on the acceptance pair (§6) |
| 3.5 | **Keep `$defs`/`$ref` instead of `$refStrategy:"none"`** where the serving upstream's strict mode supports it (OpenAI-family docs do) | (S) | S | Shrinks the request schema bytes; upstreams that cannot honor refs are excluded by `require_parameters` already | None on output obligation; smallest win, do opportunistically |
| 3.6 | **Evidence-first two-pass**: tiny shape extracts verbatim quotes (small obligation), second small call attributes them into claims | (C)+(S) | M–L | Both obligations small; quotes are cheap to emit | More calls; attribution quality must be re-proven on the acceptance pair |
| 3.7 | **Grammar-constrained serving** (xgrammar/outlines/GBNF) | — | N/A for hosted APIs | Forces conformance at decode time | Not available through OpenRouter today; a route-selection criterion, not a code change |
| 3.8 | **Describe the shape in the system prompt under every binding** — the schema-bearing `promptOnlySystem` framing is only sent under `prompt_only` today | (P) | S | Constrained models have no visibility into the schema (llama.cpp: "The JSON schema is only used to constrain the model output and is not injected into the prompt"; Fireworks: without it the model "may generate whitespace indefinitely until hitting token limits") | Low; the binding stays, the prompt adds the description |

Ordering follows cost of change against certainty of cause: the §5 probes first, then 3.1+3.8 in
the seam (one small change each), then 3.3, then 3.2/3.4 where a model is pinned to one that cannot
serve the whole tree even with a correct budget. 3.6 is the architecture answer if small models
are the goal rather than the constraint.

## 4. How other projects fixed this — agent findings

### 4.1 What the providers document (LimitsAgent)

- **Inception** (serves `inception/mercury-2.5`): the OpenAPI for `POST /v1/chat/completions`
  defines the budget as `max_completion_tokens`, "An upper bound for the number of tokens that can
  be generated for a completion, including visible output tokens and reasoning tokens"; defaults
  "For `mercury-2.5`, the default is 16,384; 65,536 when `reasoning_effort=\"high\"`", max 65,536;
  `reasoning_effort` defaults to `medium`. `Message.content` is nullable and `finish_reason`'s enum
  includes `length` — our signature is a legal completion, not a protocol violation. The
  structured-outputs page shows the same `response_format` binding with **no documented
  schema-size limit and no documented failure mode**; nothing covers grammar+reasoning or
  grammar+diffusion interaction. The Mercury 2.5 launch post claims "schema-aligned JSON" and
  1,107 tok/s.
- **OpenRouter**: strict enforcement "varies by provider: some guarantee schema-conforming output,
  while others translate your schema into their own structured-output format or treat it as a
  strong hint". Its error docs list exactly two structured-output failures ("Model doesn't support
  structured outputs", "Invalid schema") — both error out, neither is our 200-empty case. Omitted
  parameters are "omitted … so the provider applies its own default". Zero Completion Insurance
  covers only "zero completion tokens AND a blank/null finish reason" — `length` is not insured.
  The live endpoint metadata for mercury-2.5 declares `structured_outputs`, `response_format`,
  `reasoning`, `reasoning_effort` and `max_completion_tokens: 65536`.
- **What "too complex" legally looks like elsewhere**: OpenAI caps schemas at "up to 5000 object
  properties total, with up to 10 levels of nesting" and errors on unsupported `strict` keywords;
  cutoffs yield `incomplete`/`max_output_tokens`. Gemini: "Very large or deeply nested schemas may
  be rejected". Anthropic compiles schemas to grammars with explicit caps — "Schema is too complex
  for compilation" as a 400 — and on `stop_reason: "max_tokens"`: "output may be incomplete and
  not match your schema. Retry with a higher `max_tokens`".
- **Constrained-decoding engines**: llama.cpp — "Unsupported features are skipped silently" and
  "The JSON schema is only used to constrain the model output and is not injected into the
  prompt"; xgrammar raises `RuntimeError` on pathological schemas rather than emitting nothing;
  vLLM — guided generation "is not guaranteed to work" (issue #8350), and a pathological schema
  produced `finish_reason: length` with the full budget consumed (issue #52011). **Documented
  absence**: no engine or provider documents "schema too large ⇒ 200 + null content +
  `length`"; every documented too-complex outcome is a 4xx, a silently dropped constraint, or
  truncation with partial content.

### 4.2 How other projects fixed it (PriorArtAgent)

- **instructor** names our symptom class: `IncompleteOutputException` = "Output truncated due to
  token limit"; retries carry validator errors back to the model ("reask"); `Partial[T]` and
  `Iterable[T]` are the canonical big-array-to-N-small-shapes moves; its OpenRouter page requires
  `require_parameters: true` and, on routing failures, "we recommend using the JSON mode instead".
- **Grammar engines fail big schemas opaquely**: vLLM 400s on "features not supported by
  xgrammar" (issue #15236); nested-schema compile times run 1.3 s → ~160 s with no timeout (vllm
  #54003) and ">1k line json schemas" pinned CPU for hours (vllm #14151); outlines #658 shows
  length-capped schemas exploding past 32 GB of FSM. Every engine docs "describe the schema in
  your prompt" as the pairing remedy.
- **OpenRouter escape hatches**: `strict: true` can eliminate every eligible endpoint — their
  own ai-sdk-provider added `structuredOutputs: { strict: false }` because hardcoded strict
  "made it impossible to route requests to providers that don't advertise support for strict
  json_schema". The `response-healing` plugin fixes syntax only: "if the response is truncated by
  max_tokens, the plugin will not be able to repair it". No per-provider schema byte/token limits
  are published.
- **Schema compaction in production**: OpenAI's published ceilings force pruning; Vercel AI SDK's
  `anthropicSafe()` splits the schema in two — stripped keywords go on the wire, the original zod
  schema stays for `safeParse` — the cleanest template for "smaller wire schema, unchanged quality
  gate" (vercel/ai#13355). `$refStrategy: "none"` is self-inflicted bloat; ref support is
  provider-dependent (an MCP server hit 1190 rejected back-refs; Fireworks supports `$defs` and
  recursion); zod-to-json-schema is deprecated in favour of Zod 4's `reused: "inline" | "ref"`.

### 4.3 Architectures that let small models do big-shape work (SplitArchAgent)

- **Shrink the shape per call**: EDC (EMNLP 2024) — large schemas "easily exceed" the model, fix
  is open extraction then post-hoc canonicalization; Microsoft GraphRAG extracts per TextUnit,
  merges deterministically ("any entities with the same *title* and *type* are merged"), and buys
  recall with *gleanings* "without a drop in quality"; DocETL's decomposed plans run "25 to 80%
  more accurate than well-engineered baselines"; DocuDevs map-reduce requires a `dedupKey` because
  "the same row might appear in two chunks". Mapping to us: the Extraction Part is already the
  map; split the 13-field claim shape (claim spine vs. citations/supports/supersedes) and merge in
  code keyed by claim text + verbatim quote.
- **Evidence-first**: GraphRAG's claim prompt makes the quote a generated field; NuExtract
  (0.5B–7B, fine-tuned Phi-3) is "purely extractive" by construction. Mapping: pass 1 extracts
  verbatim spans (tiny shape); pass 2 attributes identity fields; our citation-grounding check
  becomes the pass-2 gate.
- **Cascades**: FrugalGPT (matches GPT-4 quality "with up to 98% cost reduction"); RouteLLM
  ("over 2 times" cost reduction "without compromising the quality of responses"); LiteLLM
  fallbacks fire on errors; Bedrock routes before generation on predicted quality. **Documented
  gap**: no router escalates on HTTP-200-with-empty-content — our `unusable_shape` classification
  is exactly the trigger a cascade needs, and no library provides it.
- **Verification without a big model**: self-consistency buys +17.9% on GSM8K; but "LLMs struggle
  to self-correct their responses without external feedback" — verify with code (schema +
  citation grounding), never with a self-critique round; cross-part agreement is GraphRAG's
  merge-by-(title,type) analogue; Anthropic's eval guide ranks code-based grading "Fastest and
  most reliable".
- **Distillation**: OpenAI Distillation fine-tunes a small model from stored teacher completions
  ("OpenAI Distillation uses the outputs of a larger model to fine-tune a smaller one"); HF TRL's
  GKD trainer adds Jensen-Shannon losses "when the student lacks the capacity to fully mimic the
  teacher"; NuExtract is the existence proof for extraction. Our checkpointed, validated
  Extraction Parts already are the (input, output) SFT pairs; OpenRouter exposes
  `enforce_distillable_text` for routing.
- **Prompt-side lifters**: chain-of-thought "does not positively impact performance for small
  models" and "actually hurts performance for most models smaller than 10B parameters" (Wei et
  al.); "stricter format constraints generally lead to greater performance degradation"
  (2408.02442); Anthropic recommends "Flatten structures where possible" and "Split into multiple
  requests", quantifying that "Each optional parameter roughly doubles a portion of the grammar's
  state space"; Inception's own prompt guide: "Providing a few (3–5) positive **and** negative
  example responses … is more effective in steering the model than simply describing the desired
  behavior", with `reasoning_effort: instant`/`low` named for "high-volume automations".
  **Not findable**: any Inception/Mercury schema-size guidance; any native per-claim-type
  schemas; any router that escalates on 200-but-empty.

## 5. Recommendation

_(Pending agent findings, then finalized: ordered levers with the smallest no-quality-loss change
first.)_

## 6. How to prove quality did not change

The repo's own machinery answers this. ADR-0079 freezes the acceptance pair (corpus
`14bca86ee0b97d28`, judge `z-ai/glm-5.3-flash`); the changed shape runs as an arm against the
frozen incumbent under `scripts/run-validation-campaign.mts`, and the Person Research Benchmark's
assessment gates (reference recovery, support, usefulness) decide equivalence. Any lever here that
cannot pass that gate is not adopted.

## 7. Sources

- `apps/server/src/llm/providers.ts:382-391` (strict conversion, all-fields-required), `:1376-1426`
  (OpenRouter body, no `max_tokens`), `:1317-1318` (Anthropic wire `max_tokens: 8192`),
  `:1826-1845` (binding recovery: prose steps down, empty keeps its report).
- `apps/server/src/llm/failure.ts:346` (`unusable_shape` classification text).
- `apps/server/src/person-profile/extraction-parts.ts:11-63` (ExtractionSchema, wire schema
  serialization); `:61-63` (`$refStrategy: "none"`).
- ADR-0074 (extraction in parts; the prose-binding signature and the step-down set).
- ADR-0091 (`inception/mercury-2.5` verbatim as the only permitted model string when Mercury is the
  chosen model; `DEFAULT_MODELS` is a separate concern).
- ADR-0079 (the frozen acceptance pair); CONTEXT.md _Extraction Part_, _Result Shape_,
  _Result Shape Binding_, _Model-boundary failure_.
- Observed-failure table (§1): container probes and the model timeline ledger recorded 2026-09-15
  during the live run; repro in issue #417.
