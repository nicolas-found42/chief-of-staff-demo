# Story grouping's semantic path activates at question revision 2 after its gate passed

ADR-0106 recorded a failed promotion gate: at question revision 1 the model merged four
different-or-ambiguous pairs, including two explicit negations scored `same` 1.0 and 0.85, so the
semantic path shipped unwired. The owner approved a revision-2 attempt. Revision 2 adds three
polarity rules and three worked examples to the pinned question — denials are different, a mention
or plan is not the occurrence, assertions are compared before topic words — and the live
measurement cleared the gate completely: on the same frozen 57-pair corpus, 16/16 same-labeled
pairs merged and **zero** different-or-ambiguous pairs merged.

The threshold moved with the question, and the movement is measured, not tuned: revision 2's two
residual disagreements were both ambiguous-labeled pairs scoring `same` exactly 0.80, while every
same-labeled pair scored ≥0.95. Raising the cut to 0.85 therefore costs nothing on the corpus, and
a companion cap — a pair also needs the model's own `ambiguous` probability at or below 0.15 —
encodes "uncertain relationships never merge" directly in code. Both constants carry their
measurement in their doc comments, and `tests/fixtures/content-scout/grouping-pairs-verdicts.json`
now holds the measured revision-2 verdicts, so
`pnpm exec tsx scripts/content-scout-grouping-eval.mts --judgments <file.json>` replays offline
from either a flat pair-ID-to-verdict map written by live `--record` or an object whose `measured`
property holds that map. Every verdict has `same`, `different`, and
`ambiguous` probabilities from 0 to 1. Replay reports the selected file path; a missing path,
malformed JSON, or unsupported verdict shape exits with an input error rather than falling back to
the bundled measurement. `--live` and `--judgments` are mutually exclusive.

Production composition now wires `modelStoryPairJudger` on the contentDiscovery purpose. The
deterministic half of ADR-0106 stands unchanged: adapter `storyKey` groups stay authoritative,
groups are cliques under per-pair verdicts, canonical keys stay membership-derived, the cooldown
reconciliation still holds a regrouped story to retained decision evidence, and the 100-pair budget
with per-pair failure isolation bounds every Run. A future question change repeats the exact loop:
bump the revision, re-run the live comparison, record it, wire nothing until the gate is green.

## Considered Options

- **Accept the two ambiguous merges at cut 0.80.** Rejected (0.38): the model was confidently wrong
  on both, and the higher cut was free — keeping them bought nothing.
- **Iterate to revision 3 same night after any failure.** Rejected in advance (0.01 for
  same-night iteration): versioned changes deserve a fresh look at the measured evidence between
  attempts, not an overnight spiral of live spend.
- **A deterministic polarity precheck in code.** Rejected again (0.00): it reintroduces the keyword
  heuristic the spec removed, and revision 2 shows the model handles negation when the question
  asks it to.

## Consequences

Content Scout Runs now merge eligible unkeyed Source Items that the revision-2 question judges the
same specific development — same-story recall 16/16, zero false merges on the frozen corpus, with
`story-grouping.json` recording every pair verdict at revision 2. The first Run after activation is
the true production test; if a false merge surfaces in real use, the recorded verdicts make the
failure auditable pair by pair, and the rollback is the same seam flipped off.
