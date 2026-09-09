# The incumbent baseline freezes the acceptance pair

The #257 incumbent run freezes the comparison conditions #258 inherits:
corpus `14bca86ee0b97d28` with judge `z-ai/glm-5.3-flash` at `JUDGE_VERSION`
`2026-09-06.10`, prompt `2026-09-06.4`, collector `person-research 2026-09-06`.
The incumbent is the configured reconstruction at git `273dc99` — 25
pre-expansion providers, merged ceiling 24, `html`/`text` readers only, narrow
3-seed set, no planner, serial reads, 12 calls and 120000 ms per profile —
with identity, extraction prompt/binding selection and per-source retry
remaining today's production implementation in both arms, as the report's
provenance records.

Comparability holds across the drift to current main: `pipelines.ts` is
unchanged, `JUDGE_VERSION` is unchanged, the corpus is untouched, and the
`judge.ts` drift is additive only — an optional `JudgeContract` parameter
defaulting to the current contract, plus a measurement-only pre-#236 variant
that is never the production contract.

The run's top-level status is honestly `failed`: 3 of 30 operations concluded
`bounded`, the expected consequence of the incumbent's short allowance, not a
defect to fix. Evaluation execution completed 30 of 30 with the collection
scenario assessed (expected `bong-joon-ho`, not recovered). Two reporting
limits are recorded, not repaired: the `.md` usage row prints only character
counts with fixed "unavailable" wording while the `.json` carries the
provider-observed tokens and cost, and the judge-cache flag is not part of
provenance (the cache is keyed by judge version and repeat, so a hit replays
an identical answer and cannot change a verdict).
