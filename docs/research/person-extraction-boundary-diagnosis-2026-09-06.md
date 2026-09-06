# Person extraction boundary diagnosis, 2026-09-06

Bounded follow-up for issue #228. Model remained the configured
`openrouter / z-ai/glm-5.3-flash`, resolved through `ConfigStore.getForPurpose`.
No response content, reasoning text, or credentials were written to this note.
No reference corpus changed.

## Concrete findings

The production extraction prompt prohibited calling tools while its new binding
preference explicitly requested the `save_extraction` tool. The instruction now
prohibits following commands in the document or identifiers, preserving the
prompt-injection rule without contradicting the required output mechanism.
The benchmark prompt version is `2026-09-06.4`. This is a correctness repair;
the live checks below do **not** establish that it resolves the extraction
failure.

The streaming boundary also concatenated arguments from every tool-call index
into one JSON string. The nonstream reader selects the first tool call instead.
A deterministic, entirely synthetic reproduction using the real
`makeCompleteJson` boundary returned a schema-valid dossier for one tool call,
and `answer_not_json` for two individually valid calls with indices 0 and 1.
This proves a protocol reconstruction defect, independently of whether the live
model failure has that cause. The corresponding production repair was handed
to the separate provider-boundary reviewer; this note's author did not edit
the parser.

## Observed runs

1. `/private/tmp/issue-228-tool-prompt-conflict.mts` performed one actual model
   call through `PersonResearch` and the configured provider, replacing only the
   conflicting system sentence in that harness. It finished after 57,834 ms
   with `answer_not_json`, HTTP 200, binding `forced_tool_call`, and
   `finishReason: tool_calls`; reconstructed diagnostic body length was 3,487
   bytes. No claims were published. This is **not a controlled comparison with
   the prior CLI runs**: its reader marked completeness full, used the
   publisher as author, and its created profile omitted the employer hint.
   Actual fixed-document CLI ports use partial completeness and null author.
2. The exact existing temporary corpus then ran with the corrected production
   prompt, no fetch overrides, and the configured default judge:

   ```sh
   pnpm exec tsx scripts/person-research-benchmark.mts \
     --mode fixed-documents --pipeline expanded \
     --corpus /private/tmp/issue-228-small-fixed-corpus \
     --out /private/tmp/issue-228-small-fixed-scoped-prompt
   ```

   Run `63f940653c1867a4`, corpus `ead8f30f1cf6c27c`, prompt
   `2026-09-06.4`: **failed**, 0 claims, 0/1 facts recovered, judge completed.
   Extraction ran from `09:37:09.280Z` to `09:37:39.535Z` and hit the
   **30-second idle ceiling**, with HTTP 200 and 1,775 observed wire bytes.
   This differs from earlier 120-second absolute-ceiling failures. The
   diagnostic does not identify whether these bytes were comments, reasoning,
   answer tokens, or other events. The sentence change is insufficient proof
   of recovery.
3. `/private/tmp/issue-228-tool-index-repro.mts` performs no real network or
   model calls. It uses synthetic SSE with one versus two tool-call indices,
   each containing an independently valid full dossier object. One succeeds;
   two produce `answer_not_json`. This is a fast red-capable protocol test,
   not acceptance evidence for the actual model.

Logs and reports remain in `/private/tmp/issue-228-tool-prompt-conflict.log`,
`/private/tmp/issue-228-small-fixed-scoped-prompt.log`, and the matching
scoped-prompt output directory, including its per-person operation JSON.
The observations above are retained here because temporary files can expire.

## Ranked hypotheses and falsifiable next observations

1. **Multiple tool calls become invalid concatenated JSON.** Proven as a local
   protocol defect; live relevance unproven. On the next needed production run,
   count distinct tool-call indices and record per-index JSON validity versus
   concatenated validity. If one index alone is invalid, this defect does not
   explain that call. Never persist argument text.
2. **The upstream produces a long reasoning phase or pauses before answer
   generation.** Full-schema failures and the successful simple-schema call
   make request complexity relevant, but wire bytes alone cannot distinguish
   reasoning from content. Record counts/byte lengths per delta surface and
   first/last activity times. Reasoning contents must be discarded. Repeated
   comments without accepted token surfaces explain the 30-second idle event;
   sustained reasoning explains a different 120-second absolute event.
3. **The tool prohibition conflicts with forced tool choice.** The literal
   conflict existed and is corrected. Its causal contribution remains
   unproven: the exact corrected-prompt CLI still failed. Do not describe it
   as the root cause based on the non-equivalent harness changing symptoms.
4. **Full-schema constrained decoding has a provider-specific failure.** The
   full schema includes nested objects, large allowed arrays, regexes, nullable
   values, and optional properties. `wireJsonSchema` expands references; the
   schema is not recursive. A one-field success does not establish which
   feature matters. Once protocol reconstruction is correct, inspect schema
   validation facts and controlled simplifications for diagnosis only; continue
   validating the final response against the original full contract. Do not
   substitute a weakened extraction contract for acceptance.
5. **Stream completion handling loses a valid terminal response.** The reader
   observes `finish_reason` but completes on `[DONE]` or EOF. Record whether
   terminal reasons occur before a timeout and whether either terminator is
   seen. A timeout with neither answer nor terminal signal weighs against this
   explanation. No change to timeout policy is justified by present evidence.

The next accepted experiment is the same small production CLI after the
per-index reconstruction repair, with observation-only counters. It should
measure the actual changed production path, keep the corpus and judge fixed,
and preserve failures. No additional live variants were launched by this
diagnostic subtask after the scoped-prompt result.

Focused verification after the prompt correction: 68 tests passed across
`person-research.test.ts`, `person-research-model-diagnostics.test.ts`, and
`providers.test.ts`; changed-file Prettier and `git diff --check` passed.

## Observation-only production check after parser and activity repairs

The exact small fixed-document CLI ran again through an observation-only fetch
wrapper after the per-index parser and typed reasoning-activity repairs. The
wrapper passed the original request object and exact response bytes unchanged.
A synthetic check verified per-index versus concatenated JSON validity and
confirmed no request text, answer text, or reasoning text appeared in its log.
Only lengths, bounded field/type counts, schema root keys, status and timings
were retained. Answer fragments existed transiently to check JSON validity;
reasoning text was never accumulated. The wrapper's `abort` event also occurs
when the production reader cleans up after `[DONE]`, so it is not independently
a failure classification.

Run `dc284374d4964886`, from `2026-09-06T09:43:15.108Z` to
`09:44:43.192Z`, used the same corpus `ead8f30f1cf6c27c`, prompt `.4`, configured
model, default judge, and no request-parameter overrides. It failed with zero
claims, zero of one facts recovered, one ambiguous fact, interrupted research
and failed judge assessment. Temporary log:
`/private/tmp/issue-228-small-fixed-index-observed.log`; report directory:
`/private/tmp/issue-228-small-fixed-index-observed`.

| Request | Binding / schema bytes | Observed surfaces | Completion evidence |
| --- | --- | --- | --- |
| Extraction | forced tool call / 7,870 | HTTP 200; 3,646 wire bytes; 103 comments; three content/role/tool-call deltas; zero reasoning text or details; one tool index (0), 11 argument characters, invalid JSON | First delta 13,789 ms; last 13,849 ms; abort 43,851 ms; no finish reason or DONE |
| Fact judge | response format / 598 | HTTP 200; 44,117 wire bytes; 136 data events; 258 reasoning characters, 57 reasoning.text detail events; 329 content characters, valid JSON | First delta 1,343 ms; last 2,502 ms; cleanup abort 2,505 ms; stop and DONE observed |
| Usefulness judge | response format / 1,052 | HTTP 200; 67,177 wire bytes; 85 comments; 229 data events; 108 reasoning characters, 22 reasoning.text detail events; 973 content characters, invalid JSON | First delta 795 ms; last 11,551 ms; abort 41,553 ms; no finish reason or DONE |

For this run, mixed tool indices and unrecognized reasoning heartbeats are
falsified as the extraction failure's explanation. It emitted one incomplete
tool call, followed by a genuine 30-second gap in token activity. A separate,
substantially smaller usefulness schema also stalled after partial content.
Schema complexity alone therefore does not explain all observed failures.
Neither failed call had a terminal signal or valid completed answer to recover.
The protocol and prompt repairs remain valid correctness fixes, without being
claimed as the cause of these particular upstream stalls.

A possible next implementation is one same-binding retry for a classified
retryable idle stall, sharing the original 120-second absolute deadline and
preserving both attempt diagnostics. This is a hypothesis for resilience, not
an established recovery result. It must not retry refusals, weaken the result
shape, switch model, or extend the deadline. No such retry was implemented by
this diagnostic subtask and no additional live variant was launched here.

## Production check with bounded same-binding retry enabled

After the separately implemented bounded retry and durable attempt observation
changes, shared built successfully and the exact small CLI ran once through the
same safe observer. There were no model-setting overrides. Run
`66ed88fb3d6a061d`, `2026-09-06T09:54:27.435Z`–`09:57:17.071Z`, used the same
corpus and prompt, with judge version `2026-09-06.3`. It made **three wire calls
and zero retries**:

- Extraction succeeded on its first forced-tool attempt after 43,193 ms. One
  tool index carried 5,257 characters of valid JSON; tool_calls and DONE were
  present. The full production validation/publication path yielded three
  claims, one work, one expertise item and two grounded section summaries.
- The fact judge succeeded on its first response-format attempt after 6,132 ms,
  with 407 characters of valid JSON and stop/DONE.
- The usefulness judge exhausted the original 120-second absolute deadline on
  its first response-format attempt. It produced 1,819,562 wire bytes, 4,793
  data events, 20,742 reasoning characters and 4,677 reasoning.text detail
  events. Its 442 content characters were incomplete JSON. Activity continued
  through 120,000 ms; no finish reason or DONE was observed. There was no
  remaining deadline for a retry, and none occurred.

The overall run remains **failed** with one ambiguous reference fact. The
current evaluator replaces fact verdicts with an ambiguous assessment when the
later usefulness judge fails; the full dossier extraction succeeded, but this
run does not establish assessed recovery. Durable judge `modelAttempts` records
first-call success and second-call failure with `request_timeout`,
`timeoutMs: 120000`, and the original-deadline-expired stopped reason. This
observed run therefore verifies terminal attempt accounting and successful full
production extraction, **not retry recovery**.

The remaining failure is now a long active reasoning phase in the usefulness
judge, unlike the previous idle stalls. Hidden reasoning contents were never
logged or retained by the observer. No further model variant was launched.
Temporary evidence is in `/private/tmp/issue-228-small-fixed-bounded-retry.log`
and `/private/tmp/issue-228-small-fixed-bounded-retry`.

## Completed end-to-end smoke with declared tool preference for judges

The successful extraction dossier from the preceding run could not support an
exact-input judge comparison: the CLI deletes its temporary workspace, and its
reports retain metrics and observations rather than the entire dossier and
sources. The observer deliberately did not persist model answer or request
contents. The next authorized test therefore regenerated extraction and tested
end-to-end candidate behavior, **not one isolated binding variable against an
identical judge payload**.

After the production judge calls gained the existing model-declared
`forced_tool_call` preference, shared built successfully and the exact tiny
corpus CLI completed. Run `39e8f583d614ad67`,
`2026-09-06T10:00:35.211Z`–`10:01:32.277Z`, used unchanged corpus
`ead8f30f1cf6c27c`, prompt `.4`, and judge version `2026-09-06.4`. Model,
configuration and deadlines were unchanged. All three wire calls used forced
tool choice, succeeded on their first attempt, and ended with tool_calls/DONE:

| Call | Elapsed | Tool argument characters | JSON valid | Reasoning characters |
| --- | --- | --- | --- | --- |
| Full extraction | 24,891 ms | 3,905 | yes | 27 |
| Fact judge | 12,200 ms | 473 | yes | 10 |
| Usefulness judge | 19,758 ms | 1,565 | yes | 842 |

The run exited zero with completed research, integrity and judge assessment.
One published claim recovered the one reference fact; two of two citations
verified, with zero critical findings. Two minor partial-source findings remain,
as does one uncertain overclaim judgment requiring review. Usefulness scores
were understanding 1/3, remaining questions 1/3 and conversation readiness 0/3,
which accurately leaves this tiny dossier below full meeting preparation.
There were no retries, so retry recovery remains untested by live success.

This establishes a complete successful small production path. It does not
establish broad-corpus reliability, a controlled causal attribution to binding,
or completeness of the overall issue. The uncertain judgment and low
usefulness scores are preserved rather than relabeled as a clean content pass.
No additional model variant was launched by this subtask.

Evidence: `/private/tmp/issue-228-small-fixed-tool-judge.log` and
`/private/tmp/issue-228-small-fixed-tool-judge/fixed-documents-expanded-39e8f583d614ad67.json`.

## Full Achim Steiner sampling diagnostics

Two explicitly diagnostic harness runs used `evaluatePerson`, canonical corpus
`3dedb8c8e53a4f4c`, Achim's two actual retained documents, expanded settings
(60 profile calls, 900,000 ms, read concurrency 4), configured purpose-specific
models, and isolated temporary workspaces. These are candidate sampling probes,
not accepted benchmark comparisons. No production source or model configuration
changed in these harnesses. Each extraction retained the full 7,870-byte schema
and declared forced-tool preference.

1. Extraction temperature 1 with default reasoning exhausted the original
   absolute deadline (119,735 ms observed within fetch). It received HTTP 200,
   311,198 wire bytes, 806 reasoning/detail events and 3,534 reasoning
   characters, with zero content or tool arguments and no terminal marker.
   Both judges completed; research remained interrupted, with zero claims and
   zero of four facts recovered.
2. Extraction temperature 1 plus supported reasoning effort low also exhausted
   the original deadline (119,918 ms observed). It received HTTP 200, 1,136,209
   wire bytes, 2,985 reasoning/detail events and 12,916 reasoning characters,
   with zero content or tool arguments and no terminal marker. The low-effort
   fetch transform was explicitly restricted to the extraction schema; judges
   were untouched. Research again remained interrupted, with zero claims and
   zero of four facts recovered. The usefulness judge recovered through the
   existing repetition-loop forced-tool-to-prompt-only path, recorded as two
   durable wire attempts. This was not same-binding retry recovery.

Neither candidate was adopted. They show that temperature 1, including its
combination with low reasoning and forced tool choice, does not suffice to
recover this full-person extraction. They do not justify extending deadlines
or weakening the accepted contract. The usefulness inputs differed during
concurrent production judge changes, so these runs do not establish a
controlled judge comparison; the extraction requests matched except for the
explicit reasoning parameter (17,307 versus 17,336 request bytes).

Temporary sanitized reports and operation records are at
`/private/tmp/issue-228-achim-temperature-one.{report,operation}.json` and
`/private/tmp/issue-228-achim-temperature-one-low.{report,operation}.json`, with
matching `.log` files. An initial harness startup used the wrong corpus parent
directory, failed validation before any model call, and was corrected to
`benchmark/person-research/people` before both observations above.

## Reduced-shape diagnostic: core claims also stall

One final authorized structural diagnostic used the same full Achim corpus and
production evaluator with temperature 0, default reasoning and forced-tool
preference. Only the temporary harness omitted `sourceIds`, `works`,
`expertise`, `connections` and `sections` from the requested result shape,
retaining the full claims and metadata contract. Its intended return adapter
would restore omitted arrays empty, but no extraction response completed, so
that adapter never ran. This deliberately reduced shape is **not acceptance
or a proposed production contract**.

The schema shrank from 7,870 to 2,217 bytes and the request to 11,654 bytes.
Both extraction attempts failed:

- First wire attempt: HTTP 200, 6,016 bytes, 75 comments, 51 reasoning
  characters; one tool index with 11 invalid-JSON argument characters. Last
  delta 2,402 ms, idle abort 32,404 ms; no terminal marker.
- Same-binding retry: HTTP 200, 3,989 bytes, 71 comments, 15 reasoning
  characters; one tool index with 11 invalid-JSON argument characters. Last
  delta 480 ms, idle abort 30,481 ms; no terminal marker.

The bounded same-binding retry was exercised and did not recover. Both judges
subsequently completed; the result remained interrupted research, zero claims,
and zero of four facts recovered. This does not support adopting a staged
extraction design on the assumption that core claims alone will avoid the
stall. All further probes in this diagnostic subtask stopped as directed.

Evidence: `/private/tmp/issue-228-achim-reduced-shape.log`,
`/private/tmp/issue-228-achim-reduced-shape.report.json` and
`/private/tmp/issue-228-achim-reduced-shape.operation.json`.

## Full-contract prompt-only protocol diagnostic

A final separately authorized protocol probe used an isolated synthetic endpoint
metadata response declaring only `supported_parameters: ["temperature"]`.
This is explicitly **not an actual capability claim**. It made the existing
production provider select prompt-only for both request construction and
response parsing; no mismatched wire-only binding mutation occurred. The full
original extraction schema remained in the production prompt and normal
runtime validation. Canonical full Achim inputs, temperature 0, default
reasoning, configured model and deadlines were unchanged. Judges were
intentionally excluded from this extraction-only diagnostic.

The single extraction wire call failed at the original 120,000 ms deadline:
HTTP 200, 4,000,343 wire bytes, 10,548 reasoning/detail events and 44,944
reasoning characters, with zero answer content and no finish marker. Last
activity occurred at 119,511 ms. The request was 30,550 bytes; the observer's
schemaBytes value is zero because it measures structured wire schema fields,
whereas prompt-only carries the complete schema inside the prompt. No answer
reached full-schema validation; zero claims were published. There was no
remaining deadline for a retry.

This distinct protocol test also failed to recover full-person extraction and
was not adopted. It remains diagnostic, not benchmark acceptance or evidence
that the model actually lacks structured-output capabilities. No additional
probe was launched by this subtask.

Evidence: `/private/tmp/issue-228-achim-prompt-only.log`,
`/private/tmp/issue-228-achim-prompt-only.report.json`, and
`/private/tmp/issue-228-achim-prompt-only.operation.json`.


## Read-only upstream route inventory

The [official OpenRouter endpoint metadata](https://openrouter.ai/api/v1/models/z-ai/glm-5.3-flash/endpoints) returned anonymous HTTP 200 at `2026-09-06T10:24:00.254040+00:00`. It lists 23 distinct upstream routes for the same `z-ai/glm-5.3-flash` model. No completion request or configuration change was made. Status codes below are preserved as raw metadata, without inferring their undocumented meaning. Every latency and throughput field in this snapshot is null, so this evidence does not support a speed ranking.

| Provider | Endpoint tag | Raw status | Tools / tool choice / response format |
| --- | --- | --- | --- |
| GMICloud | `gmicloud/fp8` | 0 | yes / yes / yes |
| Novita | `novita/fp8` | 0 | yes / yes / yes |
| DeepInfra | `deepinfra/fp4` | 0 | yes / yes / yes |
| Z.AI | `z-ai/fp8` | 0 | yes / yes / yes |
| Wafer | `wafer` | 0 | yes / yes / yes |
| Makora | `makora` | 0 | yes / yes / yes |
| Modal | `modal/fp8` | 0 | yes / no / yes |
| CoreWeave | `coreweave/fp8` | 0 | yes / yes / yes |
| Sail Research | `sail-research/fp8` | 0 | yes / yes / yes |
| StreamLake | `streamlake` | 0 | yes / yes / yes |
| NextBit | `nextbit/fp8` | 0 | yes / yes / yes |
| Fireworks | `fireworks` | 0 | yes / yes / yes |
| Friendli | `friendli` | 0 | yes / yes / yes |
| SiliconFlow | `siliconflow/fp8` | 0 | yes / yes / no |
| DigitalOcean | `digitalocean` | 0 | yes / yes / yes |
| Together | `together` | 0 | yes / yes / yes |
| Reka | `reka/fp8` | 0 | yes / yes / yes |
| Parasail | `parasail/fp8` | -2 | yes / yes / yes |
| BaseTen | `baseten/fp8` | 0 | yes / yes / yes |
| Venice | `venice` | 0 | yes / yes / yes |
| Io Net | `io-net/fp8` | 0 | yes / yes / no |
| Cloudflare | `cloudflare` | 0 | yes / yes / yes |
| Morph | `morph/fp8` | 0 | yes / yes / yes |

The official [provider routing documentation](https://openrouter.ai/docs/guides/routing/provider-selection) describes selecting upstreams within a model using provider preferences, including `only`, `order`, and `allow_fallbacks`. Thus same-model routing is an available external variable, but the routes serving the previous failed calls were not measured by the observer and cannot be inferred from this inventory. The production metadata union also does not prove that every individual route supports every declared parameter.

The allowlisted raw snapshot, including complete supported-parameter lists and available uptime fields, is `/private/tmp/issue-228-glm-endpoint-metadata.json`. No secrets or model contents were collected.

## Pinned same-model upstream diagnostic

Official endpoint metadata identified routing tags `fireworks` and `together`,
both declaring temperature, tools, tool_choice and reasoning support. Following
the official provider-routing API, a temporary extraction-only fetch transform
set `provider.order` to one tag, `allow_fallbacks: false`, and
`require_parameters: true`. Full Achim inputs, full schema, temperature 0,
default reasoning, configured model, production parser and deadlines remained
unchanged. No configuration or production source changed.

- Fireworks returned HTTP 429 after 344 ms, with 645 bytes and no model output.
  The structured boundary identified `upstreamServer: Fireworks` and
  `upstreamCode: 429`.
- The explicitly authorized sequential fallback, Together, returned HTTP 429
  after 147 ms, with 598 bytes and no model output. The structured boundary
  identified `upstreamServer: Together` and `upstreamCode: 429`.

Each diagnostic made one extraction request. Judges were skipped because
extraction failed. Neither result can establish how that upstream would perform
on the extraction task; both were unavailable for these requests. No further
route was tried. Evidence is in the matching `.log`, `.report.json`, and
`.operation.json` files under `/private/tmp/issue-228-achim-fireworks` and
`/private/tmp/issue-228-achim-together`.

Separately, read-only [official model metadata](https://openrouter.ai/api/v1/models)
at `2026-09-06T10:26:00.659655Z` reported mandatory reasoning, enabled by default,
with efforts max/high/low and default max. `reasoning.supports_max_tokens` was
absent. `default_parameters` contained temperature 1 and top_p 0.95;
`default_parameters.max_tokens` was absent. Generic max_tokens parameter support
does not establish support for an explicit reasoning-token budget, and endpoint
max_completion_tokens values are caps rather than defaults. The allowlisted
snapshot is `/private/tmp/issue-228-glm-model-metadata.json`.

## Explicit total-output allowance with low reasoning

A separately authorized diagnostic set extraction `max_tokens: 8192` and
`reasoning.effort: low`, retaining full Achim inputs, the full schema,
temperature 0, forced tool choice, default routing and the original deadline.
This used the declared generic total-output parameter, **not** unsupported or
unverified `reasoning.max_tokens`, and did not infer any default allowance from
endpoint caps. The temporary transform did not affect judges or configuration.

Both extraction wire attempts failed through actual 30-second idle gaps:

| Attempt | Safe observed upstream | Elapsed | Last delta | Wire bytes | Reasoning characters |
| --- | --- | --- | --- | --- | --- |
| First | NextBit | 49,536 ms | 19,533 ms | 6,746 | 58 |
| Same-binding retry | NextBit | 35,655 ms | 5,651 ms | 7,439 | 71 |

Both returned HTTP 200 with no answer content, tool arguments, finish reason or
DONE. The safe observer retained the allowlisted top-level provider name,
providing direct upstream attribution for these two stalls. Zero claims were
published; judges were skipped after failure. The total-output allowance plus
low reasoning did not recover extraction and was not adopted. The bounded
retry remained inside the original request deadline. Evidence is in
`/private/tmp/issue-228-achim-total-cap.{log,report.json,operation.json}`.

## Different available upstream: DeepInfra also stalls

The separately authorized route-only control pinned the official metadata's
exact `deepinfra/fp4` endpoint tag with fallbacks disabled and required parameter
support. Unlike Fireworks and Together, this upstream accepted both requests:
HTTP 200 and safe top-level provider attribution `DeepInfra` were observed.
Full original Achim inputs, full schema, temperature 0, default reasoning, no
explicit output cap, configured model and deadlines remained unchanged.

The first extraction attempt stalled at 35,618 ms after its last delta at
5,616 ms (4,441 wire bytes, 58 reasoning characters). Its same-binding retry
stalled at 41,127 ms after its last delta at 11,125 ms (4,391 wire bytes,
58 reasoning characters). Neither produced content, tool arguments, finish
reason or DONE. Zero claims were published; judges were skipped. The bounded
retry did not recover, and no further route was tried.

This distinguishes a working route from the earlier 429 responses and shows
that the observed stalled extraction behavior is not unique to NextBit. It
does not identify a more specific model/request/upstream cause. No routing
change was adopted. Evidence: `/private/tmp/issue-228-achim-deepinfra.log` and
the matching `.report.json` and `.operation.json` files.

## First-1,000-character input-window diagnostic

One authorized input-window diagnostic kept the full retained 6,000-character
Achim source unchanged while the temporary completion wrapper sent only its
first 1,000 characters and marked model document completeness partial. Selection
was a plain character prefix, never reference-fact-based. Full schema,
temperature 0, default reasoning/routing, forced tool choice, runtime validation
and the original deadline remained unchanged. This was not acceptance or full
source coverage.

The first attempt, safely attributed to Wafer, stalled at 31,003 ms after its
last delta at 1,000 ms: 65 reasoning characters and one tool index with 11
invalid-JSON argument characters. Its same-binding retry routed to Io Net and
spent the remaining 88,341 ms of the original deadline in active reasoning
(6,842 characters), with no answer content or tool arguments. Neither had a
finish marker. Zero claims were published, and judges were skipped.

This input-window control did not recover extraction. It therefore does not
support implementing chunked extraction on the assumption that this prefix
size resolves the failure; no chunking change was implemented or adopted.
Evidence: `/private/tmp/issue-228-achim-input-window.log` and its matching
`.report.json` and `.operation.json` files.

## Focused primary-source serving investigation

Read-only research on September 6 found a specific server-side incompatibility
with symptoms relevant to this investigation, but **no verified client request
fix or attribution to the upstreams observed here**.

- [SGLang issue #36879](https://github.com/sgl-project/sglang/issues/36879),
  opened August 28, documents two GLM-5.3-Flash MHC communicator reduction
  omissions. Under DP attention, no MoE all-to-all backend, and equal TP/EP/DP
  sizes greater than one, it reports repetitive reasoning, empty content and
  tool-schema failures. A partially repaired build could pass simple smoke
  tests while failing more involved tool calls. This is a specific serving
  configuration defect, not evidence that every GLM deployment is broken.
- [Fix #36884](https://github.com/sgl-project/sglang/pull/36884) merged on
  `2026-08-28T20:34:17Z`, commit
  `6611363be5111b1a4bd48aa806d4c98490dca950`, correcting both omissions.
  [Flash integration #36507](https://github.com/sgl-project/sglang/pull/36507)
  merged on `2026-09-06T09:28:00Z`. GitHub's primary API verified the merge
  timestamps. The actionable serving check is to verify the actual upstream
  engine/build, inclusion of both fixes and the TP/EP/DP configuration. None of
  those facts is present in our OpenRouter endpoint metadata or safe stream
  observations, so this remains a candidate external cause, not a diagnosis.
- The [official vLLM Flash recipe](https://recipes.vllm.ai/zai-org/GLM-5.3-Flash),
  updated September 5, specifies the `glm47` tool parser, `glm45` reasoning
  parser and automatic tool-choice support for serving. It explains that
  reasoning is always enabled and low/high must be explicitly mapped into the
  template; other effort values select max. These are concrete upstream
  configuration checks, not additional unverified parameters to send through
  OpenRouter.
- The [Z.ai model card](https://huggingface.co/zai-org/GLM-5.3-Flash/raw/main/README.md)
  recommends `clear_thinking=true` for chat. Inspection of the
  [actual template](https://huggingface.co/zai-org/GLM-5.3-Flash/raw/main/chat_template.jinja)
  shows that this controls retention of prior assistant reasoning. Our
  extraction request contains no prior assistant turns; changing it would not
  address that mechanism. Tool-result reordering likewise concerns histories
  containing tool results, absent from this extraction request.
- [Z.ai's direct tool-streaming documentation](https://docs.z.ai/guides/capabilities/stream-tool)
  and [chat API reference](https://docs.z.ai/api-reference/llm/chat-completion)
  document `tool_stream=true` alongside `stream=true` for incremental tool
  argument delivery. This documentation targets Z.ai's direct API. No primary
  OpenRouter source found here establishes passthrough or required use for its
  third-party GLM endpoints, so adding it to our OpenRouter requests is not a
  supported fix on present evidence.

No model calls, routing probes, configuration changes or production code edits
were made during this research. The strongest new action is an upstream
serving-version/configuration investigation tied to the specific SGLang fix,
not another sampling or timeout change. No message was sent to a provider.

## Official Z.AI route control unavailable

A fresh anonymous endpoint read at `2026-09-06T10:58:33.831160Z` confirmed
`provider_name: Z.AI`, exact tag `z-ai/fp8`, raw status 0 and declared tools,
tool_choice and temperature support. The authorized original full-Achim
route-only control pinned that tag, disabled fallbacks and required parameter
support, keeping full schema, temperature 0, default reasoning, configured
model, runtime boundary and deadline unchanged.

The single request returned HTTP 404 after 36 ms (312 bytes). The sanitized
boundary had no upstream server attribution and upstream code 404; there was
no model output. Judges were skipped after extraction failed, and no other
route was tried. The listed route was not exercised successfully for this
request, so the test cannot distinguish maker-hosted behavior from third-party
serving compatibility. A route name alone would not establish a serving build
version even if it had succeeded.

Evidence: `/private/tmp/issue-228-zai-route-metadata.json`,
`/private/tmp/issue-228-achim-zai.log`, and matching `.report.json` and
`.operation.json` files. No configuration or production source changed.

## Z.AI automatic-tool controls

A later read of the [public endpoint metadata](https://openrouter.ai/api/v1/models/z-ai/glm-5.3-flash/endpoints)
exposed a detail omitted from the earlier route summary: Z.AI declares
`supports_tool_choice.auto: true`, but `function: false` and `required: false`.
Thus the earlier forced-function request was incompatible with that endpoint's
specific declaration despite the broad `tools`/`tool_choice` parameter names.
This is newly inspected metadata detail, not evidence that the upstream changed.

A diagnostic changed the pinned extraction request to automatic tool selection,
preserving the complete 7,870-byte schema, temperature 0, default reasoning,
configured GLM model and 120-second total deadline. It reached HTTP 200 with
explicit Z.AI attribution. Over 119,899 ms it received 2,122,930 wire bytes,
5,588 data events and 24,018 reasoning characters, but zero answer characters,
zero tool arguments and no finish reason. The observer retained counts only,
not reasoning content. The original deadline interrupted the call; zero claims
were published. Automatic tool selection therefore resolved the route refusal
but did not establish a usable extraction setting.

A follow-up kept that control and requested low reasoning effort. Both bounded
attempts ended at 30,002 ms with HTTP 200, 1,775 bytes and 71 heartbeat comments,
but zero data events or answer/tool content. Neither attempt produced upstream
attribution. Judges were skipped after extraction failed. No diagnostic binding,
reasoning or routing override was adopted in production.

Sanitized operation, result and activity-count files are preserved under
`artifacts/person-benchmark/diagnostics-2026-09-06/issue-228-achim-zai-auto*`.
The current endpoint metadata is retained alongside them. Logical provider
diagnostics still name the adapter's original binding; these explicitly labeled
wire-override controls and their observer records identify automatic selection.
They are diagnostics, not acceptance runs.
