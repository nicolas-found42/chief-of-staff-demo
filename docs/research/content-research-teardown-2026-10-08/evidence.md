# Evidence ledger

Baseline: `d51fc3f37893b3d823deeb2ebfd6f96519ad6259`.
Source changes are the Content Research working-tree diff against that revision.
The source/test snapshot supplied to the pre-review gate is retained in [patch.diff](evidence/patch.diff),
generated directly from Git diffs (new files use `--no-index`) for the final gate.
Snapshot SHA-256: `b9fe006034743ac45d2c0980881c17c150fa896598391e918a70604a4ff03a01`.
The accepted backup and its failed predecessor stay private under Documents/backups.

| Witness | Exact command / scope | Outcome |
|---|---|---|
| [Initial module/UI baseline](evidence/baseline-tests.log) | `pnpm --filter @chief-of-staff-demo/tests exec vitest run tests/src/modules/content-research.test.ts tests/src/modules/content-research-prerequisites.test.ts tests/src/modules/content-research-profile-lifecycle.test.ts tests/src/unit/content-ux-regressions.test.tsx` | 4 files, 55 tests passed before new regressions. |
| [Integrity reproduction](evidence/integrity-before.log) | `pnpm --filter @chief-of-staff-demo/tests exec vitest run tests/src/modules/content-research.test.ts --reporter=verbose` | 5 new evidence regressions failed; 34 existing cases passed. |
| [HN reproduction](evidence/hn-before.log) | `pnpm --filter @chief-of-staff-demo/tests exec vitest run tests/src/modules/content-research-hn.test.ts --reporter=verbose` | 8 failed, 1 valid-empty control passed on original adapter. |
| [UI reproduction](evidence/ui-before.log) | `pnpm --filter @chief-of-staff-demo/tests exec vitest run tests/src/unit/content-ux-regressions.test.tsx --reporter=verbose` | 4 new recovery regressions failed; 9 prior cases passed. |
| [Watch boundary](evidence/watch-input-before.log) | `pnpm --filter @chief-of-staff-demo/tests exec vitest run tests/src/modules/content-research.test.ts -t 'rejects malformed handle hints' --reporter=verbose` | Invalid hints were accepted with HTTP 200; expected 400. |
| [Pre-review narrow check](evidence/narrow-final.log) | Baseline command plus `tests/src/modules/content-research-hn.test.ts` | 5 files, 77 tests passed. Includes legacy URL collision/update and late-page failure holdouts. |
| [Browser before](evidence/browser-before.log), [after](evidence/browser-after.log) | Build production bundle, then `pnpm --filter @chief-of-staff-demo/tests exec playwright test content-research-recovery.spec.ts --workers=1` | Original UI: 3 failed; changed UI: 3 passed. Both use identical controlled asynchronous API responses. |
| [Whole-tree gate](evidence/check.log) | `pnpm run check` | Exit 0; typecheck, lint plus 12 policy probes, format, knip, workflows; 299 files / 3,669 unit tests pass. Earlier lint failures were repaired before this run. |
| [Full browser suite](evidence/e2e-all.log) | `pnpm run test:e2e` | Exit 0; production build plus 146 Chromium tests pass, 3.3 minutes. Includes reflow, keyboard/a11y, existing profile and content journeys. |
| [Docker build](evidence/docker-build.log), [health](evidence/docker-health.json) | `docker compose build`; isolated `docker compose -p content-research-teardown up -d --no-build` with `APP_PORT=4417`, `RELAY_PORT=4418`, disposable Workspace and all installation credentials explicitly empty; `curl -fsS http://127.0.0.1:4417/api/health` | Images built; booted app returns `{"ok":true}`. Canonical Workspace was not started. |
| [Setup refusal](evidence/docker-readiness.json), [HTTP status](evidence/docker-readiness-status.log) | `POST http://127.0.0.1:4417/api/content-research/run` | 409 `content-research-setup-required`. Correct negative control, not an execution failure. |
| [Anonymous HN before](evidence/live-hn-before.log), [after](evidence/live-hn-after.log) | Existing adapter transport, `env -i PATH="$PATH" pnpm exec tsx .scratch/content-research-teardown/live-hn-{before,probe}.mts`; target `https://hn.algolia.com/api/v1/search_by_date?query=Paul%20Graham&tags=story`, 90-day window ending `2026-10-08T15:23:12.502Z` | 30 → 43 distinct items, one request each, no credential environment variables; bounded dates. Original adapter is an archived baseline copy with imports adjusted to the project. |
| [Live module](evidence/live-module.log) | `env -i PATH="$PATH" pnpm exec tsx .scratch/content-research-teardown/live-module.mts` | Real anonymous HN fetch through ContentResearchHost backfill; local durable result, 43 stored, top 3 independently checked, stub hook, unconfigured external outputs. |
| [Initial viewport](evidence/content-research-initial.png), [final page](evidence/content-research-after.png) | Jev Browser on the isolated Docker route at 1280px | Inspected pixels; setup refusal, seeded watchlist and Research Runs surface. Initial is viewport-only, final is full page: not a matched layout comparison. |
| [Initial Jev review](evidence/review-initial.json) | Raw production diff and earlier narrow check logs | Escalated, safe .31. Retained. |
| [Pre-review Jev gate](evidence/gate-final.json) | Raw per-file production AND changed-test diffs; real current check/browser/live/Docker logs; five completion claims | Escalated, minimum safe .45; all five claims verified, no contradictions, three low-confidence claim reviews. No automatic Jev approval is claimed. Stronger reasoning review and deterministic claim resolution are recorded separately. |

The reported before/after behaviors are scoped to the witnesses above. Neither a
healthy Docker app nor an HTTP-intercepted browser journey establishes real model
hook quality, authenticated Google publication or exhaustive platform collection.

Jgrep self-review returned no matches for an added handler lacking validation and
production debug/placeholder output: both searches exited 1, meaning no semantic
match (not an error). Actual raw-diff inspection remains the review authority.

GitHub's live main rules require `check`, `test`, `e2e`, and `image`. A PR must use
those checks at its current head SHA and `gh pr merge --squash --match-head-commit`.
Final merge state is verified by the delivery response; these local witnesses were
measured before the commit and CI, and are not silently attributed to a later SHA.


[Claim review resolution](evidence/claim-resolution.md) records the bounded
follow-up verification. The stronger Standards and Spec patch reviews are recorded
separately; the Jev gate's unfavorable verdict remains preserved.

The stronger review found one HN diagnostic evidence defect after the pre-review
gate. [Its separate Standards and Spec reports](evidence/stronger-review.md) record
the finding, fix, and bounded re-review. [HN diagnostic regressions](evidence/hn-review-fix.log)
pass all 12 tests; [the updated narrow suite](evidence/narrow-final-review.log)
passes 78 tests across five files. This is a real patch change, so subsequent checks
and a new final gate use the updated diff rather than retrying an unchanged judgment.

Report scope judgment: Jev assigned .18 to overstatement of real-user evidence
(`uncertain`), .15 to hidden assistance, .07 to an exhaustive claim from one query,
and .06 to omission of the unfavorable gate. Host resolution: the report explicitly
labels simulated reactions, assisted HTTP/model probes, one-query results and the
escalated gate; it makes no population or adoption claim. No unchanged judgment was
retried. Temporary browser and isolated Compose containers were closed, the
never-started backup container removed, and the canonical app remains stopped.
The accepted private backup and pre-existing `output/` remain preserved.

Final updated source/test snapshot: [patch-final.diff](evidence/patch-final.diff),
SHA-256 `6a74252dedff30043227b658d623871f5ea5a943e40b21ab824b93627e1a4c17`.
[Updated check](evidence/check-final.log): exit 0, 299 files / 3,670 tests.
[Updated image build](evidence/docker-build-final.log),
[boot](evidence/docker-boot-final.log) and
[health](evidence/docker-health-final.json) all succeeded after the HN diagnostic fix.
The web source and recovery tests did not change after the 146-test browser run.

[Updated Jev gate](evidence/gate-updated.json), after the real diagnostic amendment:
`escalate`, composite .7405, minimum safe-to-apply .42 (module.ts). Five claims
verified, no contradicted or unsupported claims; browser chronology confidence .29
and live-query confidence .62 required review. Literal local check, narrow/HN suite
and Docker claims were auto-verified at .99/.94/.82. The bounded live-query literal
was already verified at .90 in the earlier claim resolution. Host inspection of
full browser log confirms 146 passed; original controlled recovery log confirms
three failures and changed recovery log three passes. These logs predate the final
HN diagnostic amendment; no changed web source or test is attributed to a new run.
The stronger reviewers examined the final production logic, with the HN amendment
confirmed in the bounded re-review. Their resolution of patch concerns stands;
the unfavorable Jev verdict is retained rather than called approval or retried.
Local final check started 2026-10-08 11:36:20 EDT, duration 73.40 seconds; final
isolated boot/health was measured after the image build around 11:38 EDT.
