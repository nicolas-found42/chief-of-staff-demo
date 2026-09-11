# OpenRouter defaults to Mercury 2.5, and the judge inherits it

The Workspace owner directed, in issue #381's follow-up session, that
`inception/mercury-2.5` serve every LLM call. `DEFAULT_MODELS.openrouter`
(`packages/shared/src/schemas.ts`) changes from `z-ai/glm-5.3-flash` to
`inception/mercury-2.5`. Every Settings purpose without an explicit
per-purpose override (`ConfigStore.getForPurpose`,
`apps/server/src/config.ts`) now falls back to this model when the
Workspace's own `config.model` is empty. `defaultModelPriceEvidence()`
(`packages/shared/src/model-admission.ts`) gains a price row for
`inception/mercury-2.5` (input $0.04/M, output $0.15/M, 260k-token context,
sourced from OpenRouter's live `/api/v1/models` and cross-checked against
this session's own measured call costs) — without it, `ModelBudgetLedger`
throws `UnknownModelPriceEvidenceError` on the first budgeted call to the new
default.

The live Workspace's `config.json` already carried `provider: "openrouter"`,
`model: "inception/mercury-2.5"`, `models: {}` before this change, so every
production purpose already resolved to Mercury by direct configuration; the
default-constant change makes a fresh Workspace agree with that choice
out of the box and removes `z-ai/glm-5.3-flash` as the fallback anyone would
silently revert to by clearing the model field.

## The consequence this decision knowingly accepts

`evaluationJudge` resolves through the identical fallback
(`getForPurpose("evaluationJudge")`, used by
`scripts/person-research-benchmark.mts` and every judge-contract script).
With `models: {}` and no explicit `evaluationJudge` override anywhere in the
live Workspace, the evaluation judge now also resolves to
`inception/mercury-2.5` — the same model the candidate extraction runs
under. Issue #381's own questionnaire artifact
(`docs/research/person-profile-llm-cost-latency-questionnaire-results.md`,
Q11: "Keep the judge independent of the tested extraction model"; Q13:
"Disabling judges to reduce production cost: they are evaluation-only"; Q17:
"Keep the independent judge and use its cache correctly") and `CONTEXT.md`'s
**Acceptance pair** glossary entry (`_Avoid_: Model pin (that covers research
models too)`) all name this as the exact failure mode a model change must
not produce: a candidate self-judging its own output.

ADR-0091 already recorded one prior instance of this — the `#259` correction
run judged Mercury-produced research with a Mercury judge — and called
re-baselining under one judge "an owner decision about spend and scope,"
left open rather than settled. This ADR does not settle it either. The
owner's directive here was explicit and unqualified ("all LLM calls"), and
implementing a judge-only carve-out the owner did not ask for would be
inventing scope against a plain instruction, not protecting an invariant no
one noticed. No seeding, override, or protective code was written for
`evaluationJudge` in this change.

## What reverses this, if the owner wants an independent judge back

One Settings write, no code change: `PUT /api/config` with
`{ "models": { "openrouter": { "evaluationJudge": "z-ai/glm-5.3-flash" } } }`
(or any other model) gives the judge its own purpose-scoped override, which
`getForPurpose` already honors ahead of the provider default — the same
mechanism `personProfileClaims` uses (ADR-0093). Until that write happens,
every paired evaluation run against this Workspace judges Mercury with
Mercury, and that comparison's results should be read with that in mind.

## Considered Options

- **Seed an explicit `evaluationJudge` override at config-normalize time,
  pinned away from the new default.** Rejected: the owner's instruction was
  "all LLM calls," not "all LLM calls except the judge." Building an
  unrequested carve-out is scope invention, not a bug fix, and it would
  silently move the judge to a model the owner never chose for it either.
- **Refuse the default change until the owner explicitly addresses the
  judge.** Rejected: the instruction was unambiguous and the reversal above
  is a single Settings field: the cost of asking first exceeds the cost of
  documenting the consequence and leaving it reversible.
- **Change `DEFAULT_MODELS.openrouter` only, leave price evidence
  unaddressed.** Rejected: every budgeted Person Profile call would fail
  immediately with `UnknownModelPriceEvidenceError` the first time it
  resolved to the new default — not a smaller change, a broken one.
