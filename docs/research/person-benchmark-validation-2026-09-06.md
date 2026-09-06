# Person Research Benchmark validation — 2026-09-06

Issue #228 remains incomplete. The implementation, corpus authoring, regression tests and local
gates have progressed; live quality acceptance has not passed. All changes remain uncommitted
on `codex/person-research-quality-evaluation`, reviewed against
`30b5a420c7be425f8f55a62ef909e22e6acebf01`.

## Corpus

The validated collection contains 30 real people, 234 reference facts and 77 unjustified
conclusions. Every retained document hash and cited reference excerpt passes the loader.
The corpus content version is `41d616ea8dfb1786`; changing reference content changes this
version even if an author's version label stays the same. Duplicate document IDs and duplicate
person slugs are rejected.

Facts cover 19 of the 20 dossier requirements. `r18`, capability intersections with
denominators, requires a collection-level query scenario rather than an invented individual
biographical fact. Existing fictional acceptance fixtures exercise that behavior, but the real
benchmark does not yet evaluate it. Source-family balance remains weak outside documents and
published work; broad demographic coverage alone does not establish strong references across
all source families.

## Regression evidence

The Person Profiles composition tests now exercise discovery expansion beyond earlier result
caps, visible deferred selection, record readers and providers, document conversion, feed
transcript following, captions and caption absence, social authorship, challenge fallback, and
observed HTTP failure classification. Bounded runs preserve their operation ID, traversal and
attempt history. Changed transcript evidence invalidates a checkpoint even if its job was
already queued; changed profile revisions also invalidate it. These continuation regressions
were observed failing before the corresponding fixes and passing afterward.

Evaluator regressions cover invalid judge evidence, semantic overclaims despite valid quotes,
wrong-person claims, upstream-index independence, reference version changes, duplicate IDs,
interrupted operations, differing comparison populations, and identity regressions. Existing
fictional dossiers remain explicitly separate from the real-person corpus.

Independent Standards review found no hard documented-standard violation. Its nonblocking
observations were duplicated provider JSON transport helpers and repeated queue-status lookups;
the additional source-family type-cast finding was fixed. Independent Spec review found and
verified fixes for false completion with pending work, planner interruption reporting and
checkpoint continuation/invalidation. Review does not replace the outstanding live acceptance.

## Verification gates

- `pnpm run check:all`: passed typechecking, lint, formatting, knip, all 1,951 unit tests
  and all 80 Playwright tests after the final checkpoint fix.
- `pnpm run test:coverage`: passed unchanged floors; statements 83.99%, branches 73.18%,
  functions 86.52%, lines 86.43%.
- `docker compose build`: passed for app and relay. The rebuilt app booted with an isolated
  temporary workspace and returned `{"ok":true}` from `/api/health`; the verification
  Compose project was brought down afterward.
- `--corpus-coverage`: passed document hashes, reference quotes and schemas for all 30 people.
  Its 19/20 requirement coverage is an acceptance gap, not a failed integrity check.
- `git diff --check`: passed.

The production build still prints its large JavaScript chunk advisory; this did not fail the
build. Local gate success does not establish the live quality criteria below.

## Model and source evidence

The corrected two-person fixed-document smoke run is
[`2d0a903133188b6a`](../../artifacts/person-benchmark/fixed-documents-expanded-2d0a903133188b6a.md).
Both operations failed at extraction, with zero response bytes before the model boundary's
120-second ceiling. This is an observed timeout, not a proven explanation of the provider's
internal failure. Some judge calls responded. The configured model remained OpenRouter
`z-ai/glm-5.3-flash`; no runtime credentials or configuration were copied into the artifacts.

The earlier report's incorrect top-level success is explicitly disqualified in the
[artifact index](../../artifacts/person-benchmark/README.md). Failed extraction is now propagated
to the report's failed status. No full-collection live baseline, expanded run or comparison has
been produced, and no quality improvement is claimed.

Source probes returned HTTP 200 with expected JSON shapes for 15 implemented endpoints. Three
additional catalogue entries document unavailable or excluded routes and are not successful
network probes. This is access evidence, not a fresh terms-of-use audit or proof of unique
supported person facts. See [source eligibility](person-source-eligibility.md).

## Remaining acceptance work

1. Diagnose the configured model's extraction timeout using the retained attempts and production
   model boundary; obtain a successful fixed-document smoke run without changing the settled
   runtime model implicitly.
2. Add a real collection-level `r18` scenario and strengthen underrepresented source families
   from independently researched, retained evidence. Never weaken references to match output.
3. Complete the full fixed-document run, live incumbent and expanded runs, and comparable report
   pair with fixed references and judge version. Preserve remaining misses and failures.
4. Finish the requirement-by-requirement acceptance audit, including lifecycle and evaluator CLI
   edge cases; broad passing test counts are not a substitute for this audit.
5. Present the final reviewed changes and proposed commit message for explicit approval before
   staging or committing, as required by the implementation handoff.
