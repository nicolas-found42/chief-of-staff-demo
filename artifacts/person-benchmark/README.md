# Issue #228 validation artifacts

The root-level historical reports and the diagnostics subdirectory are smoke evidence, not
proof that issue #228's full quality acceptance criteria have passed. The configured research and judge model was OpenRouter `z-ai/glm-5.3-flash`.
All research ran in temporary workspaces.

- `fixed-documents-expanded-2d0a903133188b6a`: authoritative corrected smoke run for Achim
  Steiner and Ana Botín. Both research operations were interrupted by model extraction
  timeouts; the report is correctly **failed**, with zero recovered facts. The per-person
  operation JSON files preserve the attempts. Judge responses do not establish successful
  research when extraction failed.
- `fixed-documents-expanded-8620f6e645bedd41`: earlier diagnostic run, retained unchanged for
  traceability. Its top-level completed status is **incorrect**: both nested operations were
  interrupted. This exposed the evaluator bug fixed before the corrected run. Do not use it
  as a successful baseline or quality result.

The [diagnostics index](diagnostics-2026-09-06/README.md) includes later preserved failures and
completed tiny production smoke `39e8f583d614ad67`. That smoke recovered one of one dated
reference facts with complete integrity and semantic assessment. Its tiny corpus does not
substitute for the full benchmark.

The `full-fixed-2026-09-06` run `96a666d0479437eb` finished all 30 research operations. It
published zero claims and recovered zero of 235 reference facts: 22 operations were interrupted,
eight completed without claims, and 28 of 30 semantic assessments completed. This is a failed
acceptance run. Its saved evidence passed reassessment validation. A new `.5` reassessment was
started, then stopped without a saved report when corrected full research runs superseded it.

The `full-incumbent-2026-09-06` and `full-expanded-2026-09-06` directories contain **superseded
partial diagnostic runs**, stopped after 19 and 10 saved operations respectively to reduce
competing model requests. Their operation records and public snapshots remain preserved;
neither is a completed population assessment or a comparable acceptance arm.

The `current-fixed-2026-09-06`, `current-incumbent-2026-09-06` and
`current-expanded-2026-09-06` directories contain the new full runs against corrected matching
inputs. All three have finished all 30 people. Fixed
published seven claims, recovered two reference facts and completed 26 semantic assessments.
Incumbent published 48 claims, recovered two reference facts and completed 29 semantic
assessments. Expanded published 79 claims, credited zero recovered facts and completed 25
semantic assessments; all 30 research operations were interrupted. These original `.5` reports
remain failed and are not final acceptance measurements.
Live arms both use operation concurrency two; all runs retain public evidence directly.

The `current-fixed-judge7-2026-09-06` and `current-incumbent-judge7-2026-09-06` directories
contain full reassessments of those saved populations. The fixed first pass completed 28
assessments; `current-fixed-judge7-recovery1-2026-09-06` run `bbc8e62af386b229` carried those
28 and retried only two failures, completing all 30 plus the collection scenario. It recovers
2 of 235 facts with zero critical integrity findings and zero wrong-person findings. Original
research remains 23 interrupted operations and seven completed operations; the report is failed.
Five Anders Danielsson matches remain ambiguous because the judge quoted cited passages instead
of the selected claim text. These completed adverse assessments are fixed, not retried.

The incumbent first pass completed 24 assessments; failed-only recovery
`f93fe67376b87cec` in `current-incumbent-judge7-recovery1-2026-09-06` completed all 30 and the
collection scenario. It records zero recovered facts and eight partial matches. The `.7` judge validates
support findings and their selected citations before recovery credit; reassessment enforces
immutable evidence and preserves original research outcomes. Completed per-person assessments
are saved as versioned sidecars. A valid baseline/candidate comparison remains outstanding. See
[the validation record](../../docs/research/person-benchmark-validation-2026-09-06.md).

The original full runs use corpus `3dedb8c8e53a4f4c` and judge `.4`. Subsequent review corrected
three malformed employer hints (new corpus `cd3bd2a050f51de7`) and the judge's full-input contract
(new judge `.5`). Original measurements retain their original identities; they cannot be
silently relabeled as current-configuration acceptance results.

Tracing the expanded misses identified a production reader defect: Wikipedia editing JavaScript
mentions CAPTCHA, which the previous access detector falsely treated as a bot challenge. The
diagnostics directory contains before/after evidence from the normal HTTP 200 article response
and a production reader check. The corrected reader version is `2026-09-06.1`.
`reader-fixed-expanded-2026-09-06` is a fresh full live expanded run with that repair, unchanged
references/model/allowances and judge `.7`. It remains in progress. Earlier source evidence
cannot acquire rejected articles through reassessment and remains unchanged.

The completed older-expanded `.7` reassessment `e1b50cd7d30b28a3` has 24 complete assessments
and six failures. Its CLI comparison in `pre-reader-repair-comparison-2026-09-06` correctly
returns `not-comparable` and exit 1. It has an explicitly rejected positive: Ana Botín's
chairmanship was called recovered even though the judge's rationale says the required date and
family detail are missing. Do not treat that positive alone as the required improvement.

## Expanded candidate arm (#258)

`live-discovery-expanded-873614ead458212f` is the candidate half of the frozen acceptance pair:
30 of 30 people researched, 30 of 30 assessments executed, collection scenario
`directing-and-screenwriting` completed with `bong-joon-ho` not recovered — the same scenario
outcome the incumbent baseline records. It ran at gitSha `0f9009b37e82ddb6c259c3a30462b1de7fb1bc9e`
(the #248 merge), 2026-09-11T05:54:08Z–06:17:51Z, against corpus `14bca86ee0b97d28`, research
`openrouter inception/mercury-2.5-preview`, judge `openrouter z-ai/glm-5.3-flash 2026-09-06.10`,
prompt `2026-09-06.4`, allowance 180 calls / 900000 ms per operation, read concurrency 4, four
people at once, live anonymous network, 7,457,500 tokens / $0.645359 provider-observed.

Its top-level status is honestly **failed**: all research operations concluded `completed`, but the
judge support/usefulness phase failed for five people (`bong-joon-ho`, `doug-mcmillon` — request
ceiling while a call was in flight; `chimamanda-ngozi-adichie` — provider returned the answer in
`tool_calls` with empty content; `hilary-cottam`, `laurent-freixe` — support findings naming
non-verbatim statements). Recovery credit is withheld for those five until their assessments are
recovered; the paired comparison and that recovery belong to #259, so no per-person recovery number
here is a comparison verdict.

`diagnostics-2026-09-11/` (local, not committed — the reports under this directory are the
committed artifacts, per the artifacts policy in `.gitignore`) holds the two superseded attempts
that produced this arm: run `453489580a2bc969`, which took the Workspace config's model
(`openrouter inception/mercury-2.5`) for **both** research and judge and therefore could never pair
with the baseline, and run `334574ff96efe9a0`, interrupted after 5 of 30 people. The five fully
assessed people from the interrupted run were carried into the arm with `--retry`; their person and
operation records are committed here under that run's id, because a carried person's record keeps
the run that produced it.

The five withheld assessments this arm carried (`bong-joon-ho`, `chimamanda-ngozi-adichie`,
`doug-mcmillon`, `hilary-cottam`, `laurent-freixe`) were recovered under #259: see the acceptance
comparison section below.

## Acceptance comparison (#259)

The acceptance pair is published as `comparison.json` / `comparison.md`, regenerated from the
frozen pair — baseline `live-discovery-incumbent-7aa090c5424ab6c3` versus candidate
`live-discovery-expanded-8ebc59982210a118`. It **supersedes** the 2026-09-07 record
(`6e82a760755b66a5` versus `18b5f48848d63553`, not comparable) those two files previously held;
that pair's own [reports](fixed-documents-expanded-6e82a760755b66a5.json) remain committed and
unchanged, so nothing earlier is relabelled.

Recovering the candidate half's five withheld assessments took one live `--retry` run,
`live-discovery-expanded-8ebc59982210a118` (`8ebc59982210a118`), 2026-09-11T16:42:56Z–17:02:21Z at
gitSha `e4eb962993c40a8942913f6c82d7d859287a33fe`: corpus `14bca86ee0b97d28`, research
`openrouter inception/mercury-2.5-preview`, planner the same, judge
`openrouter z-ai/glm-5.3-flash 2026-09-06.10`, prompt `2026-09-06.4`, live anonymous network. It
carried the 25 already-assessed people and re-ran the five withheld ones (four people at once, 180
calls / 900000 ms per operation, no overrides), spending **$0.286029** / 2,131,257 in / 1,193,648
out provider-observed tokens. Four of the five now carry completed assessments
(`bong-joon-ho` 2/7, `chimamanda-ngozi-adichie` 2/8, `hilary-cottam` 0/5, `laurent-freixe` 2/9);
`doug-mcmillon`'s support/usefulness phase failed again on a request ceiling while a call was in
flight, so its recovery credit stays withheld and the run reports **failed**, as recorded.

The comparison reads **not-comparable** and exits 1 honestly: one candidate person lacks a completed
assessment, and the evaluator refuses a population delta it could not fully assess. What is
measured, across the 29 of 30 pairs both sides assessed: recovery rises from 3 to 26 of 277
reference facts with zero new critical integrity findings — but the candidate side records 28
wrong-person attributions the incumbent does not (all newly introduced identities; three of them on
`hilary-cottam` from this recovery run), so no improvement verdict is established either. The
per-person, grouped (85 labelled slices), coverage-gap and failure-breakdown comparisons, and the
recovery audit that re-checks every credited recovery against its own reference and claim text —
and rejects one whose rationale says the reference's dated content is absent — are in
`comparison.json` / `comparison.md`. Remaining misses stay per person in both reports (candidate
251: 207 app-supported, 44 beyond current coverage) as the follow-up acceptance targets. See
[the validation record](../../docs/research/person-benchmark-validation-2026-09-11.md).

## Frozen acceptance corpus (#243)

Corpus `14bca86ee0b97d28` (content identity from `loadCorpus`, sha256 over the
references themselves) is frozen as the reference for both acceptance arms: 30
people, 277 reference facts, 1 collection scenario
(`directing-and-screenwriting`, requirement r18), zero rejected. Any
reference-content change moves this version, so both arms must cite it for a
comparison to be attributable. Individual-fact coverage across all twenty
dossier requirements (r18 carried solely by the collection scenario) and the
scenario's real-output assessment — missing in both retained `.7`
reassessments (`bbc8e62af386b229` fixed, `f93fe67376b87cec` incumbent; Bong's
operations published zero claims, so the demonstrated set was empty) — are
recorded in
[the collection assessment record](../../docs/research/person-benchmark-collection-assessment-2026-09-06.md).
