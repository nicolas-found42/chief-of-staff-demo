# A model permit spends only on the model call it covers

Issue #381 (Step 0's measurement harness, requested by the maintainer) requires
Person Profile pipelining (R2) to be built only where the code demonstrably
holds a model permit idle instead of overlapping ready work — not built on a
guess. Reading the four-permit `WorkLimiter` and the per-source pipeline in
`PersonResearch.run` found exactly that: the permit acquired around one
source's read-to-publish handling wrapped retaining the source, the whole
sequential Extraction Parts loop, publication through the shared
`PublicationGate`, and every post-publish bookkeeping step — none of which is
model work. A fifth ready source's first model call could not even begin until
one of the four in-flight sources finished retaining, publishing and
checkpointing, work with no model dependency at all.

The fix narrows what a model-work permit covers to the individual model call
each Extraction Part spends — the same shape the planner call already used.
Retaining a source, publishing an extraction, and the bookkeeping around both
now run without holding a permit. This changes no other invariant: Extraction
Parts inside one document still run strictly sequentially (the same `for`
loop awaits each part in turn, permit boundary or not), publication is still
serialized through the operation's one `PublicationGate`, cancellation and
allowance accounting are unaffected, and reuse hits (#381, R1) never touch the
model-work limiter regardless of this change.

The composition-wide model-work capacity (four) and the per-operation source
read capacity are unchanged; the observable difference is that a model permit
now turns over as soon as its model call resolves, so another person's ready
extraction is not blocked behind an unrelated document's disk writes or its
turn in the publication queue.

This is deliberately narrow: it is the corrective the code already needed to
satisfy R2's own stated invariant ("correct permit lifetimes so a model
permit is never held during unrelated work"), not a new scheduler or a
capacity increase. No trace exists yet that reading and extraction lack
overlap at the batch level — they already interleave, verified by reading
`research.ts`'s per-source pipeline — so nothing broader is built here; a
wider pipelining change stays gated on a future trace actually showing idle
model capacity with independent ready work still waiting.
