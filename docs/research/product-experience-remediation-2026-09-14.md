# Product experience remediation — 2026-09-14

This is the single remediation ledger for [the audit](product-experience-2026-09-14.md)
and the separately supplied screenshot refinements. Starting HEAD was clean `main` at
`6417005b6e29482c7aed90bf76945aa6818dfbc2`: PR #413 had merged the audit's first
implementation. The audit baseline `84dbd82e92fdcb599e21cf77ff41604f15944c73` is an
ancestor, not the starting implementation. Branch: `codex/product-experience-remediation`.
The three original screenshots were inspected before implementation.

This ledger preserves the original implementation campaign's authorization statements
as history. LIVE-01 now has a separately owner-authorized, exact-Qwen live campaign;
its current disposition and evidence are linked in the finding below.

## Authority, assumptions, and baseline

All app fixtures and Compose projects use new synthetic Workspaces. No model call,
private corpus evaluation, email, publication, live activation, prompt, or model change
is authorized by this campaign. No stored schema changed: pristine initialization uses
the existing canonical Task bundle and receipt. Thus no live stored-format migration
or business-Workspace backup was performed. Recovery guarantees remain process/container
recovery on an intact mount, not power-loss durability or multi-file transactions.

One verification mistake is recorded explicitly: a short `--network none` Node 22
literal-address probe initially mounted the checkout read-only, including its ignored
Workspace directory. It imported compiled HTTP modules and checked five literal URLs;
it did not start the app or read Workspace contents. That container exited. The probe
was rerun using a new temporary directory containing only compiled modules and their
two dependencies. All app/container journeys mount only their new synthetic Workspace.

Clean CI exposed a second verification-scope distinction: the repository's existing
`person-research-subject-attribution.test.ts` conditionally replays a retained public-source
article from ignored `artifacts/person-benchmark` when it exists. The local whole-suite
runs therefore included that replay; clean CI skipped it (3,088 passed / 1 skipped).
This was not a live provider call or private transcript evaluation, but it was not a
synthetic-only test run. Final follow-up verification uses a clean checkout without
ignored evidence artifacts; the existing optional test is not weakened or removed.

Read: AGENTS/CLAUDE (the latter links to AGENTS), CODING_STANDARDS, CONTEXT,
docs/agents guidance, relevant ADRs, manifests/lockfile, Dockerfile/Compose and CI.
Read-only GitHub lookup found PR #413 merged at starting HEAD and zero open issues.
Repository PR instructions preauthorize feature-branch push and PR/squash delivery
only behind current-head `check`, `test`, `e2e`, and `image` checks; activation is separate.

Baseline `pnpm run check`: **258 files / 3,027 tests passed**, plus typecheck, lint,
12 lint-policy probes, formatting, knip, and workflow validation. `pnpm run build`
passed. Baseline main JS: **869.28 kB minified / 240.98 kB gzip**. Baseline reader/
dossier browser subset: **7 passed**. No old totals are used as new verification.
Local Node: **26.8.1**; pnpm **12.3.4**. Docker build stage Node: **22.18.0**;
the pinned Playwright runtime actually contains **Node 24.20.0**.

## Finding ledger

### SEC-01 — browser egress

- Audit status: HTTP/bytes fixed; Chromium independent networking open.
- Current verification: previous HTTP regression suite preserved. The old browser
  launched Chromium directly. The production probe includes a positive control where
  unguarded Chromium reaches a dedicated synthetic fixture, then proves sandboxed
  Chromium cannot reach that same fixture even without Playwright routing.
- Acceptance: public rendering and redirects work; literals, actual connection DNS,
  subresources and alternative paths cannot bypass the public address policy; unavailable
  containment fails closed; useful diagnostics contain no supplied URL/credentials.
- Implementation: a small C launcher installs an inherited Linux seccomp filter before
  Chromium exec. It denies non-Unix sockets/socketpairs and io_uring setup, rejects
  other syscall architectures including x32, and requires no-new-privileges. Playwright
  communicates over pipes/Unix IPC. Supported anonymous HTTP resources are fulfilled
  through Node's guarded dispatcher. Browser absence or filter failure has no fallback.
  Workers cannot create direct IP sockets; service workers, WebSockets, downloads,
  extensions and QUIC are disabled. The local SearXNG dispatcher is never used here.
- Evidence: `browser-renderer.test.ts`, `browser-network.test.ts`, and the production
  `scripts/browser-safety-probe.mjs` cover allowed JS rendering, forbidden first URL,
  redirect and subresource, actual DNS returning the fixture's private address, literal
  IPv4/IPv6/mapped forms, direct bypass, cancellation, DOM expansion, and budgets.
- Compatibility scope: anonymous GET/HEAD/POST; non-GET document redirects are explicitly
  unsupported. GET document redirects use fresh intercepted navigation because Playwright
  does not intercept every HTTP redirect hop. Broker-followed subresource redirects do
  not reproduce the browser's native final `Response.url`; live coverage effects are
  unvalidated. This is not an OS privilege-escalation or renderer exploit assessment.
- Final disposition: fixed-and-verified for the documented production IP-egress scope.

### SEC-02 — IPv6 address handling

- Audit status: fixed.
- Acceptance: bracketed loopback/private and IPv4-mapped literals fail before fetch;
  DNS answers handed to actual sockets receive the same policy in supported runtimes.
- Implementation: no address-policy rewrite. Existing literal normalization and
  BlockList socket lookup remain authoritative.
- Evidence: `source-http-safety.test.ts`, `source-http-dispatcher.test.ts`, production
  browser probe; five literal regressions passed under Node **22.18.0** with networking
  disabled and code-only fixture mount. Container runtime checks cover Node **24.20.0**.
- Final disposition: already-fixed-and-reverified (runtime and integrated results below).

### REL-01 — pre-retention limits and browser resources

- Audit status: deferred, unmeasured hypothesis; old ceilings ran after collection.
- Reproduction: new text/byte stream tests observed **100** one-megabyte chunks produced
  where early termination expected **6**. Four tests failed before implementation.
- Acceptance: bounded incremental collection, producer cancellation, no successful
  truncated source, separate decoded-text/byte/browser budgets and measured cleanup.
- Implementation: `source-body.ts` admits chunks before copying and decodes text in
  16,384-byte windows. Text preserves **5,000,000 UTF-16 units** and adds a compatible
  **15,000,003 decompressed-byte** (including a UTF-8 BOM) ceiling. Bytes admit **5,000,000 decompressed bytes**.
  Content-Length is not trusted. On breach/error the reader cancels and releases its
  lock. The transport error code is `ERR_SOURCE_BODY_LIMIT`; adapter failure details
  retain a distinct collection-limit message and publish no successful partial source.
  No persisted outcome enum/schema is changed.
- Browser budgets: per-resource 5 MB, aggregate 20 MB, bounded request count/concurrency,
  one render at a time, one 15-second deadline including launch, DOM limit checked inside
  Chromium before transfer to Node, and a shared **2 GiB** production container ceiling
  with no additional swap and **512** PIDs. The hard ceiling includes Node and native
  Chromium memory; it is not a per-page RSS promise. An OOM can terminate the app and
  requires restart/recovery; concurrent legitimate heavy workloads need separate sizing.
- Evidence: `source-body-limits.test.ts` and `source-stream-cleanup.test.ts` cover exact
  limits, wrong Content-Length, oversized chunks, split UTF-8, compressed expansion,
  slow-body timeout, unlocked readers, and a successful later request. Existing redirect,
  dispatcher and HTTP safety tests remain green.
- Measurement: [raw fresh-process samples](product-experience-remediation-2026-09-14/body-memory.jsonl),
  three per arm, Node 26.8.1. A synthetic **100 MiB** stream was entirely consumed by
  the baseline; bounded collectors stopped after **5.05–5.11 MB** sent. Peak RSS delta:
  baseline **353.9–357.2 MB**, bounded text **19.5–19.8 MB**, bounded bytes **24.1–25.1 MB**.
  The baseline arm reproduces the prior exact full-buffer/check order, not a historical
  full-application benchmark. Samples include origin/runtime overhead; producer-owned
  oversized chunks and allocator retention remain outside the retained-output guarantee.
- Reproduce: build server, then run `node --expose-gc scripts/measure-source-retention.mjs
  before text` (and `before bytes`, `after text`, `after bytes`) in separate processes.
- Final disposition: fixed-and-verified, with the collection/container guarantees and limits above.

### REL-02 — revision and source lifecycle

- Audit status: un-reproduced remaining risk.
- Reproduction: new tests showed detachment scrubbed immutable historical dossier
  revisions. A pending reader also survived revision change and could request a previous
  Profile's source against a new Profile. External detachment during polling left it open.
- Acceptance: selected revision owns display; historical presence does not imply current
  attribution; detachment cannot rewrite retained historical evidence or be undone by
  in-flight research; reader responses cannot cross selections.
- Implementation: remove detach-only history scrubbing (privacy deletion keeps its own
  semantics); invalidate reader selection on Profile/revision changes and lost current
  attribution. Historical evidence remains readable as history; source API authorization
  still requires current attribution and reports unavailable when it no longer exists.
  Historical evidence already scrubbed by earlier corrections cannot be reconstructed by this fix.
- Evidence: `person-dossier.test.ts`, `person-dossier-api.test.ts`,
  `person-source-lifetime.test.tsx`, dossier refresh and browser lifecycle journeys.
  New failure tests were observed red before the owning changes.
- Final disposition: fixed-and-verified.

### UX-01 and UX-02 — contextual reader and keyboard sections

- Audit status: fixed; screenshot refinements additional.
- Acceptance: immediate dialog with loading/error/retry, associated passage/retained text,
  escaped content/safe links, inert background, containment/Escape/focus restoration,
  usable mobile/long text/200% zoom; tabs have one tab stop, wrapping Left/Right,
  Home/End, selected/control/panel labels and a reachable panel.
- Implementation: retain the native modal and automatic activation of already-loaded
  sections. Refine metadata hierarchy, source labels and scrollable section navigation.
  Long-content testing exposed a zoom geometry defect (dialog top **−328 px**); fixed
  containing-block sizing keeps close/correction controls inside the viewport.
- Evidence: existing evidence-recovery/dossier keyboard/axe journeys plus new
  `source-reader-layout.spec.ts` and pending-reader lifetime cases. Screenshots below
  demonstrate appearance only; browser assertions establish behavior.
- Final disposition: already-fixed-and-reverified, with screenshot refinements fixed-and-verified.

### REL-03 — People request ownership

- Audit status: fixed.
- Acceptance: reverse-order successes/obsolete failures do not replace current intent;
  first-load error offers retry; old-filter records are not selectable; no-match differs
  from failure.
- Implementation: preserve request generations and clearing old results; add missing
  obsolete-rejection coverage rather than introduce a new global cache.
- Evidence: `people-page.test.tsx` and `evidence-recovery.spec.ts`.
- Final disposition: already-fixed-and-reverified.

### REL-04 — Meeting reads and preparation

- Audit status: fixed.
- Acceptance: latest read owns publication; two Prepare calls before rerender admit one;
  polling single-flight; action busy/error survives unrelated read success; retain last-good
  projection, recover errors, and ignore obsolete unmounted responses.
- Implementation: no rewrite; existing request/action ownership is retained.
- Evidence: `meeting-index.test.tsx` and briefing/debriefing/reading browser journeys.
- Final disposition: already-fixed-and-reverified.

### REL-05 — revision-aware refresh and independent outcomes

- Audit status: fixed.
- Acceptance: actions/polls/detach refresh selected revision, clear mismatched content,
  avoid overlapping reads, preserve only three editable scheduling fields, retain edits
  made during save/action and independent Relationship history/action failures.
- Implementation: retain shared revision-aware refresh; REL-02 closes the additional
  reader/source-lifecycle cases. Guards protect display, not transport cancellation.
- Evidence: `person-dossier-refresh.test.tsx`, lifecycle/API tests, history retry journey.
- Final disposition: already-fixed-and-reverified plus REL-02 additions; final gates below.

### REL-06 — source-reader lifetime

- Audit status: fixed for close/selection, with new cross-Profile/revision gaps reproduced.
- Acceptance: closing, selection change, Profile/revision switch, external detachment and
  unmount invalidate late successes/errors; retry uses the intended failed selection.
- Implementation: reader selection now belongs to Profile, revision and attribution
  lifecycle as well as source/quote. Late responses cannot reopen obsolete readers.
- Evidence: four new initially failing lifetime cases, external-detach polling regression,
  source error/retry and delayed-close browser journeys.
- Final disposition: fixed-and-verified for the additional lifetime gaps; existing guards reverified.

### ONB-01 — positive pristine initialization

- Audit status: deferred, browser-confirmed.
- Reproduction: ConfigStore/bootstrap writes made an uninitialized empty Workspace appear
  legacy on later entry. Real production additionally creates `.writer.lock` before Node.
- Acceptance: positive pristine inventory, repeated/concurrent/interrupted startup,
  preserve unknown/partial/legacy data and artifacts, independent consent/setup gates.
- Implementation: before other startup writes, an absent/empty Workspace (allowing only
  the launcher's zero-byte regular `.writer.lock`) receives the existing canonical empty
  Task bundle atomically. It preserves the lock inode. Existing valid receipt is idempotent;
  every other entry stays on the normal migration/recovery path. Interrupted staging
  artifacts are retained and require explicit recovery, never silently cleaned/reset.
  Synchronous publication prevents same-process interleaving; the production launcher
  rejects a second writer with exit **73**. No multi-writer contract is added.
- Evidence: `pristine-startup.test.ts`, existing cutover/composition/backup tests, production
  Home/setup journey, same mount reboot and concurrent-writer refusal.
- Final disposition: fixed-and-verified.

### ONB-02 — prerequisites at admission and execution

- Audit status: deferred, browser-confirmed.
- Reproduction: Content Research's three recovery loops plus daily/weekly schedules
  admitted work without setup; automatic Person research had a separate admission path.
- Acceptance: no failed Runs for work not admitted, retained queue waits through lost
  prerequisites, setup completion resumes once, deliberate returning-user work remains.
- Implementation: current readiness is checked before creation/retry/recovery and again
  before queued execution. Blocked queued work stays pending. UI/API expose actionable
  waiting reasons. Backfill/discovery recover only their pending intake records.
- Prerequisites: migration gate inactive; purpose-specific model provider configured;
  key present for key-based providers; confirmed owner Profile. Discovery additionally
  needs Brand Voice. Existing active-watch/due-period and per-Profile pause settings remain.
  Ollama is supported as an explicitly selected local provider; key presence is not a
  provider-reachability guarantee. Mock is admitted only in explicit test/demo mode.
  Google adapter/output availability and Transcript consent keep their separate owners;
  public RSS is not disabled merely because Sheets is disconnected.
- Evidence: manual/scheduled/recovered and admission-to-execution disconnect matrix,
  concurrent due checks, setup completion, configured-key-only/owner/Brand Voice state,
  omitted-key patch versus blank-key removal, production fresh boot and reboot with no Runs.
- Final disposition: fixed-and-verified.

### PERF-01 — production loading

- Audit status: historical bundle advisory, no measured user-load regression.
- Reproduction: current production entry eagerly includes product pages and Home's
  optional motion-based prototypes. Current baseline bundle sizes recorded above.
- Acceptance: equivalent cold/warm production transfers, requested chunks, current-page
  heading timing and subsequent navigation; direct routes/reloads and failed chunk recovery.
- Implementation: React.lazy product pages, shared Suspense/error boundary with explicit
  reload recovery, and lazy optional Home prototypes. No eager preload of all products.
  Shared chunks remain bundler-managed; no new dependency or arbitrary chunk-size target.
- Evidence: [before raw browser measurements](product-experience-remediation-2026-09-14/loading-before.jsonl),
  `scripts/measure-page-loading.mjs`, `page-loading.spec.ts`, and after results below.
  Fresh browser contexts/cache clear are cold; subsequent reloads reuse cache. Measurements
  are local loopback, unthrottled, three samples, empty synthetic Workspace. Heading timing
  is not LCP/TTI or a WAN performance claim; API/model latency is not measured.
- Final disposition: fixed-and-verified for initial transfer reduction; navigation tradeoffs measured below.

### LIVE-01 — live evaluation disposition

Continuation implementation and separately frozen reruns are tracked in the
[LIVE-01 continuation report](live-01-continuation-2026-09-14.md). Original results
below remain historical evidence; they are not overwritten by recovered runs.

- Historical disposition before the new authorization: **explicitly unresolved — blocked
  by missing owner grant, corpus access, model selection and spending controls**.
- New authorization and live evidence: see [the model-specific LIVE-01 campaign](live-01-qwen-validation-2026-09-14.md). The owner authorized this work on September 14
  with every model-backed step restricted to exactly `qwen/qwen3.7-flash`, superseding
  this entry's earlier Solar/floor/cap prerequisites for the new campaign only.
  The historical preparation below remains a record of what had not run at that time.
- Current continuation disposition: **LIVE-01 remains open**. The browser compatibility
  fix passed the three selected source comparisons and containment checks. Extraction
  iterations C01–C09 preserve their own frozen evidence; C09 stopped on an Alibaba
  shared-pool HTTP 429, while prior complete outputs still failed source-based quality
  checks. Later duplicate-mapping diagnostics passed, but are not a complete corpus
  pass. Three owner judgments settle specific references, not the required full human
  review. See the continuation report for current checks, costs and dependencies.
- Initial campaign disposition: **campaign completed; acceptance failed**.
  Nine extraction slots have nine terminal outcomes. The final follow-up completed
  one of three extractions; zero of three passed the bounded Golden gate. There were
  70 completion requests / 78 HTTP attempts, all restricted to the exact model.
  Provider-reported cost was **$0.047474401**; the conservative cumulative ledger
  charge, including estimated failures, was **$0.102894001**. Three scoped harness/
  retry defects were fixed. The private review packet is ready; no human judgment
  is fabricated. Two extraction failures, the Golden/semantic findings and a TED
  browser compatibility loss prevent closure. The linked record holds full revision
  IDs, commands, route/prices, source restrictions, limits and verification evidence.
- Preparation: inspected current CLI `--help`, corpus hashing and grant validation. The
  CLI reads corpus before grant validation, so even planning must use an authorized corpus.
  A new entirely synthetic one-case corpus was passed explicitly with `--provider mock
  --models synthetic/mock --plan-only`; it froze one slot, zero budget, revision prefix
  `8373d19b951e`, with no external calls. [Exact command/output](product-experience-remediation-2026-09-14/live-plan-synthetic.json).
  The existing synthetic campaign suite passed **40 tests**, including terminal outcomes,
  recovery boundaries, grant requirements and budget controls. This does not close LIVE-01.
- Historical next action (superseded by the new campaign authorization): owner supplies a corpus snapshot and permission to read it, an unrevoked
  source-lifecycle grant with explicit route policy, one model, credentials, balance floor
  and price cap. Repository guidance records **10.10 USD** floor and **0.10/0.20 USD per
  million input/output tokens** cap; they are not inferred authorization for this campaign.
  Reconfirm their applicability in the grant before dispatch. `upstage/solar-pro4` remains
  the prompt-gate model; do not substitute it under a cheaper model's price cap.
- Exact planned live command (unexecuted; owner supplies the variables):

  ```sh
  pnpm exec tsx scripts/run-validation-campaign.mts \
    --campaign-id "$CAMPAIGN_ID" --protocol baseline \
    --provider openrouter --models "$AUTHORIZED_MODEL" \
    --corpus "$AUTHORIZED_CORPUS" --grant "$OWNER_GRANT" \
    --out "$PRIVATE_OUTPUT" --allow-live \
    --balance-floor "$OWNER_BALANCE_FLOOR" --price-cap "$OWNER_PRICE_CAP"
  ```

  Freeze full source/corpus revision, grant identity, model/route/schema and prices before
  dispatch. Keep manifest, outcomes, budget/timeline, terminal slot artifacts, report and
  blind judgments under PRIVATE_OUTPUT. Every planned slot must end once, including
  failures/missing slots; deterministic Golden checks and owner blind semantic review
  remain distinct. Agree semantic thresholds for the selected corpus before running.
  No source-coverage, real identity, extraction quality, recurring Calendar or universal
  timezone/DST claim follows from mocks. Retrieval-limit/browser changes need authorized
  live coverage comparison; that effect remains unvalidated.

## Separately labeled screenshot refinements

1. **Hierarchy and metadata:** source identity/title, reason/passage, readable UTC dates,
   exact timestamps in provenance details; publication/retrieval/research dates stay distinct.
   Technical retrieval/extraction fields are grouped, never treated as claim verification.
2. **Citation clarity and navigation:** source title/domain with honest fallback; preserve
   both passage preview and highlighted retained text; many sections use deliberate
   horizontal scrolling while retaining the keyboard contract.
3. **Mobile/long content:** wider quotations, wrapping URLs/unbroken text, scrollable modal,
   bounded geometry at 200% zoom, reachable close/retry/correction, no background scrolling;
   highlighted passages have an underline as well as color.
4. **Correction versus reading:** separate disclosure explains current attribution removal
   and retained history; pending/error/success and lost-invoker focus have explicit behavior.

Comparable synthetic screenshots and the final validation record follow below.

## Research and dependency decisions

No new npm dependency or third-party source copied. Existing React 19.2.8 / Vite 8.2.2
and Playwright 1.63.0 are taken from lockfile, not current dist-tags. Followed official
[React lazy](https://react.dev/reference/react/lazy),
[error boundaries](https://react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary),
and [Vite async loading](https://vite.dev/guide/features.html#async-chunk-loading-optimization):
lazy is declared at module scope, failures are cached and require explicit reload recovery,
and shared async dependencies are left to Vite. The existing MIT React/Vite obligations
are unchanged. Broad library discovery was not repeated: the audit's Ariakit/Query/
React-admin research did not justify replacing working native-dialog/request guards.

The C sandbox is original code compiled in the existing compiler stage; no third-party
source was copied. Design references are the official [Linux seccomp filter documentation](https://www.kernel.org/doc/html/latest/userspace-api/seccomp_filter.html),
[seccomp inheritance](https://man7.org/linux/man-pages/man2/seccomp.2.html),
[Playwright routing](https://playwright.dev/docs/api/class-page#page-route),
[Playwright network interception](https://playwright.dev/docs/network), and
[Docker memory controls](https://docs.docker.com/engine/containers/resource_constraints/).
The application-specific tradeoff is explicit: ordinary browser IP networking is denied
at the kernel boundary and supported anonymous traffic uses the existing guarded HTTP
transport. Unix IPC remains enabled; this does not claim exploit containment. WebRTC,
WebTransport, speculative/background requests, Chromium DNS and missed worker/popup
interception cannot create IP sockets. Existing Playwright/Undici dependencies and licenses
remain unchanged; no new dependency, lockfile change, or copied example was needed.

## Integrated verification and delivery

The first integrated implementation was commit **`db4aadb20b1529825bbc876fdc5ea432d7fa22d2`**.
The review follow-up below identifies the final tested implementation.
Its subsequent evidence commit changed documentation/artifacts only. The
[machine-readable verification record](product-experience-remediation-2026-09-14/integrated-verification.json)
contains SHA-256 hashes for every implementation/test/script/configuration file, exact
image identity, production route results, onboarding state and timing summaries.
Pre-commit formatting/lint passed without changing the tested source bytes.

- First integrated `pnpm run check:all`: **264 unit files / 3,089 tests and 121 browser tests passed**;
  typecheck, lint (including 12 policy probes), formatting, knip, workflow checks and
  production web/server build passed. Browser journeys include briefing, debriefing,
  People filtering/lifecycle, dossier research/revisions, source correction/read/retry,
  Relationship history, onboarding, shared navigation and accessibility.
- `docker compose -f /tmp/found42-remediation-final-compose.json build` built app and relay
  from this checkout. `up -d --no-build` used isolated ports **44527/44528**, network
  `found42-remediation-final_default`, and a verified new synthetic mount. The committed
  [Compose evidence](product-experience-2026-09-14/remediation/onboarding-production-compose.json)
  records the configuration with `<repo>` and `<synthetic-workspace>` replacing run-specific
  absolute host paths; substitute a new verified-empty Workspace when reproducing.
  Image-only boot/recreation returned `GET /api/health` **`{"ok":true}`**.
- First integrated production image:
  **`sha256:1a0640d93006a326b2f01bb6edf141354ae130cd3d9f7f7082d5901ba799383b`**.
  `docker run --rm --network none --mount type=bind,src=<repo>/scripts,dst=/app/scripts,readonly
  found42-remediation-final-app node scripts/run-canaries.mjs --check` composed all
  **9 production adapters without external calls**.
- The [production browser proof](product-experience-remediation-2026-09-14/browser-production.json)
  now records the review-follow-up image below, with no compiled-code overlay: **14 probe groups
  passed**, forbidden destination requests **0**, unguarded positive control **1**.
  Container peak **654,782,464 bytes** under **2,147,483,648 bytes**; post-run Node RSS
  **141,770,752 bytes**. Eight in-flight resource collectors can temporarily exceed the
  20 MB accepted-resource aggregate before rejection; each retains at most 5 MB, and the
  independent container ceiling still applies. Memory sizing covers this synthetic workload.
- [Onboarding production results](product-experience-2026-09-14/remediation/onboarding-production-result.json)
  preserve original fresh boot, reboot, second-writer refusal (**73**) and later image
  rechecks. Final image: migration completed, onboarding still incomplete, **0 research Runs**,
  actionable waiting, Run Now refused before creating a Run, Settings reachable,
  **0 page errors / 0 axe violations** (42 checks passed). No processing consent is inferred.
- Real Chromium against the final Docker origin additionally proved chunk-load failure,
  usable navigation to another product after failure, successful refetch/reload, and
  direct load/reload of Meetings, People and Meeting Brief. The regular browser suite
  separately asserts the explicit Reload page button.

Earlier integrated failures were investigated rather than waived: overlapping temporary
Playwright output caused artifact collisions; lazy boundaries initially remounted healthy
routes and lost disclosure state; immediate optional `count()` checks raced deferred page
loads; and a loading state lacked an h1. The owning code/test waits were corrected,
followed by the exclusive final passing full run above. No test/golden/coverage threshold,
lint rule or security control was weakened. The full integrated source and evidence diff
was reviewed; the repository's four current-head CI checks gate PR squash delivery.

### CodeRabbit and CI follow-up — final implementation

[PR #414](https://github.com/nicolas-found42/chief-of-staff-demo/pull/414) received an explicitly
requested full CodeRabbit review of `bcc7d14eb332978a13a948faa8a70d0813c71c41`.
[The review](https://github.com/nicolas-found42/chief-of-staff-demo/pull/414#pullrequestreview-5201291748)
posted eight inline comments and one additional HTTP comment. Each has a response;
this is the final disposition, not an assertion that the bot re-reviewed the follow-up:

| Review item | Disposition and verification |
| --- | --- |
| Excess resource requests waited before rejection | Fixed: request 101 aborts before queueing; regression held all eight active slots and failed before the change. |
| Redirected assets allegedly consume document budget | No change: 21 redirected scripts execute successfully. The broker follows ordinary asset redirects internally. The intentional global 20 document/frame budget remains. |
| Query-only navigation cannot clear loading error | Fixed: location key resets failed state without remounting healthy routes; real browser failure → remove variant query → healthy Home regression passes. |
| Brand Voice link opens Content Scout | Fixed label to Open Content Scout; destination and prerequisite explanation remain accurate. |
| Impossible date-only values normalize | Fixed UTC date roundtrip validation; three invalid and two valid cases pass, preserving malformed values verbatim. |
| Correction notice leaks across context | Fixed context clearing and existing generation guard on late correction refresh; three previously failing Profile/revision/later-completion cases pass. |
| WS/SW probe records unasserted success | Fixed explicit control outcomes. WS must close cleanly with policy code 1008; SW yields no registration, empty registry and no worker-script fetch. Removing either guard in a temporary compiled test copy makes its assertion fail. |
| Measurement accepts any error as a limit | Fixed expected-error classification. Injected connection failure exits 1 and emits no successful measurement record; all 12 fresh-process samples rerun. |
| Additional HTTP custom credential forwarding | Fixed explicit cross-origin allowlist: accept, accept-language, user-agent, content-type, content-length. Same-origin headers stay intact; origin changes drop every other header and return hops do not restore them. 301/302/303 versus 307/308 body/header semantics covered; safety/dispatcher/Marginalia 37 tests pass. |

Cross-origin forwarding deliberately drops even Marginalia's literal public API key and
DuckDuckGo referer/sec-fetch-mode; initial/same-origin requests remain unchanged. No current
caller requires their cross-origin forwarding. Live provider redirect compatibility remains
unvalidated. Auxiliary scan claims were inspected: the alleged API key is a test-source
SHA-256 checksum, and the alleged prototype-pollution loop iterates fixed literal keys.
Neither establishes a vulnerability. Host paths were redacted from public evidence;
Compose already supplies the supported deployment's health checks.

CI run **34878449764** on the initial PR head passed static checks, unit coverage and image,
but its browser shard caught loss of History reading position. The trace showed position
3440 followed by shorter Meeting content, then Back at zero. Chunk delay alone did not
reproduce locally. Deterministic React tests proved passive scroll listeners could record
the next layout's clamped zero before cleanup. `useLayoutEffect` cleanup fixes replacement
and actual Suspense hiding; the browser test additionally delays the real route chunk
while retaining the original filter/viewport/less-than-60px position assertions.

Final source commit: **`3734e76dbd797f9e5e414ecf702a48793acbbd69`**. After the follow-up,
`pnpm install --frozen-lockfile` and **`pnpm run check:all`** ran in a clean detached checkout
with no ignored Workspace/corpus/evidence artifacts: **266 unit files, 3,105 tests passed,
1 existing optional retained-article test skipped, and all 122 browser tests passed**.
All static gates and production build passed. No tests, coverage floors or security
controls were weakened. The clean checkout uses the exact committed implementation.

Final packaged image: **`sha256:d5d1dba72183424d12a5d68a3c6d479cb181a81efb504e13b7c35ba85ac0b63e`**.
Disposable Compose build/boot and health passed; all nine production adapters composed
with networking disabled. The 14-group browser proof used the packaged server/launcher
without a compiled overlay. Production onboarding and direct-route/reload/error-recovery
journeys passed again. Existing fresh-boot/restart/writer exclusion evidence is retained;
the review changes do not alter pristine initialization. Updated waiting/refusal screenshots
show the corrected Content Scout link label.

[Strict-error memory samples](product-experience-remediation-2026-09-14/body-memory-verified.jsonl)
retain the original measurements separately. All before samples consumed 104,857,600 bytes;
bounded text stopped at 5,046,272 bytes and bytes at 5,111,808. Peak RSS delta ranges were
**351.9–360.2 MB before**, **19.8–23.8 MB bounded text**, **24.6–25.4 MB bounded bytes**.
This confirms the same retention benefit under explicit expected-limit classification.
The fault check preloaded an Undici MockAgent with network disabled; its unmatched
connection error propagated, the CLI exited 1, and the synthetic server cleaned up.

[Final follow-up verification metadata](product-experience-remediation-2026-09-14/review-verification.json)
records source hashes, image, clean-checkout totals, production journeys and final loading
samples. Repository delivery remains squash merge only after current-head `check`, `test`,
`e2e` and `image` pass; the PR's check history records those immutable runs. LIVE-01 was still blocked at that verification point, independently of CodeRabbit/CI
results. Its subsequently authorized live campaign is recorded in the finding above.

### Production loading comparison

The final [before](product-experience-remediation-2026-09-14/loading-review-before.jsonl) and
[after](product-experience-remediation-2026-09-14/loading-review-after.jsonl) samples use production
images from the current baseline and review-follow-up implementation,
the same host/browser, empty synthetic Workspaces, unthrottled loopback, and three
samples per phase. Both were rerun serially after build/test workloads ended. Cold
contexts clear browser cache; warm phases reuse it. Raw records include every requested
JS chunk and encoded/decoded/transfer sizes. These production responses are uncompressed;
`transferSize` includes HTTP overhead and warm cache validation (300 bytes per asset).

| Journey | Before JS bytes / chunks | After JS bytes / chunks | Median heading ms before → after |
| --- | ---: | ---: | ---: |
| Cold Home | 869,584 / 1 | 373,327 / 4 | 74 → 55 |
| Warm Home reload | 300 / 1 | 1,200 / 4 | 47 → 42 |
| Home → Meetings | 0 / 0 | 18,110 / 6 | 44 → 107 |
| Meetings → People | 0 / 0 | 12,447 / 2 | 58 → 52 |
| Warm People reload | 300 / 1 | 1,800 / 6 | 26 → 809 |
| Brief deep link after navigation | 300 / 1 | 15,078 / 8 | 47 → 828 |
| Return Home | 300 / 1 | 1,200 / 4 | 40 → 43 |
| Cold direct Meetings | 869,584 / 1 | 391,437 / 10 | 69 → 80 |
| Cold direct People | 869,584 / 1 | 385,774 / 6 | 74 → 80 |
| Cold direct Brief | 869,584 / 1 | 391,257 / 8 | 74 → 79 |

Keep the split: **57.1% less cold Home JavaScript transferred**, and each representative
cold product route also needs under 392 kB rather than 870 kB. Home requests shared
chunks but does not request the Tasks/Profile-detail/optional-prototype code. The entry
is **322.85 kB / 93.67 kB gzip**; entry size alone is not the benefit claim. Final shared
async chunks are Vite-managed, with no duplicated heavy dependency introduced. Optional
Home variants live in a separate 14.32 kB chunk and their motion dependency is deferred.

The cost is additional requests/cache validation and measured first-navigation delay
(**+63 ms Meetings, -6 ms People** in this local sample). No general latency, LCP/TTI,
WAN or model/API speedup is claimed. Three unthrottled samples are descriptive, not a
statistically powered performance result.

The follow-up run's warm People/Brief waits (**809/828 ms** medians) differ materially
from the earlier **28/44 ms** samples. They were investigated, not discarded. Nine
read-only diagnostic sequences failed to reproduce the large delay. The
[exact-flow repeat with a DOM observer](product-experience-remediation-2026-09-14/loading-review-observed.jsonl)
(including the same CDP cache clearing) measured warm People **26–27 ms** wait /
**22.2–23.8 ms** visible heading, and Brief **44–47 ms** wait / **39.3–42.4 ms** visible
heading. The transient's cause is not established; neither a product latency regression
nor an instrumentation cause is proven. All initial/raw repeat samples are retained.
No speculative product change was made to chase the outlier. Transfer reduction remains
the supported reason for retaining route splitting, with extra request/warm-validation
costs explicitly reported.

Reproduce with `node scripts/measure-page-loading.mjs
http://127.0.0.1:<isolated-production-port>` against separately built baseline/final images;
do not point the measurement at business data.

### Comparable visual evidence

All examples are richer synthetic evidence, not assertions about a real person's sources.
Before images use the baseline web bundle with the same fixture; desktop is **1280×720**,
mobile **390×844**. The final real-browser 200% zoom capture uses **1280×600** to avoid
headless screenshot clipping and is a stricter vertical constraint, not the mobile comparison.
The CSS zoom capture is separately labeled and does not substitute for browser zoom.

- Desktop: [before](product-experience-2026-09-14/remediation/before-reader-desktop.png),
  [after](product-experience-2026-09-14/remediation/reader-desktop.png).
- Mobile: [before](product-experience-2026-09-14/remediation/before-reader-mobile.png),
  [after](product-experience-2026-09-14/remediation/reader-mobile.png).
- [Long content](product-experience-2026-09-14/remediation/reader-long-content.png),
  [pending correction](product-experience-2026-09-14/remediation/reader-correction-pending.png),
  [correction error/retry](product-experience-2026-09-14/remediation/reader-correction-error.png),
  [actual 200% browser zoom](product-experience-2026-09-14/remediation/reader-browser-zoom.png),
  [CSS zoom comparison](product-experience-2026-09-14/remediation/reader-zoom.png).
- Production onboarding: [Home](product-experience-2026-09-14/remediation/onboarding-production-home.png),
  [waiting](product-experience-2026-09-14/remediation/onboarding-production-waiting.png),
  [setup-required refusal](product-experience-2026-09-14/remediation/onboarding-production-refusal.png).

All **13 independently verifiable findings are closed** with the per-finding dispositions
above. **LIVE-01 was explicitly unresolved at the end of the original remediation**. The later
model-specific campaign replaces its authorization blocker with measured live outcomes
and a precise remaining disposition in the linked record. Its bounded retrieval evidence
does not imply universal coverage or Calendar/timezone validation.
Disposable baseline/final Compose app/relay containers and networks were brought down after
verification. Branch/PR delivery does not activate or deploy the app against the business Workspace.
