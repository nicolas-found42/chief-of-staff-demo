# Reducing LLM calls, cost and runtime in the Person Profile workflow

**Purpose:** Produce a prioritised, evidence-based plan to cut the number of model calls, the
dollar cost, and the wall-clock time of the Person Profile workflow — **without changing its
behaviour**. The decision riding on your answers: which changes are worth making first, and
which "obvious" wins must be rejected because they quietly change what the product does.

**From:** Nicolas, **To:** you (the assistant filling this in), **How your answers will be
used:** as the working plan. Each answer becomes a section of a proposal that gets reviewed
against the codebase and then implemented.

**Attached, and read this first:** `docs/research/person-profile-llm-architecture.md`.
It is your **only** source of truth about the codebase.

## Context

The Person Profile workflow builds a durable, sourced profile of a person by researching them
across the public web. It has **exactly three model call sites**, all of which are described in
the attached document: claim extraction (C1), dossier extraction (E1) and lead planning (P1).
Everything around them — search, fetching, parsing, passage selection, identity matching,
scoring, completion, storage — is deliberately deterministic, and a separate evaluation-only
judge rig exists for measuring research quality.

The owner's complaint is concrete: **too many model calls, and it takes too long to run.** No
measurements exist yet — establishing them is part of your job, not a precondition.

Four classes of change are in bounds, and the owner has accepted all four:

1. eliminating waste (same prompts, same models, same outputs);
2. batching, caching, concurrency and routing changes;
3. prompt and model changes (including a cheaper or smaller model for a narrow stage);
4. architectural redesign of the pipeline itself.

Your constraint is equally firm: **the behaviour must not change.** The document's final
section lists the invariants that define that behaviour. Treat them as the specification you
are optimising against, not as suggestions.

## How to answer

Work through this in one pass and answer in the document, under each question, in the `>` block
provided. **Partial answers and "I don't know" are genuinely useful** — flag uncertainty rather
than skipping, and never invent a fact to fill a gap. If you need something the attached
document does not tell you, say so explicitly in the answer to Q1; the owner can supply it.

Where you propose a change, name the exact symbol or stage it touches, using the names the
attached document uses. A proposal that cannot be located in the document is not actionable.

Rough effort: this should be a solid working session, not a quick skim. Most of the value is in
the ranking and the behaviour-preservation argument, not in the list of ideas.

## Establish the baseline first

### Q1. What can you not determine from the attached document, and what would you need?

_Why this matters: the document is an architecture map, not a measurement. Naming its gaps is
more useful than guessing past them — and it tells the owner exactly what to run._

>

### Q2. What is the smallest measurement that would tell you where to cut?

_Why this matters: "instrument everything" is not a plan. You are looking for the two or three
numbers that would actually change the decision — the distribution of calls across stages, the
split between waiting on the model and waiting on the network, or something else._

>

### Q3. Of the three axes — call count, dollar cost, wall-clock time — which ones actually move
together here, and which trade against each other?

_Why this matters: the owner asked for all three to improve, but the document records at least
one explicit speed-for-something trade. Say where the axes are coupled, and where improving one
will worsen another._

>

## Account for the calls and the wall time

### Q4. Write the call-count arithmetic for one research round.

_Why this matters: the document states the formula. Your job is to show what it implies about
which stage dominates in practice, and what each part of the product is bounded by._

>

### Q5. Wall-clock time is not call count. Where does the time actually go?

_Why this matters: two stages can make the same number of calls and cost wildly different
amounts of time. Consider what the document says about concurrency, the capacity limiter, the
read batch size, request ceilings, and the throughput the extraction calls ask routing for._

>

### Q6. Which of the three call sites is the best target, and which is the worst?

_Why this matters: rank them, and justify the ranking from the document's own facts about
trigger frequency, bounds and gating. A call site that fires once per document part is not the
same proposition as one that fires once per round, or one that is already throttled._

>

## Rank the candidate changes

### Q7. List every candidate change you can justify from the document, then rank them.

_Why this matters: this is the core of the plan. For each candidate, give: the change, the
mechanism by which it saves calls / money / time, roughly how much it would save (with your
reasoning, given that no baseline exists yet), the implementation cost, and the risk to
behaviour. An unranked list is not a plan._

>

### Q8. Which single change would you do first, and why that one?

>

### Q9. Are there changes that are only safe *after* another one lands, or that must land
together?

_Why this matters: sequencing errors here produce a plan that cannot be executed in order._

>

## Preserve the behaviour

### Q10. State precisely what "the same behaviour" means for this workflow, in terms you can
test.

_Why this matters: "same behaviour" is the constraint that decides everything. Ground it in the
document — what the workflow guarantees about evidence, identity, completion and publication —
rather than restating the phrase._

>

### Q11. For your top three candidates, how would you know behaviour was preserved?

_Why this matters: each answer should name an observable that would move if the behaviour
changed, and should say whether the existing evaluation rig (the judge described in the
document's evaluation section) could detect it, or whether it needs something else._

>

### Q12. Which of your candidates are *not* behaviour-preserving, and should be dropped or
flagged as a product decision instead?

_Why this matters: this is the honesty check on the plan. There is at least one place in this
workflow where a per-item call exists for a specific semantic reason, and collapsing it is not
a free win. Find it and say so._

>

## Traps worth naming

### Q13. Which "obvious" optimisations should be rejected, and why?

_Why this matters: the owner has approved prompt, model, and architectural changes. That
permission makes some superficially attractive moves available that would actually change the
product. Name them, with the document's own reasoning as the justification._

>

### Q14. The configured bounds are ceilings, not targets. What breaks if someone lowers them?

>

### Q15. Where does the workflow already cache, reuse or throttle, such that a proposed change
would duplicate work that already exists?

_Why this matters: re-implementing an existing guard is the most common way a plan wastes a
sprint._

>

## Sequencing

### Q16. Write the implementation order, with a checkpoint after each step.

_Why this matters: each step should end in a state where the owner can measure again and decide
whether to continue. Say what is measured at each checkpoint, and what result would make you
stop._

>

## Anything else?

### Q17. Anything the owner should know that this questionnaire did not ask?

_Why this matters: this is the catch-all. If you found a larger structural problem, a cheaper
approach nobody asked about, or a reason the stated goal is not worth pursuing, say it here._

>
