# Person Research Benchmark validation — 2026-09-11

This record supersedes [the 2026-09-06 validation record](person-benchmark-validation-2026-09-06.md)
for the acceptance pair. Every measurement the earlier record and its companions carry stays
attributed to the run that made it; nothing here relabels an earlier result, and the two reports
behind the superseded comparison stay committed unchanged.

## The frozen pair

[ADR-0079](../adr/0079-incumbent-baseline-freezes-the-acceptance-pair.md) froze the comparison
conditions: corpus `14bca86ee0b97d28`, judge `z-ai/glm-5.3-flash` at `JUDGE_VERSION`
`2026-09-06.10`, prompt `2026-09-06.4`, live anonymous network. The pair is the incumbent baseline
`live-discovery-incumbent-7aa090c5424ab6c3` (#257) against the expanded candidate. The candidate
half arrived from #258 as `live-discovery-expanded-873614ead458212f`, which completed 25 of 30
assessments: the judge support/usefulness phase failed for `bong-joon-ho`, `doug-mcmillon`
(request ceiling while a call was in flight), `chimamanda-ngozi-adichie` (an answer delivered in
`tool_calls` with empty content) and `hilary-cottam`, `laurent-freixe` (support findings naming
non-verbatim statements). Under ADR-0067 their recovery credit was withheld, and
`completeEvaluation` requires every selected person assessed, so the pair could not compare.

## The one recovery run (#259)

`live-discovery-expanded-8ebc59982210a118` (`8ebc59982210a118`), 2026-09-11T16:42:56Z–17:02:21Z at
gitSha `e4eb962993c40a8942913f6c82d7d859287a33fe` — a live `--retry` that carried the 25 fully
assessed people and re-ran the five withheld ones, four people at once, 180 calls / 900000 ms per
operation, no `--people`/`--limit`/`--profile-calls`/`--profile-ms` overrides, `--max-cost 5`.
Provenance pins exactly what the frozen pair records: research `openrouter
inception/mercury-2.5-preview`, planner the same, judge `openrouter z-ai/glm-5.3-flash
2026-09-06.10`, prompt `2026-09-06.4`, network `live`.

| Person | Research | Support/usefulness | Credited recovery |
| --- | --- | --- | --- |
| bong-joon-ho | bounded | completed | 2/7 |
| chimamanda-ngozi-adichie | completed | completed | 2/8 |
| doug-mcmillon | completed | **failed** | withheld (0/8 unmeasured) |
| hilary-cottam | bounded | completed | 0/5 |
| laurent-freixe | completed | completed | 2/9 |

Spend: **$0.286029**, 2,131,257 in / 1,193,648 out provider-observed tokens (5,040,259 input /
822,725 output characters). The run reports **failed**, honestly: `doug-mcmillon`'s
support/usefulness phase failed again (`a model call was in flight when the request ceiling
fired`, model `z-ai/glm-5.3-flash`, binding `forced_tool_call`, HTTP 200, 4925 bytes, ceiling
90000 ms), so its recovery credit remains withheld. Three of the five retried people carry a
recorded research or assessment failure; 29 of the 30 selected people are fully assessed.

## The comparison verdict

`artifacts/person-benchmark/comparison.json` / `comparison.md` were regenerated from this pair,
replacing the 2026-09-07 record (`6e82a760755b66a5` vs `18b5f48848d63553`) those files previously
held. The evaluator reads **not-comparable** and exits 1: the candidate side is one assessment
short, and the comparison refuses a population delta it could not fully assess.

What is measured, across the 29 of 30 pairs whose recovery credit is not withheld:

- Reference recovery rises from **3 to 26 of 277** facts (incumbent: `achim-steiner/undp-tenure`,
  `arvind-krishna/ceo-date`, `devi-shetty/founder-chairman`; the candidate adds 23 across 12 more
  people — `jane-fraser` 3, `irene-tracey`/`maria-ressa`/`minouche-shafik`/`rodolphe-saade`/
  `sally-kornbluth` 2 each, and one each for seven others).
- New critical integrity findings: **0** on both sides.
- Overclaims: 21 baseline vs 123 candidate; of the candidate's, **28 are wrong-person
  attributions** the incumbent does not record (tedros-adhanom-ghebreyesus 10, arvind-krishna 6,
  rodolphe-saade 3, hilary-cottam 3, ramon-laguarta 2, mary-barra 2, cristiano-amon 1,
  anders-danielsson 1).

So the ticket's two guards land on opposite sides of the same result: recovery improved, but 28
newly introduced wrong-person identities prevent an `improved` verdict
(`newIdentityFailures > 0` → `regressed` had the pair been comparable), and the incomplete
assessment prevents any verdict at all. Neither acceptance criterion 1 nor 2 is met on this pair,
and the record says so.

## The recovery audit (AC3)

The comparison now audits every credited recovery: each `recovered` verdict must carry, in the
report's own judgement, the reference text (`referenceQuote`), the claim it judged (`claimId`), and
the verbatim dossier excerpt (`evidenceQuote`) the judge's exact-claim guard verified against that
claim at assessment time — a verdict naming no claim, or quoting text absent from the named claim's
statement, was already parked as `ambiguous` by `judgePerson` and can never be credited. A credit
whose rationale records the verdict was withheld (`Original semantic verdict:` / `(Downgraded`)
is rejected, and a recorded count above its checkable judgements is rejected rather than silently
discounted. Rejected credits are named in `recoveryAudit` and in the conditions list; the
per-person, total and source-family recovery numbers read only the audited credits.

On this pair the audit verifies everything: baseline **3/3**, candidate **26/26** credited, zero
rejections. Every credited recovery can be checked against its own reference and claim text in the
two reports, and the audit is what makes that a checked property rather than a claim.

## Per-person, grouped, coverage-gap and failure-breakdown comparisons

`comparison.json` now carries, beside the per-person table with its denominators:

- **85 grouped slices** joined across `industry`, `role`, `footprint`, `language`, `region`,
  `reference-source-family` and `source-family`, each side with its own people/facts denominator
  (`comparison.md` → *Grouped comparison*). A slice only one report recorded stays `unmeasured`
  rather than zero, and a side's recovered column is `unmeasured` while any of its pairs lacks an
  assessment.
- **Coverage gaps** per side as each report recorded them (baseline 510 planned areas / 493 with
  open gaps / 493 area gaps / 607 explicit gaps; the candidate run's own five retained operations:
  85 / 66 / 131 / 135 — a resumed run's totals cover what it re-ran, which the rendering states).
- **Failure breakdowns**: the people each side records a failure against, beside the research
  attempt codes behind them (baseline 3 people; candidate 5, including all five withheld
  assessments from #258).

## Remaining misses are the acceptance targets (AC4)

Both reports preserve every unrecovered fact per person with its acquisition class, dossier
requirements and the judge's own explanation, and the renders list them under *Remaining misses*.
The candidate report records **251 remaining misses** (207 `app-supported`, 44
`beyond-current-coverage`); the incumbent records 274. They are the concrete follow-up target list
for source and extraction work, and the withheld-verdict disclosure is carried into each miss row
rather than reading as never-captured (#284).

## Routes: unsupported and excluded stay explicit (AC5)

Both arms of this pair are `live-discovery` on the live anonymous network
(`provenance.network = live`); nothing here presents a fixture-backed run as live coverage. The
fixed-documents arms under this artifacts directory remain labelled as fixtures, and the
diagnostics index says which runs are smoke evidence rather than population measurements. The
eligible-route record is [Person research source eligibility](person-source-eligibility.md); the
standing check fails any route that costs a key, a payment, a sign-in, an imported session or a
paid proxy. Excluded routes stay excluded with their reasons rather than as silent gaps — Common
Crawl capture retrieval is the named example ([ADR-0072](../adr/0072-common-crawl-capture-retrieval-is-excluded.md)),
and routes that failed a probe stay in the record as explicit gaps.

## Verification gates (AC7)

- `pnpm --filter @chief-of-staff-demo/tests exec vitest run tests/src/modules/person-benchmark-comparison.test.ts tests/src/unit/benchmark-report-compatibility.test.ts` — green while working (42 tests), covering the grouped/coverage/failure fields, the recovery-audit rejection paths, and the loadability of every committed artifact including the regenerated `comparison.json`.
- `pnpm run check` — green on the pushed head (recorded in the pull request).

## What passed and what did not (AC6)

Passed: the comparison artifacts are published for the frozen pair and supersede the earlier record
rather than overwriting its history; the evaluator produces per-person and grouped comparisons with
denominators, coverage gaps and failure breakdowns; every credited recovery is audited against its
own reference and claim text; remaining misses stay preserved as acceptance targets; unsupported
and excluded routes stay explicit; the gates pass.

Did not pass: the pair is **not comparable** (one candidate assessment incomplete), and reference
recovery's improvement is **not established as an acceptance pass** because the candidate side
introduces 28 wrong-person attributions. The owner decides the closing framing: either the pair
stays open with `doug-mcmillon`'s withheld assessment as the single recovery target, or the
identity findings become the next ticket's subject.
