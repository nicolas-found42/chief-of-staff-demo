# Citation-support judgments run in shadow until the frozen-corpus gate passes

A Person Claim can quote an exact span and still assert something the span does not establish. The
publication safeguards — exact span integrity, subject attribution, predicate recognition, founding
wording, tense heuristics — protect many cases and misjudge others in both directions: they kept
"said it exists" as support for "built it", and downgraded a scope-preserving paraphrase
("spearheaded" for "led") that any reader accepts (#504). ADR-0097 and ADR-0099 remain the
authoritative publication boundary; this ADR adds an observation channel beside them, not a
replacement.

Each retained source's claims can now be judged by a version-pinned three-level semantic question —
supported, insufficient, or contradicted — over the claim statement, the cited line with its
immediate neighbors, and the source's attribution and capture date. The judgment is **shadow**: it
is recorded as a non-sensitive `shadow-observation` attempt beside the published outcome, keyed by
claim id, source id and capture date, with the question revision stamped. It changes nothing: not
the claim's status, not the dossier, not the run's success. The channel is bounded per source (24
claims; the rest recorded as skipped), one small model call per claim, and a provider failure is
recorded as a failed judgment — the operation and the conservative publication outcome stand
unchanged.

## Why it ships unwired-to-behavior

The spec's promotion gate requires zero false current-fact promotions on hard negatives, no
regression on the existing guards, and improved semantic error balance on the frozen corpus — and
publication behavior may change only after that gate passes **and** an ADR-0099 amendment lands.
Neither condition is met by code alone, so `PersonResearch` accepts an optional `citationShadow`
dependency and composition wires none: production runs today produce no shadow calls at all, and
the shadow path is exercised end-to-end by controlled-judger tests. Measured gate evidence lands on
issue #504; the corpus lives at
`tests/fixtures/person-profile/citation-support-pairs.json` and the comparison harness at
`scripts/person-citation-support-eval.mts`.

## Considered Options

- **Attach shadow verdicts to the claim's `changeReason` at publication.** Rejected: it writes
  model output into the published dossier before the gate passes — shadow in name only.
- **Store verdicts in the dossier revision.** Rejected: a stored-format change needing the
  checksummed Workspace backup procedure, spent on observations that may never gate anything.
- **Let a supported semantic verdict promote a claim directly once the gate passes.** Rejected for
  now, and permanently as a direct substitution: the deterministic gates (span integrity, subject
  attribution, self-report, dates, structured-context retention) answer questions the semantic
  judge cannot see, and the spec makes semantic support necessary but never sufficient.

## Consequences

Runs without the dependency behave exactly as before. A run with it gains a bounded series of
non-sensitive attempt records that let the frozen-corpus comparison accumulate real publication
outcomes beside model verdicts. Any question change is versioned: bump
`CITATION_SUPPORT_QUESTION_REVISION`, re-run the corpus comparison, record the result, and only an
explicit ADR-0099 amendment may then move a judgment from the shadow channel into the publication
path.
