# The incumbent baseline freezes the acceptance pair

The #257 incumbent run freezes the comparison conditions #258 inherits:
corpus `14bca86ee0b97d28` with judge `z-ai/glm-5.3-flash` at `JUDGE_VERSION`
`2026-09-06.10`, prompt `2026-09-06.4`, collector `person-research 2026-09-06`.
The incumbent is the configured reconstruction at git `273dc99` — 25
pre-expansion providers, merged ceiling 24, `html`/`text` readers only, a
narrow seed set the reconstruction caps at three in `configurePipeline`
(the count is code, not a provenance field), no planner, serial reads,
12 calls and 120000 ms per profile —
with identity, extraction prompt/binding selection and per-source retry
remaining today's production implementation in both arms, as the report's
provenance records.

Comparability is identity, not analogy: at the run's `gitSha` the shared
machinery is byte-identical to today's main — `pipelines.ts` unchanged,
`JUDGE_VERSION` unchanged, the corpus untouched — so both arms run today's
identity, extraction prompt/binding selection and per-source retry. The only
later person-benchmark drift is main-side and additive (an optional
judge-contract parameter defaulting to the current contract, plus a
measurement-only pre-#236 variant), which preserves this arm's behavior.

The run's top-level status is honestly `failed`: 3 of 30 operations concluded
`bounded`, the expected consequence of the incumbent's short allowance, not a
defect to fix. Evaluation execution completed 30 of 30 with the collection
scenario assessed (expected `bong-joon-ho`, not recovered). Lead-level
`interrupted` dispositions (26 leads) are backlog churn inside operations,
not operation outcomes: no operation concluded `interrupted`.

Isolation is attested, not assumed: the run researched inside one `mkdtemp`
temporary workspace directory, the 30 operation records carry 30 unique
profile IDs, and the run commit touches only `artifacts/person-benchmark/`.

One reporting error is repaired alongside this record: the `.md` usage row
used fixed "unavailable" wording even when the `.json` provenance carried
provider-observed tokens and cost, because the renderer never read those
fields. The renderer now prints observed figures and reserves "unavailable"
for halves the boundary truly never supplied, and the `.md` is re-rendered
from the committed `.json` (untouched) — the row now reads tokens 688344
in / 325706 out with cost $0.113218. One limit remains recorded: the
judge-cache flag is not part of provenance (the cache is keyed by judge
version and repeat, so a hit replays an identical answer and cannot change
a verdict).
