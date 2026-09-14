# Product experience audit — 2026-09-14

## Research and implementation decisions

Research inspected the application at `84dbd82e92fdcb599e21cf77ff41604f15944c73`.
Read-only GitHub API/source inspection and current official web documentation were used;
no external application was installed or given Workspace data. Candidate versions below
are package versions at the inspected repository commit, not claims about npm dist-tags.

The scope preserves ADR-0001's local, single-user deployment; ADR-0042/0062's
Workspace-owned Person Profiles and qualified research; ADR-0050/0077's durable Meeting
and separate prospective/retrospective workflows; and ADR-0078/0085's separation of
reading, accepted work, incomplete review, and outward publication. This research changes
no model, extraction, research coverage, stored format, or approval policy.

### Discovery path

[Awesome React](https://github.com/enaqx/awesome-react) directly links Ariakit under
component libraries, TanStack Query under state/data fetching, and React-admin under
frameworks. Those links were followed into actual source, package manifests, licenses,
and official documentation. [Awesome Selfhosted](https://github.com/awesome-selfhosted/awesome-selfhosted)
was also inspected as a product-discovery index; no hosted application was selected as
a backend replacement. The app's existing architecture supports the selected work.

### Ariakit: evidence inspection and keyboard sections

**Application problem.** `apps/web/src/pages/PersonDossierPanel.tsx` appends the retained
source below all section content. A citation near the top can produce a change outside
the viewport. Its tablist has ten tab stops and no arrow/Home/End behavior. These are
source-confirmed design/accessibility findings; interaction reproduction and final
verification belong to the implementation evidence below.

**Source inspected.** Ariakit commit
`36b3ce477964d95d6f30f0158b1361db43420009`:

- [examples/dialog/index.react.tsx](https://github.com/ariakit/ariakit/blob/36b3ce477964d95d6f30f0158b1361db43420009/examples/dialog/index.react.tsx)
  keeps controlled open state, a named heading, and explicit dismiss action together.
- [examples/tab/index.react.tsx](https://github.com/ariakit/ariakit/blob/36b3ce477964d95d6f30f0158b1361db43420009/examples/tab/index.react.tsx)
  connects selection, tab list, and panels through a provider.
- [packages/ariakit-react-components/src/dialog/dialog.tsx](https://github.com/ariakit/ariakit/blob/36b3ce477964d95d6f30f0158b1361db43420009/packages/ariakit-react-components/src/dialog/dialog.tsx)
  handles disclosure focus restoration and imports inert-tree, nested-dialog, portal,
  and scroll-prevention helpers. Those concerns explain why a bespoke overlay is costly.

**Current API check.** Official [Dialog](https://ariakit.com/components/dialog) documentation
uses `open`, `onClose`, `DialogHeading`, and `DialogDismiss`; its modal implementation
reserves scrollbar space. Official [Tab](https://ariakit.com/components/tab) documentation
describes the corresponding tab components. The [package manifest](https://github.com/ariakit/ariakit/blob/36b3ce477964d95d6f30f0158b1361db43420009/packages/ariakit-react-components/package.json)
declares version 0.6.0, React 17/18/19 peers and client-side dependencies, including
Floating UI. Repository activity was observed on the research date; that is a maintenance
signal, not an accessibility or security certification.

**Decision: adapt the interaction; use native browser behavior for this slice.** A
retained-source inspector should open where the user is reading, preserve the selected
claim and quote, expose loading/failure/retry, and return to the invoking citation.
The [HTML Standard's dialog contract](https://html.spec.whatwg.org/multipage/interactive-elements.html#the-dialog-element)
already supplies modal top-layer behavior, background inertness, closing, and focus
steps through `showModal()`/`close()`. This makes a native dialog a credible alternative
for one bounded inspector. Ariakit becomes preferable if nested overlays, combined
comboboxes, or broadly shared composite widgets emerge. Do not reimplement its entire
focus-management stack for this small interaction.

For the existing tabs, independently implement the
[WAI-ARIA APG Tabs pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/): one selected
tab stop, arrow-key wrapping, Home/End, matching selected/controls/labelledby attributes,
and a reachable panel. Automatic activation fits already-loaded sections; introducing
remote loading on tab focus would require reassessing that choice.

**License, cost, and validation.** Ariakit's [package license](https://github.com/ariakit/ariakit/blob/36b3ce477964d95d6f30f0158b1361db43420009/packages/ariakit-react/license)
is MIT; its [examples license](https://github.com/ariakit/ariakit/blob/36b3ce477964d95d6f30f0158b1361db43420009/app/src/examples/license.md)
also names exceptions for Plus examples. No implementation code is copied, so no new
third-party notice or runtime dependency is required. Native APIs add no hosted service,
telemetry, or external data transmission. Verify keyboard opening, Escape, Tab containment,
focus return, long text at mobile width, loading failure/retry, and closing before a
source request finishes. Keep source text escaped and permit only safe outbound URL schemes.

### TanStack Query: latest intent, honest loading, and recovery

**Application problem.** Dossier `inspect()` previously accepted any response that resolved,
so an older request could overwrite the source selected more recently. Its four-second
polling effect could overlap requests. People search is another candidate for the same
latest-intent invariant. These are UI request-ownership questions, separate from the
Shell's durable Run state machine and the server's acceptance/idempotency contracts.

**Source inspected.** TanStack Query commit
`2bc8ecf39bef623ed0680a11898b6e757d7de78b`:

- [examples/react/auto-refetching/src/pages/index.tsx](https://github.com/TanStack/query/blob/2bc8ecf39bef623ed0680a11898b6e757d7de78b/examples/react/auto-refetching/src/pages/index.tsx)
  distinguishes pending/error/data from background `isFetching`, and invalidates a named
  query after successful mutations.
- [packages/query-core/src/query.ts](https://github.com/TanStack/query/blob/2bc8ecf39bef623ed0680a11898b6e757d7de78b/packages/query-core/src/query.ts)
  reuses an in-flight promise or cancels a superseded refetch, and creates an AbortController
  whose signal reaches the query function.

**Current API check.** Official [cancellation documentation](https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation)
requires the transport to consume its supplied signal for actual cancellation. A library
does not retroactively cancel arbitrary existing client methods. Official
[defaults documentation](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults)
also documents focus/reconnect refetch, stale cached data, and three retries by default;
unexamined defaults would alter this app's request behavior.

**Decision: adapt now; defer dependency migration.** Give each foreground request an
identity, invalidate it when intent changes or the component closes, and accept only
the current response. Present waiting, failure, empty results, and retry distinctly.
Where polling is touched, allow one refresh at a time. This solves the selected end-to-end
interactions without a new global query cache. TanStack Query is the stronger future
option if a separately scoped migration covers shared polling and cache invalidation;
the alternative of indefinitely adding bespoke caches would be harder to maintain.

The [manifest](https://github.com/TanStack/query/blob/2bc8ecf39bef623ed0680a11898b6e757d7de78b/packages/react-query/package.json)
declares version 5.102.8, MIT, and React 18/19 compatibility. Activity was observed on the
research date. The inspected query/example path needs no hosted service; a future adoption
must still review packaging and defaults. No package or source code is adopted now.
Regression tests should resolve old/new requests in reverse order, reject the old request
after a newer success, close/unmount while pending, and retry the same failed selection.
Do not claim transport savings from an identity guard: it prevents stale display but
does not abort network work.

### React-admin: contextual evidence and explicit offline states

**Application opportunity.** Both dossier reading and Debrief review benefit when context
stays beside the record and failures have a dedicated rendering path. Existing Meeting
Debrief `ReadingDisclosure` already keeps inline decision evidence near the statement;
that pattern should survive any shared redesign.

**Source inspected.** React-admin commit
`d680a5e3bc1d4770a22c05680831b339a74e94ad`,
[packages/ra-ui-materialui/src/detail/ShowView.tsx](https://github.com/marmelab/react-admin/blob/d680a5e3bc1d4770a22c05680831b339a74e94ad/packages/ra-ui-materialui/src/detail/ShowView.tsx),
renders an `aside` next to record content and separately chooses offline, error, and
normal content. Official [Show documentation](https://marmelab.com/react-admin/Show.html)
confirms these supported customization points.

**Decision: adapt the record/context separation; reject framework adoption for this batch.**
The inspector is a focused way to maintain context on a long dossier, while inline
Debrief evidence remains appropriate for short quotations. A full React-admin migration
would introduce data-provider/resource abstractions over already established domain clients
and substantial styling dependencies. Its [5.15.3 manifest](https://github.com/marmelab/react-admin/blob/d680a5e3bc1d4770a22c05680831b339a74e94ad/packages/react-admin/package.json)
supports React 18/19 and React Router 7, but also requires Material UI, Emotion, Query,
and form packages. Compatibility alone is insufficient benefit. The
[license](https://github.com/marmelab/react-admin/blob/d680a5e3bc1d4770a22c05680831b339a74e94ad/LICENSE.md)
is MIT; no code is copied and no package is installed. Current repository activity and
documentation are positive maintenance signals. The chosen independent interaction has
no new account, server, mandatory hosted service, or operating cost. Browser verification
must demonstrate context preservation and reachable failure/recovery actions.

## Audit coverage and operating constraints

This is a bounded source audit at the baseline SHA above, with the UI observations
and implemented fixes recorded separately. It is not an exhaustive security assessment
or a live model-quality evaluation. No business data, live credentials, paid evaluation,
external writes, or production Workspace was used for this additional inspection.

### Principal journeys and ownership

| Journey | UI and API | Execution and evidence | Persistence and recovery |
| --- | --- | --- | --- |
| Meeting Brief | `MeetingPage.tsx`, `modules/meeting-brief/ResultView.tsx`; `api/meetings.ts`, Meeting Brief host routes | `meeting-brief-generator/intake.ts` receives Calendar occurrences; `module.ts` runs snapshot → enrich → compose → deliver; `generator.ts`/`enrichment/enrich.ts` collect provider context; `compose.ts` binds a checked structured result through `CompleteJson` | Workspace Meeting lives in `meetings/store.ts`; occurrence snapshot, enrichment, provider outcomes and result live with Runs; delivery retry can reuse an existing result; `revision.ts` identifies material Calendar changes |
| Meeting Debrief | `MeetingPage.tsx`, `MeetingDebriefContent.tsx`, `DebriefEmailPanel.tsx`; Meeting Debrief host and Transcript review routes | Transcript Catalog supplies immutable revision and identity context; `meeting-debrief/module.ts` associates, extracts and prepares review; `extraction.ts`/`candidate-extraction.ts` ask the model; `publication.ts` verifies committed checked-core and revision artifacts | Debrief operation reservation, immutable revisions, publication pointer and completion receipt are distinct; Action Items and accepted Tasks are Workspace-owned; review-only partial publication cannot claim complete or authorize email |
| Person Profiles | `PeoplePage.tsx`, `PersonProfileDetailPage.tsx`, `PersonDossierPanel.tsx`; `api/person-dossiers.ts` exposes dossier/revision/source/history/research | `profiles.ts` owns identity choices; `research-queue.ts` schedules; `research.ts` discovers, attributes, extracts and composes through configured providers; source-adapter HTTP/browser routes retrieve evidence | `store.ts` owns Profile state; `dossier-store.ts` validates sources, claims and revision records; detached sources remain excluded; interrupted queue work resumes with retained evidence and pending leads |
| Shell and shared resources | Home, Settings, onboarding, connections, Run history/retry | `composition/shell.ts` wires stores and product hosts; `engine/runner.ts` owns generic Run transitions, stage records, queue and durable recovery; Modules decide their retry policy | `runs.ts` owns Run records; `engine/commit.ts` provides verified same-filesystem rename and per-record serialization; production launcher enforces one writable process per mount |

The Shell is not a multi-tenant service: `main.ts` defaults to loopback; its container
binds internally on all interfaces while the supported host publication remains loopback.
Docker is the supported runtime. No accounts, cloud backend, or remote exposure were
introduced. `composition/shell.ts` disables Fastify request logging; `api/router.ts` returns
redacted configuration. This is evidence of existing controls, not proof every diagnostic
message and error response is free of sensitive material.

### Behaviors inspected and preserved

- **Calendar classification.** `eligibility.ts` excludes all-day/missing-time/cancelled
  events, declined owner invitations, rooms/resources, and meetings with no other
  non-declined participant. Recordability is deliberately broader, preserving cancelled
  and declined Meetings. `meetings/read.ts` groups dates in Workspace timezone and keeps
  cancelled records available to history filters. `timeAnchor.ts` declines to invent
  a civil-date anchor when the meeting timezone is absent. `revision.ts` includes title,
  timing, attendees/responses, location, conference link and attachments in material
  changes. These seams were read; this audit did not run a live recurring/rescheduling
  Calendar campaign or assert every DST case.
- **Brief trust and freshness.** `freshness.ts` labels absent provenance dates unknown,
  keeps historical relationship evidence historical, and treats contradiction separately
  from age. `compose.ts` explicitly treats delimited provider content as untrusted data,
  forbids its instructions from changing output or directing external actions, and
  validates a structured model output. Prompt text is a defense layer, not a proof of
  immunity to injection. No prompt changes or live-quality claims are made here.
- **Debrief acceptance and completion.** `publication.ts` verifies checksums and mappings;
  an incomplete checked core can be reviewable without a completion receipt. ADR-0085
  preserves required unavailable sections, and retry resumes eligible retained core.
  `tasks/promotion-authorization.ts` and ADR-0095 reserve released evidence and explicit
  enablement before inference; a later policy change cannot authorize old proposals.
  `module.ts` uses receipts for downstream draft/output retries. The review gates and
  draft-only behavior must remain intact; mocks do not establish extraction quality.
- **Person identity and provenance.** `resolver.ts` records matching signals and rejects
  conflicting email/handle combinations; a name alone is medium-confidence evidence,
  not a confirmed identity. `research.ts` has further attribution decisions, excludes
  owner-detached sources and rechecks Transcript confirmation. `subject-attribution.ts`
  separates quotation support from whether the quotation concerns the focal person.
  `dossier-store.ts` validates source/claim schemas and verifies citation text occurs in
  retained source material. `research-queue.ts` requeues interrupted work with explicit
  interruption detail. Its generation mechanism prevents pause from looking like success.
- **Persistence boundary.** ADR-0086 and `engine/commit.ts` explicitly claim process and
  container recovery on an intact mount, not power-loss durability or multi-file
  transactions. No `fsync` or broader storage guarantee should be inferred. Before any
  stored-format work, the prescribed quiesced backup/restoration remains required.

### Additional findings (baseline evidence; final status below)

| ID | Finding and evidence | Impact / severity / confidence | Status and verification method |
| --- | --- | --- | --- |
| SEC-01 | `source-adapters/http.ts` validates only the initial URL and uses `redirect: "follow"`. `pooledLookup()` passes DNS answers through without checking their address class. `source-adapters/browser.ts` likewise validates only the first navigation and installs no subresource routing restriction. | Public-source content can direct network access toward local/private services. High severity; high confidence in missing controls from source inspection. No exploit or private-network access attempted. | HTTP/byte transport fixed in this batch; Chromium egress deferred (see delivery update below). Verify mock redirect hops, IPv4/IPv6 literals, DNS answers/rebinding at connection time, and browser navigations/subresources. Preserve the explicitly configured self-hosted SearXNG exception. |
| SEC-02 | `assertPublicHttpUrl()` calls `isIP(url.hostname) === 6`, but WHATWG URL hostname for IPv6 includes brackets. Non-network Node probe returned `{ "hostname": "[::1]", "isIP": 0 }` for `http://[::1]/`. | Loopback IPv6 bypasses the intended literal-address check. High severity; confirmed deterministic parser mismatch. | Fixed with regressions for bracketed loopback, private IPv6 and IPv4-mapped IPv6 (see delivery update below). This is part of SEC-01's boundary, not an independent architecture project. |
| REL-01 | Text transport calls `response.text()` before checking its 5,000,000-character ceiling; byte and browser transports also apply their retained-body ceiling after collection. | The configured limit rejects oversized completed output but is not a streaming memory bound. Medium severity hypothesis pending measurements; timeout limits duration, not allocated bytes. | Deferred; synthesize an oversized streamed response in an isolated test and measure memory before deciding the required streaming limit. Do not claim a measured memory regression now. |
| REL-02 | Person research and dossier rendering have separate queue state, historical revision and source-attribution state; disclosure of a source must not imply that the source is still attributed in every revision. | Stale UI/selection is already in the selected fix batch; broader cache correctness must key Profile, revision and source lifecycle. Medium product risk; remaining cross-revision combinations not reproduced. | Keep current server validation authoritative; extend isolated revision/detach/research-in-flight browser cases before a cache migration. |

SEC-01/02 were reported immediately and the HTTP scope was prioritized for this batch. A read-only issue-title search of the first 100 open issues found no title
matching SSRF/security/redirect/DNS; this is not a guarantee that no related issue exists.

### SEC-01/02 delivery update: HTTP and byte transport fixed

The coordinating agent prioritized the discovered HTTP boundary defect in this batch.
`apps/server/src/source-adapters/http.ts` now applies one address policy to URL literals
and DNS answers returned to the socket, rejects bracketed/mapped private IPv6 correctly,
and handles redirect hops explicitly before requesting their targets. The policy also
excludes shared, documentation, benchmark, multicast and reserved ranges. This is a
conservative public-source policy, not a general Internet reachability classifier.
Cross-origin redirects drop credential and conditional headers; POST redirect behavior
and the existing 20-hop limit retain fetch semantics, with one timeout across all hops.
The configured unguarded self-hosted search keeps a separate dispatcher and remains usable.

Node's [BlockList documentation](https://nodejs.org/api/net.html#class-netblocklist) confirms
subnet matching and IPv4-mapped IPv6 behavior; its established `addSubnet`/`check` APIs were
chosen over adding a new dependency. Address categories were checked against the
[IANA IPv4 registry](https://www.iana.org/assignments/iana-ipv4-special-registry) and
[IANA IPv6 registry](https://www.iana.org/assignments/iana-ipv6-special-registry).
The connection hook follows [Undici's client options](https://github.com/nodejs/undici/blob/main/docs/docs/api/Client.md).
No dependency, stored record, prompt, model, or outward-action permission changed.

Regression evidence:

- `pnpm --filter @chief-of-staff-demo/tests exec vitest run tests/src/modules/source-http-safety.test.ts`
  initially failed all **10** isolated guard/redirect/DNS cases against the original code.
  DNS and fetch were mocked at their module boundaries; no private service was contacted.
  After the fix, the expanded **14** cases pass, covering public redirects, final URL,
  cross-origin headers, POST conversion, loop/deadline bounds and local search opt-out.
- `pnpm --filter @chief-of-staff-demo/tests exec vitest run tests/src/modules/source-http-safety.test.ts tests/src/modules/source-http-dispatcher.test.ts tests/src/unit/source-eligibility.test.ts`
  passed **26 tests in 3 files**, including existing socket pooling, timeout, DNS failure
  and provider-eligibility coverage.
- `pnpm --filter @chief-of-staff-demo/server run build` passed.
- `pnpm exec tsc -p tests --noEmit` passed.
- `pnpm exec oxlint --type-aware apps/server/src/source-adapters/http.ts tests/src/modules/source-http-safety.test.ts`
  passed with no findings. Both edited files were formatted with the existing Prettier.

**Remaining security limit:** browser-rendered navigation and subresources still use
Chromium's independent network stack. Its first URL benefits from the corrected literal
check, but this change does not validate browser redirect DNS or subresource destinations.
SEC-01 is therefore **fixed for the shared HTTP/byte transport, open for browser egress**;
SEC-02 is **fixed**. No claim of exhaustive egress protection or live attack validation
is made. The next concrete step is a separately reviewed browser request-routing/DNS
boundary with adversarial synthetic navigation and subresource tests. REL-01's post-read
body-size ceiling remains deferred.

## Baseline and delivery scope

Baseline: clean `main` at `84dbd82e92fdcb599e21cf77ff41604f15944c73`, inspected
2026-09-14. Local environment: macOS, Node `26.8.1`, pnpm `12.3.4`; production
Dockerfile builds on Node `22.18.0`. Manifests, lockfile, Compose, CI, AGENTS/CLAUDE,
CODING_STANDARDS, CONTEXT, applicable ADRs and `docs/agents/` were inspected.
`gh pr list --json number,title` and `gh issue list --json number,title` both returned
empty arrays. No concurrent PR or unrelated working-tree changes were present.

`pnpm run check` passed before implementation: **255 files / 2,986 unit tests**,
typecheck, lint with 12 policy probes, formatting, knip and workflow verification.
`pnpm run build` passed. The existing baseline browser command was:

```sh
pnpm --filter @chief-of-staff-demo/tests exec playwright test \
  meeting-brief-journey meeting-debrief-journey person-dossier-journey \
  meeting-reading-acceptance
```

All **16 browser tests passed** in 34.7 seconds. These exercise synthetic briefing
preparation/retry, debrief review and incomplete results, person research with mock
extraction, source inspection, historical dossiers, and 1280/960/390px reading layouts
plus 200% zoom. They establish UI/API/workflow behavior with controlled providers,
not live Calendar coverage, identity-research quality or extraction quality.

The existing `tests/e2e/start-server.mjs` was also launched on 4319 with its fresh
`mkdtemp` Workspace, mock provider, fixture source and test seed API. A real browser
walkthrough inspected Home, Person Profiles and the source reader; no console errors
were observed during the baseline source walkthrough. Rebuilding assets underneath
that running test server required restarting it because static registration still
held the previous asset names; this is a test-session artifact, not a Docker runtime
regression. Production restarts ship the bundle and server together.

Docker was initially stopped; the owner started it during the audit. `docker compose
-p found42-audit build` built both production images. Boot used a derived Compose
configuration with a new temporary host Workspace, an independent project/network,
and loopback ports 44317/44318. `docker inspect` verified the mounted source was the
new temporary directory, and a shape-only configuration check verified **no API key
and no Google refresh token**. The actual business Workspace was never mounted,
read for fixtures, migrated or replaced. An internal-only network first proved
`/api/health` inside the container; its published host port was unavailable. The
ordinary isolated Compose network then proved host access with `{"ok":true}`.

No stored-format, prompt, model, approval-policy or dependency changes are in this
batch. Therefore the live-Workspace format-change backup gate was not activated.
No paid evaluations, Google writes, messages, publication or live deployment were
performed. The only migration exercised was the existing zero-record setup gate
inside the disposable container Workspace.

## Implemented product findings

The coherent batch makes asynchronous reads trustworthy and evidence review usable.
Research sources above informed request ownership, contextual source reading and
keyboard behavior; no external source code was copied.

| ID / priority | Reproduction and evidence at baseline | User impact and intended behavior | Result / verification |
| --- | --- | --- | --- |
| UX-01 / medium / confirmed | Click a dossier citation: the retained source appends below the section, focus stays on the citation, and the supporting text can be below the viewport. | Open a reader immediately, show its loading/error state, keep the supporting passage and full retained text together, then return to the citation without changing reading position. | Fixed with a native modal dialog, highlighted passage, readable wrapped text, retry, Escape, focus return, and a separate wrong-person correction disclosure. Real-browser test covers success, failure/retry, mobile, inert background, closing an in-flight read, and actual synthetic source detachment. |
| UX-02 / medium / confirmed | All ten dossier tabs have `tabIndex=0`; ArrowLeft does not move the selection. Red unit test fails on ten tab stops. | One tab stop; Left/Right wrap, Home/End select boundaries; panel remains keyboard reachable. | Fixed. Unit and browser keyboard assertions pass; axe scan covers the source-reader interaction. |
| REL-03 / high / confirmed | Resolve a newer People filter request, then its older predecessor: old records replace current results. First-load rejection leaves “Loading…” and no retry. Two red unit tests demonstrate both. | Results must correspond to the current search; failures must stop claiming progress and provide recovery. | Fixed with request generations and explicit loading/error/retry states. Old results are cleared when the search changes; the user does not select a person from a result set belonging to another filter. Browser verifies failure → retry → result → no-match search. |
| REL-04 / high / confirmed | Meeting hook: resolve refresh before initial read, reject an old request, call Prepare twice before rerender, or let a poll succeed after Prepare fails. Four red tests show stale projection/error, duplicate preparation and erased failure. | Only current reads publish; one preparation is admitted; successful reads cannot imply a failed preparation succeeded. | Fixed. Ten hook tests cover these cases, pending-operation busy state, retries, slow polling, retained last-good projection and leaving the page. |
| REL-05 / high / confirmed | With Revision 1 selected, Prioritise research reads current Revision 2 and displays it under the historical label. Four initial red tests also show four stalled reads in 12 seconds, uncleared read failure and erased independent history failure. | Selected evidence revision remains authoritative across actions and polls; old responses cannot replace it; read, action and history outcomes remain distinct. | Fixed with a shared revision-aware refresh and generation guards. Polls skip pending reads, revision changes clear mismatched content, and source detachment uses the same refresh. Targeted tests preserve scheduling edits during research actions and edits made while saving. |
| REL-06 / medium / confirmed | Source selection waits silently for its request; a closed/obsolete request can later change the reader. Red unit test cannot find a Close control during the pending read. | The reader opens immediately and owns the lifetime of that exact source request. | Fixed by mounting the source reader for the selected Profile/source/quote and ignoring responses after unmount. The browser verifies closing during a delayed HTTP response does not reopen the reader. |

### Visual evidence

All screenshots contain synthetic fixtures, not business data. The desktop comparison
uses 1280 × 720; mobile is 390 × 844. Screenshots support visual inspection; the tests
above establish control behavior.

- [Before: source appended below the dossier](product-experience-2026-09-14/dossier-before.png)
- [After: source evidence reader](product-experience-2026-09-14/dossier-after.png)
- [After: mobile source reader](product-experience-2026-09-14/source-reader-mobile.png)

### Additional setup and performance findings

- **ONB-01 — deferred, medium, browser-confirmed:** a new production Workspace shows
  “Workspace migration” and asks for `MIGRATE TASKS`, despite all preview counts being
  zero. The synthetic cutover succeeds and Continue to Home works. The next step is
  an explicit pristine-Workspace initialization path that preserves the fail-closed
  behavior for existing or unrecognized state; do not bypass the gate globally.
- **ONB-02 — deferred, medium, browser-confirmed:** before setup is finished, default
  Content Research activity can appear and People Discovery can fail without a model
  credential. The disposable Workspace had no key/token. The next step is to reproduce
  fresh-boot scheduling in a focused test and define which intakes require completed
  setup, without stopping intentional returning-user background work.
- **PERF-01 — deferred, low, measured build warning:** the initial production main
  JavaScript bundle was about 868 kB minified / 241 kB gzip and Vite reports the existing
  500 kB chunk advisory. No loading-time improvement is claimed. A separate measured
  route-splitting change should compare cold navigation and shared-cache behavior.
- **LIVE-01 — blocked at evaluation boundary:** no paid/model-quality or live integration
  campaign was authorized. Prompts/models are unchanged. Synthetic workflow success is
  not a claim of real-world source completeness, identity correctness or debrief quality.

## Final verification

Final local whole-application gate:

```sh
pnpm run check:all
```

**Passed:** 258 unit-test files, **3,027 unit tests**, every static gate, production
web/server build, and **119 Playwright tests**. The new regressions were observed red
before implementation; no goldens, coverage floors, lint rules or checks were weakened.
The expanded Relationship history retry was then exercised with:

```sh
pnpm --filter @chief-of-staff-demo/tests exec playwright test evidence-recovery
```

**Passed: 2 complete journeys**, including failed source retry, closing delayed reads,
wrong-person source detachment, keyboard tabs, focus return, mobile reflow, axe,
People failure/retry/filtering, and unavailable Relationship history → retry →
confirmed empty history. The final `pnpm run check` rerun covers that added test code.

Pause/resume now merges fresh server state while preserving only the three editable
scheduling fields. Relationship history shows loading until its read finishes and never
turns a retrieval failure into an absence claim. Thirteen dedicated dossier-refresh
tests cover the historical/action/poll/settings/history combinations, alongside ten
Meeting index tests, four People page tests and six dossier page tests.

Production commands use the separate temporary Workspace/project described above:

```sh
docker compose -p found42-audit build
docker compose -f /tmp/found42-audit-compose.json up -d --no-deps relay app
curl --fail http://127.0.0.1:44317/api/health
docker compose -f /tmp/found42-audit-compose.json down
```

The application remains local and single-user. Final delivery is a feature branch and
PR behind the required `check`, `test`, `e2e`, and `image` checks; live application
activation is separate. The unresolved Chromium egress, pristine setup, startup
scheduling, streaming memory bound and real-model evaluation items above remain visible
follow-ups, not claims of completed validation.

The final production rebuild and recreated-container health check passed. Running
`node /app/scripts/run-canaries.mjs --check` from that image composed **9 production
adapters with no external calls**. The final Docker-served Home rendered in a real
browser with no console warnings/errors observed. The isolated Compose project was
brought down after verification; the user's live application was not deployed.
