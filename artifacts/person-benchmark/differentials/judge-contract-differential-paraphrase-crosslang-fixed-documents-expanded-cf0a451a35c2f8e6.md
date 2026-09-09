# Judge-contract differential — paraphrase-crosslang (fixed-documents-expanded-cf0a451a35c2f8e6)

## Conditions (held fixed across both arms except the contract)

- **Judge model (both arms)**: openrouter inception/mercury-2.5-preview
- **Corpus**: benchmark/person-research/people version 14bca86ee0b97d28
- **Retained report**: artifacts/person-benchmark/fixed-documents-expanded-cf0a451a35c2f8e6.json (run cf0a451a35c2f8e6)
- **Evidence bundle**: artifacts/person-benchmark/fixed-documents-expanded-cf0a451a35c2f8e6.evidence sha256 5175691a376e7392c48a5c069971ef85bb566cafaa63d16062bec3075aa5c762
- **Population claims**: anders-danielsson=6, kristalina-georgieva=6, sally-kornbluth=5
- **Judge cache namespace**: judge-2026-09-06.10-r1
- **Provider cost (pre-contract arm)**: $0.0016

- **before arm (pre-contract)**: contract 2026-09-06.8 behavior (pre-#236 prompt and guards), recovery prompt sha256 `510e74323a2cf9e53d29e5905b8f1141b1712bdaa823f7d20d8e11eed8e84f16`
- **after arm (contract)**: contract 2026-09-06.10, recovery prompt sha256 `ec1ec760512dd69bb5ae44e20220f8d2b87421a77da57098319f399a38a59531`

## Before and after ambiguous counts

| Side | People | Facts | Recovered | Partial | Missing | Contradicted | Ambiguous | Ambiguous (support-failed) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pre-contract | 3 | 31 | 2 | 8 | 21 | 0 | 0 | 0 |
| contract | 3 | 31 | 3 | 7 | 21 | 0 | 0 | 0 |

Ambiguous reduction before → after: **0** (0 → 0).

## Per-fact verdict transitions (before → after)

| Before \ After | recovered | partial | missing | contradicted | ambiguous |
| --- | --- | --- | --- | --- | --- |
| recovered | 2 | 0 | 0 | 0 | 0 |
| partial | 1 | 7 | 0 | 0 | 0 |
| missing | 0 | 0 | 21 | 0 | 0 |
| contradicted | 0 | 0 | 0 | 0 | 0 |
| ambiguous | 0 | 0 | 0 | 0 | 0 |

Facts with a changed verdict: **1**.

- sally-kornbluth/duke-provost: partial → recovered

## Residual ambiguity by cause

### pre-contract (0 ambiguous)


### contract (0 ambiguous)


## Support-phase failures (reported separately, never counted as semantic ambiguity)

No support-phase failures in either arm: every ambiguous verdict above is a completed assessment.

## Notes

- The after arm reuses the retained verdicts judged at research time under 2026-09-06.10; no model calls were spent on it. The before arm re-judged the same evidence live under the pre-#236 prompt and guards. The retained report was judged under the current 2026-09-06.10.
- Support-phase requests in the before arm replayed the run's judge cache (judge-2026-09-06.10-r1), so support outcomes are byte-identical in both arms and only the recovery contract varies.
- Ambiguous → decided transitions before → after: 0; decided → ambiguous: 0. The difference is the measured reduction attributable to the paraphrase/cross-language contract on this population.
- The before arm is one live sample per fact at temperature 0; resampling noise is not separated from the contract effect. The prompt eval (eval:judge-contract) asserts the decidable cases deterministically.

