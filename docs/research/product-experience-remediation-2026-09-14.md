# Product experience remediation — 2026-09-14

This is the single remediation ledger for [the audit](product-experience-2026-09-14.md)
and the separately supplied screenshot refinements. Starting HEAD was clean `main` at
`6417005b6e29482c7aed90bf76945aa6818dfbc2`: PR #413 had merged the audit's first
implementation. The audit baseline `84dbd82e92fdcb599e21cf77ff41604f15944c73` is an
ancestor, not the starting implementation. Branch: `codex/product-experience-remediation`.
The three original screenshots were inspected before implementation.

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

### LIVE-01 — authorization boundary

- Audit status and final disposition: **explicitly unresolved — blocked by missing owner
  grant, authorized corpus/revision access, selected provider/model and spending controls**.
- Preparation: inspected current CLI `--help`, corpus hashing and grant validation. The
  CLI reads corpus before grant validation, so even planning must use an authorized corpus.
  A new entirely synthetic one-case corpus was passed explicitly with `--provider mock
  --models synthetic/mock --plan-only`; it froze one slot, zero budget, revision prefix
  `8373d19b951e`, with no external calls. [Exact command/output](product-experience-remediation-2026-09-14/live-plan-synthetic.json).
  The existing synthetic campaign suite passed **40 tests**, including terminal outcomes,
  recovery boundaries, grant requirements and budget controls. This does not close LIVE-01.
- Next action: owner supplies a corpus snapshot and permission to read it, an unrevoked
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

The tested implementation is commit **`db4aadb20b1529825bbc876fdc5ea432d7fa22d2`**.
The subsequent evidence commit changes documentation/artifacts only. The
[machine-readable verification record](product-experience-remediation-2026-09-14/integrated-verification.json)
contains SHA-256 hashes for every implementation/test/script/configuration file, exact
image identity, production route results, onboarding state and timing summaries.
Pre-commit formatting/lint passed without changing the tested source bytes.

- Final `pnpm run check:all`: **264 unit files / 3,089 tests and 121 browser tests passed**;
  typecheck, lint (including 12 policy probes), formatting, knip, workflow checks and
  production web/server build passed. Browser journeys include briefing, debriefing,
  People filtering/lifecycle, dossier research/revisions, source correction/read/retry,
  Relationship history, onboarding, shared navigation and accessibility.
- `docker compose -f /tmp/found42-remediation-final-compose.json build` built app and relay
  from this checkout. `up -d --no-build` used isolated ports **44527/44528**, network
  `found42-remediation-final_default`, and a verified new synthetic mount. The committed
  [Compose evidence](product-experience-2026-09-14/remediation/onboarding-production-compose.json)
  records the exact configuration; temporary paths are run-specific, not reusable defaults.
  Image-only boot/recreation returned `GET /api/health` **`{"ok":true}`**.
- Final production image:
  **`sha256:1a0640d93006a326b2f01bb6edf141354ae130cd3d9f7f7082d5901ba799383b`**.
  `docker run --rm --network none --mount type=bind,src=<repo>/scripts,dst=/app/scripts,readonly
  found42-remediation-final-app node scripts/run-canaries.mjs --check` composed all
  **9 production adapters without external calls**.
- The [production browser proof](product-experience-remediation-2026-09-14/browser-production.json)
  directly retested this final image, with no compiled-code overlay: **13 probe groups
  passed**, forbidden destination requests **0**, unguarded positive control **1**.
  Container peak **630,218,752 bytes** under **2,147,483,648 bytes**; post-run Node RSS
  **141,127,680 bytes**. Eight in-flight resource collectors can temporarily exceed the
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

### Production loading comparison

Both arms used production images from the current baseline and final implementation,
the same host/browser, empty synthetic Workspaces, unthrottled loopback, and three
samples per phase. Both were rerun serially after build/test workloads ended. Cold
contexts clear browser cache; warm phases reuse it. Raw records include every requested
JS chunk and encoded/decoded/transfer sizes. These production responses are uncompressed;
`transferSize` includes HTTP overhead and warm cache validation (300 bytes per asset).

| Journey | Before JS bytes / chunks | After JS bytes / chunks | Median heading ms before → after |
| --- | ---: | ---: | ---: |
| Cold Home | 869,584 / 1 | 373,321 / 4 | 65 → 62 |
| Warm Home reload | 300 / 1 | 1,200 / 4 | 43 → 46 |
| Home → Meetings | 0 / 0 | 18,104 / 6 | 54 → 87 |
| Meetings → People | 0 / 0 | 12,447 / 2 | 56 → 81 |
| Warm People reload | 300 / 1 | 1,800 / 6 | 23 → 28 |
| Brief deep link after navigation | 300 / 1 | 15,078 / 8 | 44 → 44 |
| Return Home | 300 / 1 | 1,200 / 4 | 41 → 42 |
| Cold direct Meetings | 869,584 / 1 | 391,425 / 10 | 70 → 85 |
| Cold direct People | 869,584 / 1 | 385,768 / 6 | 76 → 79 |
| Cold direct Brief | 869,584 / 1 | 391,251 / 8 | 67 → 70 |

Keep the split: **57.1% less cold Home JavaScript transferred**, and each representative
cold product route also needs under 392 kB rather than 870 kB. Home requests shared
chunks but does not request the Tasks/Profile-detail/optional-prototype code. The entry
is **322.84 kB / 93.66 kB gzip**; entry size alone is not the benefit claim. Final shared
async chunks are Vite-managed, with no duplicated heavy dependency introduced. Optional
Home variants live in a separate 14.32 kB chunk and their motion dependency is deferred.

The cost is additional requests/cache validation and measured first-navigation delay
(**+33 ms Meetings, +25 ms People** in this local sample). No general latency, LCP/TTI,
WAN or model/API speedup is claimed. Three unthrottled samples are descriptive, not a
statistically powered performance result. Reproduce with `node scripts/measure-page-loading.mjs
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
above. **LIVE-01 remains explicitly unresolved** with its owner authorization/access/model/
budget prerequisites and exact next command. Browser retrieval compatibility and live
coverage, identity/extraction quality and full Calendar/timezone behavior remain unvalidated.
Disposable baseline/final Compose app/relay containers and networks were brought down after
verification. Branch/PR delivery does not activate or deploy the app against the business Workspace.
