# The wire schema drops the keywords the upstream cannot decode

Person Research reached documents, retained them, and then published no Person
Claim. The operation ended with "Model-provider failure interrupted research",
which named the wrong cause: the provider was available and answering. Spec #418
was written to repair this, reading the incident (#417) and a research note as
evidence that the model could not meet the full Extraction Result Shape's output
obligation.

That reading was wrong, and every lever built on it was measured inert. Eight
frozen probe cells against `inception/mercury-2.5` returned HTTP 200 with
`finish_reason: "stop"`, no `content`, no `tool_calls` and no reported usage —
identically at output ceilings of 8192, 16384 and 65536, at reasoning efforts
`low` and `none`, with and without the Result Shape stated in the system
message, across five fixtures. Nothing the specification proposed changed the
outcome, because none of it touched the cause.

The cause is one JSON Schema keyword. Bisected one keyword at a time against a
54-character prompt, so neither document size nor output budget was in play: an
array of strings answered, the same array with `maxItems` answered, and a
top-level scalar carrying its own `pattern` answered. Only `pattern` **below the
top level** emptied the reply. The full Extraction schema with its 20 `pattern`
keywords removed answered with a populated tool call, three runs of three,
against three of three empty before.

## The decision

A wire schema carries no keyword the Upstream Route cannot decode. Two are
known, and they leave in the same walk:

- **`maxLength`** cost the whole call. The pinned route ran past 45 seconds and
  returned an upstream 502; the same request without it answered in 4.4 seconds
  (#304).
- **`pattern`** empties the reply rather than slowing it, as measured above.

Neither constraint is lost. The caller's own Zod schema still refuses a value
the keyword would have refused, so the check moves from decode time to
validation time. The Result Shape the Module declares is unchanged; only the
description sent to the provider is narrowed.

The seam is `wireJsonSchema` in `apps/server/src/llm/providers.ts`, which
already walked every outgoing schema to strip `maxLength`. The walk now strips a
named set, and the helper is named for what it does rather than for the first
keyword that needed it. A field a caller has actually named `maxLength` or
`pattern` is data, not a keyword, and survives with its own subschema walked.

## What this settles about spec #418

The specification's staged levers are recorded with their measured disposition,
not with the outcome they were expected to have:

| Lever | Disposition |
| --- | --- |
| 3.1 explicit output budget and reasoning effort | Implemented. Measured inert against this failure. Retained: an explicit ceiling and a recorded requested-versus-effective effort are correct regardless, and the specification requires them. |
| 3.8 describe the shape under every binding | Implemented. Measured inert against this failure. Retained for the same reason. |
| 3.3 empty-answer binding recovery | Implemented. Condition-not-triggered for dossier extraction: extraction prefers `forced_tool_call`, and the step runs from `response_format`. It fires for callers that do not set that preference. |
| 3.2 split by dossier slice | Built, then removed. Its precondition — a model that cannot meet the output obligation — is not what was wrong. |
| 3.4 model cascade per part | Built, then removed. Same reason. No fallback model was ever seeded or enabled. |
| 3.5 retain schema references | Not implemented. The request-size question is untouched; this repair reduced the schema by removing keywords, which is a different change and was not measured for byte savings. |
| 3.6 evidence-first two-pass architecture | Deferred by the specification. Still deferred. |
| 3.7 grammar-constrained serving | Out of scope. Unchanged. |

The repaired full strategy is **qualified** for `inception/mercury-2.5`: after
the fix, all eight probe cells that use `forced_tool_call` produce an admissible
result, including the `existing-full` baseline that opened the investigation
empty. The unchanged Extraction contract, on the model the Workspace already
selected, at the first attempt.

## A second, separate defect

The `response_format` binding answers where `forced_tool_call` did not, but its
answers do not validate against the Extraction Result Shape: two repetitions
produced 1 and 7 validation issues, including a null supplied where
`connections[].counterpartyUrl` requires a string. This is recorded, not fixed.
It is why dossier extraction keeps preferring the forced tool call rather than
switching bindings, and it is why the empty-answer recovery step is worth
keeping even though it does not fire here.

## What is deliberately untouched

Production provider and model defaults, explicit Workspace overrides,
concurrency, source-volume limits and operation allowances are unchanged. Model
admission, the cumulative operation budgets, the cancellation generation fences
and ADR-0092's permit scoping are unchanged; the repair adds no dispatch. The
Result Shape keeps every field, limit and nested contract, and ADR-0097's
subject attribution, the verbatim-citation grounding and the identity-anchor
rules are untouched.

The stripping is global rather than per provider, following the precedent
`maxLength` set. A provider that decodes `pattern` correctly also loses the
hint, and accepts a validation-time check instead. No measurement here argues
that any provider needs it at decode time.

## Alternatives rejected

**Switch dossier extraction to `response_format`.** Considered and authorised
before the cause was known, on the evidence that `forced_tool_call` returned
nothing. Abandoned once the keyword was found: the binding was never at fault,
`response_format` has its own validation defect, and the switch would have been
an unmeasured change for every other model.

**Strip the keyword only for models measured to need it.** Rejected for the
same reason `maxLength` is stripped for everyone (#304): the repository has one
wire-schema walk, the constraint is preserved locally either way, and a
per-model exception list is a second thing to keep true.

**Keep the slice strategy and the model fallback, disabled.** Rejected on the
owner's decision. Both were correct code answering a question that was not
asked; carrying two disabled strategies, an unused nullable fallback
configuration and their reuse-identity surface would have preserved a diagnosis
that no longer holds.

## How it is verified

Deterministic, at the provider seam: one case per binding asserts that the
outgoing wire body carries no `pattern` in a subschema position, that `maxItems`
and the numeric bounds survive, and that a caller field named `pattern` survives
with its own subschema walked. It fails before the fix and passes after it.

Live, against the model: the eight-cell probe manifest in
`scripts/person-extraction-probes.mts`, recorded before and after, at
`docs/research/person-extraction-probes-2026-09-15-prefix.json` and
`-postfix.json`. Both are kept — the first isolated the cause, the second shows
it was the whole of it.

Not verified: the Person Research Benchmark was not re-run for this change, so
no claim is made here about dossier quality, only about whether extraction
produces an admissible result at all. ADR-0079's frozen acceptance pair remains
unsatisfiable by any existing artifact, and that gate is unchanged and still
open.
