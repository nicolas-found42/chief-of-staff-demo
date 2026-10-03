# Enrichment selection judges fit, substance and promotion with a deterministic fallback

Content Scout chooses which eligible Source Items receive expensive enrichment — transcripts,
comments, media. The rule that made that choice was purely mechanical: enough text, enough words,
one narrow promotion-phrase pattern. It accepted the Brand Profile as an input and never used it, so
a long off-topic feature consumed enrichment while a concise on-topic development missed it, and a
wordy sign-up pitch passed because it had many words and no percentage sign (#503).

Selection now asks three independent judgments about each eligible Source Item — whether it fits the
Brand Profile's audience and positioning, whether it reports a substantive development worth deeper
evidence, and whether it is primarily a promotional call to action — in one bounded model request,
and combines them in code: required positive fit and substance, negative promotion veto. The
judgment questions are version-pinned (`questionRevision`), thresholds are frozen constants chosen
on the reviewed labeled corpus at `tests/fixtures/content-scout/selection-corpus.json` through
`scripts/content-scout-selection-eval.mts`, and each Run writes a non-sensitive per-item audit
artifact recording the judgments, the branch taken, the fallback reason, the question revision and
the Brand Profile revision used.

Three boundaries keep this from becoming a model-owned gate. Deterministic eligibility is unchanged
and runs first: stale, duplicate, prohibited, inaccessible and unsupported-claim items never reach
selection, and no semantic answer can re-admit them. Uncertainty is explicit: a judgment inside a
frozen borderline band, an invalid response, a provider failure, or an exhausted per-Run budget (60
judgments) sends the item to the previous deterministic selector, recorded as such, so a degraded
model service degrades to the shipped behavior instead of inventing a third behavior. And a skipped
item keeps its place in ranking — selection decides only which items are enriched, never which
items a person sees, so the ADR-0028 boundary that the person chooses from every eligible Source
Item stands.

## Considered Options

- **Tune the mechanical rules further.** Rejected: word and character floors cannot see relevance
  or substance; the labeled corpus measured them at roughly even odds on the material that matters.
- **Let the model own the enrichment decision outright.** Rejected: an unexplainable model answer
  consuming a budget with no deterministic floor turns provider health into an eligibility rule,
  which ADR-0028 forbids.
- **Batch items into one request per Run.** Deferred: cheaper per call but changes failure
  granularity for the whole Run; the one-request-per-item shape is measured first and batching is a
  versioned change only if per-Run cost and latency demand it.

## Consequences

Content Scout Runs call the model once per eligible item up to the budget; a Run with the seeded
test ports, or any Run without the semantic judger wired, behaves exactly as before and writes no
audit artifact. The corpus comparison on issue #503 is the promotion evidence: if no threshold met
the gate, the deterministic selector remains the only wired path and the measured result stands in
the issue. Provider credentials stay server-side, item text travels as untrusted evidence, and any
change to the judgment questions or thresholds is a versioned change — bump `questionRevision`,
re-run the corpus comparison, and record the result before enabling it.
