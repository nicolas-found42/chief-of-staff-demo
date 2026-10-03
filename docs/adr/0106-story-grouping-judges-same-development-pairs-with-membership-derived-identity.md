# Story grouping judges same-development pairs; identity is membership-derived and reconciled

Content Scout groups eligible Source Items into stories, and the group's canonical key becomes part
of Content Opportunity identity and its seven-day cooldown. The previous grouping joined items by a
two-token-overlap plus Jaccard heuristic, first-match in collection order: it split two reports of
one launch, merged different product launches from one company, and made the group — therefore the
Opportunity identity — depend on which item was collected first (#502).

Grouping now works in two tiers. Items whose Source Adapter supplies a `storyKey` group by that
exact key, unchanged and authoritative; a keyed item never crosses into another key or an unkeyed
group. Eligible unkeyed items are compared pairwise with a version-pinned three-level question —
same specific development, different developments, or ambiguous — over bounded deterministic
candidate pairs ordered by shared-token support and capped at 100 per Run. A pair merges only when
the same-story probability clears a threshold frozen on the reviewed corpus at
`tests/fixtures/content-scout/grouping-pairs.json` through
`scripts/content-scout-grouping-eval.mts`; groups are cliques under that per-pair relation, built
first-fit over id-sorted items, so a positive chain through an intermediary can never combine a pair
that failed, was ambiguous, or was never examined. Every group's canonical key is a pure function of
its members' identity seeds — the same item set produces the same key in any collection order.

The identity guarantee is deliberately scoped: same items, same key. When membership legitimately
changes — a member's target is archived, or genuinely new coverage arrives — the key changes with
it, and the cooldown reconciliation holds the line against the dangerous direction. Because a
changed key would otherwise let added coverage walk past a cooled-off story, the disposition
reconciles against evidence retained on recent decisions: a group whose Source Item URLs overlap
evidence retained on a decision still inside the window is held to that decision's cooldown even
under its new key, while a demonstrably different story — no evidence overlap — is never caught by
it. Already retained opportunities are not rewritten; the reconciliation applies to new Runs only,
so no historical decision changes meaning.

## The promotion gate failed, so the semantic path ships unwired

The spec's gate required no false merges on reviewed high-harm hard negatives. The live measurement
(upstage/solar-pro4 over the frozen 57-pair corpus, 2026-10-03) cleared same-story recall — 16/16
labeled-same pairs merged, against the heuristic's 3/8 on its own probe — but produced **4 false
merges** on 41 different/ambiguous pairs: grp-029 (a planned-pilot mention judged the same as the
launch it anticipated), grp-032 and grp-036 (explicit negations — "denies", "no customer data was
exposed" — scored `same` 1.0 and 0.85 against the events they deny), and grp-037 (a genuinely
ambiguous pair at 0.85). A threshold cannot fix a model that asserts a denied acquisition, so per
the spec's contingency the semantic path is **implemented, tested, and not wired in production**:
`contentScoutModule` accepts a `storyPairJudger` and the whole path is exercised end-to-end by
controlled-judger tests, but composition passes no judger, so production Runs group by adapter
`storyKey` plus deterministic singletons — which is already order-independent. The recorded
`grouping-pairs-verdicts.json` is demonstration material for the CI-side decision tests, not
measured evidence; the measured verdicts and the FAIL line are on issue #502. Wiring the judger is
an explicit follow-up that must first fix negation handling (a question revision), re-run the live
comparison, and clear the gate.

## Considered Options

- **Keep the token-overlap heuristic and tune its thresholds.** Rejected: the labeled probe measured
  it at 3/8 on hand-picked pairs, and order-dependence is structural to first-match grouping, not a
  threshold to tune. The deterministic fallback here is strictly weaker than the heuristic at
  merging paraphrases but order-independent and conservative — it never merges what it cannot
  justify, which the shortlist tolerates far better than a false merge.
- **Ship the semantic path enabled despite the failed gate.** Rejected: the spec's gate is binding,
  and four measured false merges on hard negatives — including negations — is exactly the harm the
  gate exists to stop.
- **Key groups by a single canonical member (earliest published, tie-broken).** Rejected: choosing
  one anchor makes every key hinge on one item's survival; membership-hash keys make the whole
  group's identity a pure function of the set, which the reconciliation can then reason about.
- **Persist a story-key ledger so new Runs reuse old keys verbatim.** Deferred: it is a stored-format
  change requiring the checksummed Workspace backup procedure, and the evidence-overlap
  reconciliation achieves the acceptance behavior without new persistent state.
- **Union-find over passing pairs.** Rejected: transitive closure merges items whose direct pair was
  judged different or ambiguous, which the spec forbids explicitly.

## Consequences

Production Runs group deterministically and order-independently today: keyed groups plus
singletons, with the `story-grouping.json` audit recording zero semantic calls. Runs given a
`storyPairJudger` — tests today, production after the gate clears — make one bounded model call per
candidate pair up to the 100-pair budget, with failures keeping pairs unmerged and recorded. Any
future question change is versioned: bump `questionRevision`, re-run the live corpus comparison,
record the result, and only then wire the judger.
