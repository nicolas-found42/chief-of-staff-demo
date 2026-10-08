# Adversarial teardown, improvements and verification

Baseline: `92f473f3e874a449ccce388ee8ef2237b29234e2` (2026-10-08).
Target: Found42's local single-owner app, five product areas, pnpm monorepo.
Evidence: [execution ledger](evidence.md); regressions link to the actual tests below.
Environment: macOS, Node 26.9.0, pnpm 12.3.4, Docker Compose 5.5.1;
production image uses its pinned Linux/Node/Chromium stack. No new dependencies.

## Scope and original acceptance criteria

The simulated skeptical owner wants to capture follow-up work, edit it across browser tabs,
recover from errors, and understand what the app will send or accept automatically.
Audience basis: [CONTEXT](../../../CONTEXT.md), ADR-0001, ADR-0052 and ADR-0104.
No simulated reaction establishes real-user preference or adoption.

Criteria fixed before implementation: fresh isolated Docker boot and usable UI/API; local Task
capture/edit/restart with stable identity; invalid input must not mutate records; overlapping
edits must not silently lose accepted work; unrelated browser requests must not mutate the
Workspace; documentation must accurately disclose outward writes and supported setup.
A later discriminating holdout varied due-date grouping without changing these goals.

Working investigation budget: 60 minutes, at least half reserved for implementation and final
checks. Focused experiments took precedence over broad model/provider benchmarking. This is
bounded executed coverage, not an exhaustive security or retrieval certification.

Isolation: `.scratch/teardown-2026-10-08/workspace`, Docker project
`chief-adversarial-20261008`, app port 4397; synthetic browser attack origin on 4399.
The test app used the canonical images and no installation credentials, login state, or real
mail/Task destinations. Existing `chief-feature-tour` containers and unrelated untracked
`output/` were preserved. No stored-format change or real Workspace migration was needed.

## Findings and dispositions

| ID | Classification / impact | Evidence and smallest reproduction | Change and acceptance witness |
|---|---|---|---|
| F1 | Confirmed defect / potentially substantial unauthorized mutation and disclosure | Create a synthetic Task. POST its `/complete` action with unrelated Origin: 200 and completed state. A real browser text/plain form from port 4399 changed open v5 to completed v6. GET `/api/tasks` with Host `attacker.invalid:4397`: 200 with Task data. ADR-0001's trusted local owner is the basis. | **Fixed.** Global request hook rejects non-loopback Hosts, unrelated Origins, and cross-origin browser API fetch metadata before routes run. HTTP 403 plus byte-equivalent Task state is asserted by [composition tests](../../../tests/src/composition/local-request-boundary.test.ts) and a [real cross-origin browser form](../../../tests/e2e/local-request-boundary.spec.ts). |
| F2 | Confirmed defect / accepted work silently overwritten | A opens a Task, edits notes; B saves a different title; A's heading refreshes while its form retains the old title; A saves and silently restores the old title. Existing optional API version guard was unused by the browser. E03 fails before the fix. | **Fixed.** The form's opening version travels to the existing API guard. Stale save returns 409, preserves B's work and A's draft, and exposes recovery. [Two-editor journey](../../../tests/e2e/task-concurrent-edit.spec.ts), E04. |
| F3 | Confirmed documentation defect / misleading consent expectations | README introduction says mail is never sent and transcript Tasks/Gmail drafts are automatic with no review. Its own security footnote, ADR-0034, ADR-0045, ADR-0052/0053 and current UI say otherwise. | **Fixed.** README names owner-only automatic Brief delivery, reviewed Debriefs/Action Items, Workspace Task authority, optional external destinations, and retired `/transcript` workflow. Verified against the cited ADRs and production paths; no real mail was sent. |
| F4 | Confirmed defect / minor API integration burden | GET `/api/tasks?search=a&search=b`: 500, `query.search?.trim is not a function`. Repeated other scalar filters silently select unintended/empty projections. Normal UI emits one value. | **Fixed.** All seven supported scalar Task filters refuse repeated values with 400 and a named error. [API regressions](../../../tests/src/api/tasks-routes.test.ts) preserve the existing record, E02. |
| F5 | Confirmed documentation defect / contributor setup friction | README recommends npm for a pnpm workspace. Credential-free isolated server manifest install returns `EUNSUPPORTEDPROTOCOL`, `workspace:*`, E05. An initial offline root-only attempt instead failed `ENOTCACHED`; that harness restriction is not the product finding. | **Fixed.** README uses pinned pnpm, frozen lockfile, package-filtered Playwright install and actual whole-tree/browser gates. Supported Docker build performs the install successfully. |
| F6 | Confirmed callback contract defect / unsolicited grant acceptance possible | Existing callback test directly sends `?code=grant-code` with no preceding sign-in; simulated exchange stores the grant. Production URL/callback had no OAuth state. Negative regressions refuse exchange but fail before the fix, E06. | **Fixed.** Connect mints a random 256-bit state, pending for ten minutes and consumed before exchange. Missing/mismatched/expired/replayed/superseded state is rejected without replacing an existing grant. Disconnect/restart invalidates pending state. Settings gives a reconnect path. [OAuth tests](../../../tests/src/api/google-callback.test.ts), E07 and browser recovery test. |
| F7 | Confirmed defect / unsaved draft loss during refresh | Same two-editor workload, but B also changes due date. On A's refresh the Task moves groups and the row remounts, removing the edit form and notes. Title-only control passes; group-move holdout fails `Title: element not found`, E08. | **Fixed.** Page-owned drafts keyed by Task identity survive row remounts and retain their opening version. Both title-only and group-move journeys assert draft preservation, conflict refusal and successful reviewed recovery. |
| F8 | Confirmed defect / disconnect or newer consent undone by older exchange | Hold an accepted callback's simulated token exchange pending, then disconnect or start another sign-in. The old exchange resumes and stores its grant, returning connected. The nonce alone cannot cancel work already in flight. Both holdouts fail before the fix (E09). | **Fixed.** Each connect/disconnect advances a generation; the Google connection checks that the callback is still current immediately before its synchronous token write. An obsolete exchange returns to reconnect without altering the grant. Deferred-exchange tests prove both interleavings and that the new attempt can still succeed. |

Competing explanations and falsifiers: F1 does **not** prove actual remote DNS rebinding in every
browser; only missing Host validation and successful local cross-origin mutation were executed.
Browser local-network protections vary. A 403 with unchanged state falsifies the original mutation.
F2/F7 are realistic even for one owner using two tabs; distinct header/form values and the same-group
control discriminate server overwrite from stale rendering. F6's real Google code exchange is
simulated: real exploitability depends on client/test-user posture and obtaining a valid code.
A callback with no initiation must never reach exchange regardless of that posture. F3 has
counterevidence in the old README footnote; its presence does not make the contradictory introduction
accurate. F4 cannot occur through the normal UI and is deliberately rated minor.

No supported finding was left as an implementation backlog. The accountless local-model opportunity
below remains an unvalidated capability opportunity, not a confirmed defect.

## Experiment and decision log

| Experiment | Control / variable | Observation and decision |
|---|---|---|
| X01 → F1 | Local-origin/native requests vs hostile Origin/Host and real form submission | Baseline accepts attack; fix must refuse before any mutation and preserve normal local routes. |
| X02 → F2 | Two real editors, one changes title while the other holds notes | Old save overwrites B; use existing optimistic version guard, frozen at form opening rather than latest polling version. |
| X03 → F4 | Single `search` vs repeated search and six other scalar filters | Duplicate search throws; reject repeated supported filters explicitly. Do not redesign search or reject unrelated unknown parameters. |
| X04 → F5 | Isolated credential-free consumer manifest vs supported pnpm Docker build | npm consumer fails on `workspace:*`; retain pnpm and correct documentation. |
| X05 → F6 | Initiated callback vs absent/forged/expired/replayed state, incomplete scopes and exchange failure | New negative tests fail before fix. Retain existing Google adapter and classify state before calling it. Valid grants and existing scope/error classifications remain covered. |
| X06 → F7 | Title-only control vs due-date change that reparents Task row | First fix passes title-only but loses moved-row draft. Lift draft ownership into the page, preserving values and opening version together. |
| X07 | Original failed requests, app restart, health/UI/assets, normal requests | Final Docker replay checks resulting records and response bodies, not just process exit codes. |
| X08 → F1/F8 | Encoded API path vs literal path; deferred callback interrupted by disconnect/new connect | Re-attack finds four failing holdouts. Matched route checking and a generation-based token commit veto make all four pass; stronger review verifies the synchronous write boundary. |

X08 also corrected an incomplete first F1 fix: raw URL prefix checking missed `/%61pi/tasks`,
which Fastify decodes and serves as the API. The final hook uses the matched route, and both
encoded-path negative tests assert 403. This was demonstrated in the production image and tests;
it is not a claim of remote exfiltration.

Harness correction: the first new overlap test shared a file's persistent workspace with an existing
journey that expected no Tasks. Its extra record caused that journey's failure. Moving it into its
own fixture file fixes isolation; the defect reproduction itself was independent. Broad tests were
initially run alongside builds/unit tests and a second Playwright runner: 137 passed and four
failed (an accessibility timeout, two missing trace artifacts, and a changed test collection).
A stable serial rerun passed all 142. These were harness interference, not product findings.
After X08, all invalidated checks were run again against the changed code.

Clean-install CI exposed one more harness dependency at head
`8584954227de7cd688f363a1ff887e3d9fc46327`,
[run 37757790966](https://github.com/nicolas-found42/chief-of-staff-demo/actions/runs/37757790966):
the new unit test expected `/tasks` HTML although unit CI builds only the shared package.
Both Node 22 and 26 returned 404; `check`, `e2e` and `image` passed. The unit boundary test now
registers a deterministic non-API handler and asserts its exact successful response to cross-site
navigation. Real `/tasks` HTML remains checked by the browser suite and production replay.
All 17 boundary tests pass with the local web bundle temporarily absent (E14), then restored.
No production code, CI configuration or assertion was weakened to resolve this test dependency.

## Research, alternatives and eligibility

Research used the configured Firecrawl MCP and Jev, never added either to project runtime or
required development dependencies. Sources were screened before consumption; provider tool-use
hints and irrelevant promotional instructions were ignored when screening required review.
Discovery included GitHub issues, Reddit and an awesome-list query. The awesome-list query returned
zero results; this is a research gap, not evidence that no alternatives exist. Technical decisions
use primary sources and direct experiments, not model agreement or community popularity.

| Candidate / source checked 2026-10-08 | Mechanism, burden and eligibility | Decision |
|---|---|---|
| Retain only loopback binding | Existing dependency-free deployment; fails X01. Browser CORS affects read access, not a submitted write's side effects. | Reject as sufficient protection. Preserve loopback deployment plus request checks. |
| Internal Fastify hook | Existing Fastify/Node only; no extra package, service, signup, key or software charge. Runs inside credential-free isolated Docker app. No added transitive execution path. | Selected and tested. No token/session storage or persistent-format migration. Native local clients without browser headers remain trusted by design. |
| [@fastify/csrf-protection](https://github.com/fastify/csrf-protection), observed v8.0.1 | Token utilities with cookie/session/secure-session options; Fastify 5 compatible, MIT source; docs explicitly warn the plugin alone does not establish app security. Would still need Host checks and UI token changes. No isolated package execution/transitive eligibility audit performed. | Keep out. Higher integration burden for the observed header boundary; eligibility not claimed merely from MIT/license or README. Reconsider only with a demonstrated gap and credential-free installation/operation test. |
| [MCP Fastify middleware docs](https://ts.sdk.modelcontextprotocol.io/v2/serving/fastify.html), source revision `b022522089a0c8b632595c6e7b536453945ed5a9` | Host/Origin middleware illustrates localhost rebinding protection. Defaults depend on bind host; binding `0.0.0.0` needs explicit policy. MCP app factory/dependencies would be unrelated runtime machinery here. Not installed or audited for transitive eligibility. | Learn from its mechanism; do not add it. |
| [Fetch Metadata specification](https://w3c.github.io/webappsec-fetch-metadata/) and [MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-Fetch-Site) | Browser-owned headers distinguish same-origin, same-site and cross-site. Headerless native clients remain possible. OAuth top-level navigation needs a specific exception. | Combine with Origin and Host checks. Not a substitute for authentication on shared deployments. |
| [Google OAuth web-server guidance](https://developers.google.com/identity/protocols/oauth2/web-server) | Random state and validation before exchange bind a callback to an initiated authorization request. Existing local single-owner server can retain one short-lived pending attempt in memory. | Implement state without new dependency. No grant/session format change; new attempt or restart requires reconnect. |
| Local-model/meeting tools discovered through [Meetily discussion](https://www.reddit.com/r/selfhosted/comments/1mpvgo9/open_source_selfhosted_fast_private_local_ai/) and [Open WebUI alternatives discussion](https://www.reddit.com/r/LocalLLaMA/comments/1tciwwt/simpler_self_hosted_alt_to_open_webui/) | Potential offline transcription/inference capability. The app already exposes an Ollama adapter and packages transcription tools. Community claims do not establish licensing, transitive credentials, memory fit or useful extraction quality. No model installed or account created. | O1: unvalidated capability opportunity. No replacement architecture or dependency justified by this run. A same-workload, accountless local-model quality/resource benchmark is the evidence needed to reconsider. |

## Judgment log and critique of the critique

Jev model: `typesafe/jev-1.13-20260917`, configured OpenRouter provider. Skill hashes:
`adversarial-ux-test` v2.0.0 `c790dcbd617e5481e50fd5aeb432526ef976c14db011b2631ea3f4f73697f157`;
`jev` `7b4e3f55e2b3e813ffe7e97911ef0e9ceb4e576e17332db8f3e1cf8342e84d33`.
Calls supplied bounded public-source excerpts, synthetic records, diffs and actual logs, never credentials.

- Noul: persona fit .90; initial success specificity .78 prompted concrete criteria. Status-only checks
  cannot establish account-backed correctness (.04). No remote-exfiltration proof from Host alone (.03).
- Rerank: security .84, docs .74, Tasks .72. An unauthorized live-provider candidate ranked .68;
  ranking is not permission and it was excluded.
- Compare: mail-policy contradiction .97, confidence .95; Task authority/approval aspects needed
  review. Resolved from ADR-0045/0052/0053, UI and actual paths, not the overall verdict.
- Classify: F1 defect .93, F2 1.0; F3 .80 and F4 .79 flagged review. Explicit host rule: a directly
  contradicted documented behavior or reproduced invalid-input 500 is a defect, with impact rated
  separately. No audience/adoption claims inferred. O1 opportunity .90, not a defect.
- Verify: two-editor overwrite .89 support/.83 confidence; arbitrary Host/Origin acceptance
  .90/.85. Remote DNS exfiltration claim unsupported; removed. Initial OAuth and group-move judgments
  needed review; discriminating negative tests and actual remount holdout supply direct evidence.
- Decide: internal boundary selected 1.0, no requirement contradiction. First malformed decision
  request exceeded the live three-requirement limit; repaired before judgment, not treated as a pass.
- First patch review escalated (`safe_to_apply=.20`, composite .55975) with incomplete post-fix
  execution evidence and no changed-test diff in that payload. This was not accepted as approval.
  Expanded actual regressions, compatibility checks, remount holdout and full raw changed-test diffs
  are required for the final review/gate. No unchanged review was repeated to obtain a preferred answer.
- Expanded per-file review still escalated (`safe_to_apply=.26`, composite .754104) with low
  confidence. Following the installed skill's stronger-reasoner escalation, a separate reviewer
  inspected the actual patch and found F8. Deferred tests reproduced it; the review then confirmed
  the generation guard sits immediately before the synchronous write. The production re-attack
  independently found the encoded-path hole in the first F1 fix. Neither model agreement nor
  previous green tests overruled these failures.
- Noul rated the two new remedies uncertain (.73/.77). Four failing, then passing, discriminating
  regressions supply the missing evidence. Final gate results are recorded with actual final logs.
- Final gate: the first 16-file payload hit provider `max_tokens_exceeded` (operational error,
  never a pass). Repaired by reviewing all 13 changed code/test files, reviewing Markdown
  separately, and selecting actual browser result lines without duplicating the entire log.
  The valid gate was not truncated and **escalated**, composite .622019, `safe_to_apply=.21`.
  Unit claim verified .83; browser claim verified .70/review; isolated runtime claim verified
  .20/escalate; before/after callback claim contradicted .67; no-dependency/format/limits claim
  unsupported .56. This is explicitly **not automatic Jev approval**.
- Stronger-review resolution: the raw red run at 05:24:51 and green run at 05:25:14 contain the
  same two files / 35 tests. The old callbacks return connected and encoded paths return 200;
  after the fixes every holdout passes. The current 3,625-unit / 142-browser results and production
  replay independently corroborate the patch. The contradiction appears to confuse baseline red
  evidence with final behavior. Source inspection confirms the commit veto directly precedes the
  synchronous token write, and manifest/lockfile diffs are absent. No concrete residual defect was
  found by the escalation reviewer. The automated gate's low confidence remains recorded rather
  than hidden or retried for a preferred verdict; the bounded claims stand on these direct checks.
- Clean-unit correction gate reviewed the actual subsequent test delta and final 66.40s check
  output: composite .83925, `safe_to_apply=.69`, escalation for test-gap confidence .14.
  Both claims verified (.46/.76 confidence), no contradiction. Stronger review confirms this
  asserts the boundary's intended non-API handler behavior more precisely without a prebuilt
  bundle; real HTML remains covered independently. No production files changed in this correction.

## Coverage and limits

| Surface | Coverage |
|---|---|
| Installation/runtime | Canonical Docker build and isolated credential-free boot; health JSON, built UI and assets; native tool versions recorded. No clean OS/Docker Desktop installation. |
| Local Tasks | Real UI capture and overlap; API validation, persistence/restart, completion/reopen, lists/trash and existing full unit/browser suite. Draft preservation is within the open Tasks page, not across closing the page/browser. |
| Google consent | Real route/connection adapter with simulated token exchange; nonce expiry/replay/invalid input, scope omissions, redirects and browser error recovery. No real sign-in, refresh token replacement, mail delivery or external Task mutation. |
| Meeting/content/person workflows | Existing hermetic unit/browser journeys exercise real composition/UI with external provider seams simulated. No independent live research completeness, freshness or extraction-quality certification. |
| Retrieval coverage | Frozen fixtures and existing source/identity/citation tests remain part of the whole-tree gate. They are a regression proxy, not a known live-web reference corpus. Live pagination/access limits, conflict accuracy and source recall were not rebenchmarked. |
| Accessibility/compatibility | Existing Chromium/axe/reflow/keyboard journeys; no participant testing, dedicated screen-reader session, Safari/Firefox or Windows run. |
| Security | Executed request forgery, Host rejection, callback-state checks. No real DNS rebinding, hostile local process, multi-user deployment, penetration test or exhaustive dependency vulnerability audit. |
| Performance/burden | Measured check durations are host/load-specific. No new service/dependency/state migration. Provider throughput, large-corpus RAM and long-running concurrency load remain unmeasured. |

## Final verification

Verified after X08 against the current implementation:

| Command / probe | Result |
|---|---|
| `pnpm run check` | All static gates, 12 lint-policy probes, 298 test files / 3,625 unit tests pass; 66.40s after the clean-unit correction. Baseline was 3,593 tests / 65.73s; durations are host/load-specific, not a performance benchmark. |
| `pnpm run test:e2e` | All 142 Chromium journeys pass; 2.6 minutes. Both two-editor holdouts, real form refusal, reconnect guidance and existing accessibility/reflow journeys pass. |
| `docker compose build` | Both canonical app and relay images build. |
| Isolated `up -d --no-build --force-recreate`, HTTP and UI replay, `restart app` | Health body is `{"ok":true}`; built HTML/JS asset served; Task capture/edit succeeds; refused writes preserve exact record values; restart preserves id/title/notes/status/version. |
| Repeated search, hostile Origin/Host, same-site/cross-site metadata and encoded route probes | 400 / 403 / 409 responses name the refusal; accepted record is unchanged. Encoded-slash/case/doubled-slash controls serve SPA HTML, not API data. |
| `git diff --check` and targeted jgrep review | No whitespace errors; relevant boundary and versioned-save ranges inspected. Both searches exit 0; no errors treated as clean results. |

Production image: `sha256:62d8abd5186f0900f80725211094814ae7f71ab6c93246fb08290bbcd3e5e564`.
Actual current outputs and earlier failures are in [the evidence ledger](evidence.md), E09–E15.
Local raw logs and screenshot remain in `.scratch/teardown-2026-10-08/`.
The judgment disposition is above. Subsequent current-head GitHub CI and merge identity are
recorded on the pull request and final delivery; local green alone is not the remote merge gate.
