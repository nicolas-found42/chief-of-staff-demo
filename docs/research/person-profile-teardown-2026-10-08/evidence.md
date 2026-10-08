# Experiments and decisions

All inputs and Workspace mutations in this teardown were disposable. Raw local
working logs are under `.scratch/person-teardown-20261008/raw-evidence`; selected
reviewer-accessible evidence is retained in this directory's `evidence/` folder.
Published log copies normalize trailing whitespace; the local raw copies remain
untouched. JSON copies are formatted without changing values.

| ID | Hypothesis/control and discriminating experiment | Outcome and decision |
| --- | --- | --- |
| E1 | Existing supported Docker build/start and person-specific unit/browser journeys can establish a usable baseline. Keep a separate Workspace on port 4397. | Docker build/boot and 14 browser journeys passed. Initial unit subprocess timeouts resolved on the same files at bounded concurrency; not classified as defects. |
| E2 | API boundary mistakes should return client refusals, not server exceptions. Compare valid synthetic creation with numeric fullName, invalid URL, repeated query and archived lookup. | [Before HTTP](evidence/http-before.json): valid 201; numeric name, invalid URL, repeated query and archived lookup 500. [After HTTP](evidence/http-after.json): invalid cases 400; restore and stable reuse 200. D1/F1 accepted. |
| E3 | Canonical profile URL repair must agree with identifier entry. Compare company/single-label URLs with a valid regional/tracked person URL; inspect state and revisions. | [Boundary regressions before](evidence/boundary-before.log) fail. API tests now refuse company/single-label URLs without writes; normalize valid LinkedIn and retain revision 1 exactly. Docker replay preserves deliberately bad baseline revision 2 and writes normalized revision 3. D2/F2 accepted. |
| E4 | A list response after an identity edit can submit a stale closure or warning. Defer the same-name read, edit the manual or identifier name, then resolve with matching and nonmatching records. | [Before entry tests](evidence/entry-before.log): two new regressions fail. After: no stale mutation/warning; resubmission uses current identity. Separate unmount regression proves no creation after leaving. F3 accepted. |
| E5 | The deferred-read fix works through actual browser UI/API, with normal duplicate recovery still available. | Entry browser regression delays only GET /api/people, edits the name, then verifies no old Profile exists, retries and opens the existing duplicate. No write endpoint was mocked. |
| E6 | Probe totals currently conflate declarations and real access. Supply two actual probes (success/success or success/503), one unprobed production and one excluded route. | [Before probe tests](evidence/probe-report-before.log): both new cases fail. Current tests expect 2/2 exit 0 or 1/2 exit 1 and both unprobed denominators. D4/F4 accepted. |
| E7 | Configured anonymous source probes can run without inherited credentials; explicitly retain routes the command does not exercise. | `env -i PATH="$PATH" node --import tsx scripts/person-research-benchmark.mts --probe-sources`: [23/23 pass](evidence/anonymous-source-probes-final.log); 27 production and 9 excluded/unavailable not probed. One earlier LOC timeout resolved on later attempts; not an all-provider quality claim. |
| E8 | A no-job Profile hides correct readiness through the early return. Compare ready vs missing-provider responses; preserve the existing no-empty-tabs requirement. | [Before tests](evidence/initial-readiness-before.log): ready and blocked control assertions fail. Initial implementation caused the existing content-UX empty-tab regression to fail; corrected conditional section rendering instead of weakening the test. [Final focused check](evidence/initial-readiness-complete.log): 33/33 across two files. Real Docker UI exposes setup and disabled research control. D3/F5 accepted. |
| E9 | Final code remains compatible outside the narrowly fixed seams. Run the whole check, full browser suite, production rebuild/boot, HTTP replay and restart retention; review actual patch. | Final outputs, Jev result and host review are recorded below. |

## Reproduction commands and assertions

The HTTP records contain request methods, paths, synthetic payloads, response
codes and complete JSON responses. No credential or real Workspace data is in
them. The isolated stack intentionally omits relay with `--no-deps`; relay polling
failures are harness limitations rather than person research conclusions.

Before-regression commands (run against baseline code with newly added assertions):

```sh
pnpm --filter @chief-of-staff-demo/tests exec vitest run src/api/people-routes.test.ts src/api/people-lookup.test.ts --maxWorkers=2
pnpm --filter @chief-of-staff-demo/tests exec vitest run src/unit/new-person-profile-page.test.tsx --maxWorkers=2
pnpm --filter @chief-of-staff-demo/tests exec vitest run src/modules/person-benchmark-cli.test.ts --maxWorkers=2
pnpm --filter @chief-of-staff-demo/tests exec vitest run src/unit/person-dossier-page.test.tsx --maxWorkers=2
```

Current regressions are linked in the source:
[API refusal and corrections](../../../tests/src/api/people-routes.test.ts),
[archived lookup recovery](../../../tests/src/api/people-lookup.test.ts),
[pending-entry cancellation](../../../tests/src/unit/new-person-profile-page.test.tsx),
[browser duplicate recovery](../../../tests/e2e/person-entry-form.spec.ts),
[probe denominators](../../../tests/src/modules/person-benchmark-cli.test.ts),
[no-job readiness](../../../tests/src/unit/person-dossier-page.test.tsx), and the
unchanged [empty-tab guard](../../../tests/src/unit/content-ux-regressions.test.tsx).

Final commands:

```sh
VITEST_MAX_WORKERS=4 pnpm run check
pnpm run test:e2e
docker compose build
APP_PORT=4397 WORKSPACE_DIR="$PWD/.scratch/person-teardown-20261008/workspace" GOOGLE_CLIENT_ID= GOOGLE_CLIENT_SECRET= OPENROUTER_API_KEY= OPENAI_API_KEY= ANTHROPIC_API_KEY= GEMINI_API_KEY= docker compose -p person-teardown-20261008 up -d --no-build --no-deps --force-recreate app
curl --fail http://127.0.0.1:4397/api/health
env -i PATH="$PATH" node --import tsx scripts/person-research-benchmark.mts --probe-sources
env -i PATH="$PATH" node --import tsx scripts/person-research-benchmark.mts --corpus-coverage
docker compose -p person-teardown-20261008 down --rmi local
```

## Judgment log

Judgments are secondary signals; raw runtime outcomes establish facts. The
[raw judgment record](evidence/judgments.json) includes the external screens,
finding classification, implementation decision, first patch review and probe
claim check. Screens passed (injection probabilities 0.09 and 0.07).

- Risk ranking placed identity repair and retained-evidence provenance above
  malformed inputs and optional research additions. This guided probes; it was
  not a severity score.
- Early F3 classification was unresolved until the deferred-response experiment.
  O1 `sameAs` was flagged for review (opportunity 0.65, confidence 0.54); no
  rule or experiment demonstrated benefit, so it remains unimplemented.
- D1 selected installed Zod, probability 1, no contradicted requirements.
- F1/F3 verification needed review at confidence 0.58/0.61. Exact HTTP status and
  observed red assertions resolve the narrow claims. F2's accepted company URL
  was verified with probability 1 and confidence 0.99.
- First patch review escalated (safe-to-apply 0.45, correctness confidence 0.22,
  composite 0.647). It was retained and not repeated unchanged. Source inspection,
  whole-tree tests, production replay and the F5 reattack provide new evidence.
- F4 verification supported the counting claim but with confidence 0.40. The host
  checked the exact filter expression and both deterministic success/failure
  examples, and corrected the summary instead of claiming 59 live probes.
- Critique-of-critique reduced claims about archived UI failures, acknowledged
  that simulated personas establish no preferences, and separated response
  availability from research quality.
- F5 comparison: actionable guidance contradiction 0.91/confidence 0.86; overall
  contradiction 0.78/confidence 0.66 and other aspects uncertain. Direct source
  and rendered/test evidence support only the documented initial-state defect.

## Final gate and resolution

The first complete gate payload failed operationally with provider
`max_tokens_exceeded`; it supplied no pass. The actual runtime/test diff was then
partitioned along four independently fixable boundaries, retaining raw hunks and
the relevant current logs. None of these gates automatically accepted the patch:

| Scope | Safe to apply | Composite | Claim result |
| --- | --- | --- | --- |
| API / URL repair | 0.27 | 0.580 | Two verified, confidence 0.45/0.44; escalation |
| Pending entry | 0.28 | 0.643 | Contradicted, confidence 0.83; escalation |
| No-job dossier | 0.41 | 0.678 | Verified, confidence 0.37; escalation |
| Probe summary | 0.12 | 0.500 | Contradicted, confidence 0.23; escalation |

The unfavorable [API](evidence/gate-api.json), [entry](evidence/gate-entry.json),
[dossier](evidence/gate-dossier.json) and [probe](evidence/gate-probe.json) results
are preserved. They contain rubric distributions and limiting confidence, rather
than an identified source-level bug. They must not be described as automatic
approval.

The stronger host source review below resolved the patch-confidence concerns
against code and direct production/browser outcomes. For the entry contradiction,
fresh named regressions separated current passing evidence from the deliberately
red baseline: **112 tests across five affected files passed in 7.38 seconds**.
The current pending-edit browser journey also passed. For probe reporting, the
host checked the literal final output and counted the attempt categories:
23 + 27 + 9 = 59, with only the first denominator describing performed probes.
These were discriminating checks prompted by the disagreement, not unchanged
judgment retries.

[Current named output](evidence/final-named-regressions.log) and the exact current
source/CLI output were then supplied to `jev_verify`, excluding baseline failures
from claims about current state. It verified the entry result at supports 0.92,
confidence 0.89, and the probe result at supports 1, confidence 0.99; both auto,
zero contradictions/unsupported claims. [Resolution](evidence/final-claim-resolution.json).
The final gate's review escalation remains recorded; host review, rather than
model agreement, is the disposition for patch application. No accepted finding
is left unimplemented; the report's live research and platform limits remain.

## Host source review

The stronger host review traced each changed path rather than accepting the first
Jev composite. Create/correction schemas preserve optional fields and correction
nulls; merge resolutions remain restricted to existing fact keys. Parser failures
become named client refusals before mutation. The shared URL parser preserves the
creation identity policy and historical revisions are not rewritten. Entry
generation checks occur after the awaited duplicate read and before either
warning or creation; editing and unmount advance the generation. Dossier controls
retain their existing disabled/readiness policy, while section navigation renders
only once a job or dossier exists. Probe exit status depends on actual attempt
failures rather than unprobed declarations. No dependency or stored-format changes
were introduced. React section indentation is a consequence of the new render
condition, not a separate refactor.

In particular, the URL parser and the correction's email rejection share
`EMAIL_PATTERN`; every non-email successful parse assigns one profile URL before
returning. Both entry callers return before mutation when the generation changed,
and every identity edit plus effect cleanup increments that generation. A failed
duplicate read still has its existing advisory behavior. The no-job conditional
preserves the old absence of section tabs while rendering the established
readiness-specific disabled control and action error handling. Fresh named
regressions and direct Docker assertions cover the narrow behavior promised;
the host does not infer correctness of untested input or live extraction.

Two staged-diff jgrep checks — debugging output and request bodies without field
validation — returned zero hits with exit status 1. Neither returned status 2;
they are semantic checks, not proof of the absence of every defect.

`VITEST_MAX_WORKERS=4 pnpm run check` passed: **298 files / 3,647 tests**,
103.54 seconds for Vitest, plus all static gates and 12 lint-policy probes.
[Actual final log](evidence/check-verified.log).

The first full browser recheck passed 142 tests and failed one obsolete assertion
that required Research settings to remain absent before the first job. That
assertion conflicts with F5's accepted new behavior; it was replaced with positive
checks for the settings and start control plus a retained zero-empty-tabs guard.
Source retention and subsequent research assertions were preserved. This failed
run is not called green; the updated journey and full suite were rerun.

`pnpm run test:e2e` passed **143/143 browser tests in 1.9 minutes**, including
the production web build. The updated dossier journey separately passed 5/5 in
38.0 seconds. [Full output](evidence/e2e-complete.log),
[focused output](evidence/dossier-browser-updated.log). The post-update
`pnpm run check:static` also passed all gates.

`docker compose build` passed for app and relay. App manifest index:
`sha256:2aa00d878e0bb0c6f713d4c8268f53a30e90a6a862aaac923d049e10dd3efc8e`.
The isolated, credential-cleared app returned `{"ok":true}` and passed a direct
replay of ten malformed-input refusals, archived conflict/restore, normalized
reuse, unchanged state after refused repairs, exact baseline revision-1 retention
and no-job missing-provider readiness. The deliberately bad baseline revision-2
company URL remains readable as historical evidence. [Build log](evidence/docker-verified-build.log),
[HTTP replay](evidence/production-replay.json), [assertion output](evidence/production-replay.log).

The final production UI was inspected at the same 1049×987 viewport as the
baseline. It shows the provider blocker, Open Guided Setup and disabled Prioritise
research control, with no dossier tabs; maintenance remains usable. These are
executed screenshots, not mockups. No model extraction or provider account action
was initiated.

After an app restart the health response and the entire direct replay passed
again, including exact historical retention. [Restart output](evidence/production-restart-replay.log).
The test browser tab was closed and the isolated Compose project brought down;
the disposable data and raw logs remain under `.scratch/` for replay.

The final pre-push `VITEST_MAX_WORKERS=4 pnpm run check` repeated on the complete
checkout passed 3,647 tests / 298 files and all static gates (Vitest 69.32 seconds).
[Pre-push log](evidence/check-before-push.log). This is a repeat measurement, not
a claimed performance improvement.
