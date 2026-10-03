# ADR-0099 amendment approved: citation-support verdicts move toward publication in a gated, separate change

**Status: Approved by the owner (2026-10-10, "I approve" on the activation decision), implementation not yet merged.** This ADR records the approval and the boundary it sets. The publication change it authorizes ships only through its own reviewed PR carrying the implementation and the gate evidence below.

## What was approved

ADR-0107 shipped the citation-support question as a shadow channel: model verdicts recorded beside published outcomes, changing nothing. The owner has now approved the direction ADR-0099's original text required a decision on: **the semantic verdict may participate in publication**, under the conditions this ADR fixes.

## The boundary

1. **Shadow first, live second.** The shadow channel (ADR-0107) now runs on every real Person Research operation — composition wires it. Real published outcomes accumulate beside real verdicts; this is the evidence base.
2. **Necessary, never sufficient, holds.** A supported semantic verdict remains one input. The deterministic gates of ADR-0097 and ADR-0099 (exact span integrity, subject attribution, self-report handling, date boundaries, structured-context retention) are unchanged and still decide. The semantic verdict may only *confirm* what those gates already allow, never re-admit what they exclude.
3. **The first live use is a demotion right, not a promotion right.** When implemented, a `contradicted` verdict may hold a claim at `claimed` (with a reason naming the shadow verdict); it may never erase the sourced record. Promotion on a supported verdict requires a later measurement showing it beats the deterministic qualifier on the frozen corpus without false promotions, recorded on issue #504.
4. **Question revisions are frozen per measurement.** The corpus at `tests/fixtures/person-profile/citation-support-pairs.json` and `scripts/person-citation-support-eval.mts` are the measurement instruments. Any question change bumps `CITATION_SUPPORT_QUESTION_REVISION` and re-runs the comparison; the recorded disagreements (paraphrase over-strictness, past-vs-current taxonomy) are the known work.

## What this ADR does not do

It does not change any code path tonight: publication behavior in the branch that carries this file is identical to ADR-0107's. It does not authorize retrospective reassessment of published dossiers. It does not weaken ADR-0097's subject-attribution gate or the exact-span requirement by one line.

## Why this order

ADR-0099 deliberately made current-fact promotion a human decision, and the owner has now made it — in the conservative direction: observe first, demote only on direct contradiction, and measure before any promotion right exists. Every widening after this point carries its own measured evidence and its own ADR.
