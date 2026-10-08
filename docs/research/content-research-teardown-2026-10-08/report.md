# Content Research adversarial teardown — 2026-10-08

## Outcome and scope

The teardown found reproducible loss and misattribution of evidence, unverified model
references, incomplete HN retrieval, and recovery failures. The changes repair those
paths within Content Research. No runtime dependency, credential requirement, or
external service was added. Content Engine, Person Profiles, and Meeting Wizard
implementations are outside this change; shared profile APIs are exercised as watch
prerequisites. YouTube Trends remains an independent measurement module presented
beneath Content Research, as ADR-0044 requires.

Baseline revision: `d51fc3f37893b3d823deeb2ebfd6f96519ad6259`. Commands ran on macOS,
Node `v26.9.0`, pnpm `12.3.4`, Chromium through the existing Playwright setup, and the
supported Docker image. The canonical app was already stopped. Pre-existing
untracked `output/` was preserved. There were no open tracker issues returned by
`gh issue list --state open --limit 100` at the independent assessment checkpoint.

Execution budget: 90 minutes for research/probes/implementation plus 30 minutes for
verification/reporting, expandable only when new evidence justifies it. Preparation
preceded the first recorded baseline run at 11:15 EDT. Final local verification is recorded in the evidence ledger;
GitHub revision and merged-state verification are reported at delivery; this was one bounded session,
not an exhaustive platform or participant study.

The simulated persona is a Found42 researcher, using a desktop browser, who knows
people and their public publication links but no application internals. The task is
“follow people, obtain attributable recent content, identify what resonates, and
understand missing results.” This task follows README and ADR-0039. Observable
acceptance criteria were set before fixes: preserve distinct sources, bind counts
and provenance to the observed person/source, retain only supplied references,
honor collection windows and expose limits, and recover from failed or asynchronous
actions without losing inputs or reloading the page.

Simulated reaction: “A report that silently drops sources or quotes the wrong article
cannot tell me why something landed. After a run starts, I need its results and a
route to its collection failures.” This is a hypothesis-generating persona reaction,
not evidence of real-user preferences or adoption.

## Findings and dispositions

All rows below are confirmed by executed regressions unless explicitly qualified.
“Fixed” means the changed behavior passed regression coverage; it does not assert
that every live publishing platform or model has been validated.

| ID | Expected / actual before | Impact and counterevidence | Change / acceptance witness | Disposition |
|---|---|---|---|---|
| CR-01 | Distinct canonical URLs remain stored. `https://same.example/posts/one` and `/two` share the truncated base64 filename; the second overwrote the first. | High: discovery loses source evidence. Existing global dedup tests checked different hosts and did not catch this. | Full-URL SHA-256 filenames; update only that URL. Legacy files remain readable and are retired only for an exact URL match. Same-site update and legacy-collision holdouts retain both articles. | Fixed. Previously overwritten bytes cannot be reconstructed by this patch. |
| CR-02 | Each person's report uses its collected observation. A shared URL observed as RSS/10 views for Ben and YouTube/900 for Ava gave Ava platform `youtube`, counts `10`, evidence `fixture:rss`. | High: ranking and source attribution become inconsistent. Global dedup is intentional; sharing another person's payload is not required by it. Test input represents a feed linking to the same video URL. | Keep global storage dedup, but retain each person's own observation for scoring, hooks and evidence. Ava now keeps 900 and `fixture:youtube`. | Fixed; deterministic reproduction resolves Jev's classification uncertainty. |
| CR-03 | An optional evidence quote is verbatim and belongs to its displayed item. `Body of One` appeared under both One and Two; an invented quote also survived. | High trust impact. A person-level hook may legitimately summarize several items, but that does not make its quote evidence for every item. | Exact substring check against each item's title/excerpt/transcript actually supplied to the extractor; unsupported quotes remain null. Person-level hook is preserved. | Fixed. This checks literal provenance, not the semantic truth of the hook. |
| CR-04 | Discovery supporting URLs are copied from supplied evidence, as the prompt requires. Invented URLs and an entirely unsupported person were saved. | High trust impact; a model prompt is not an enforcement boundary. Existing discovery tests supplied proposals without evidence. | Filter URLs against the exact recent-item/search-result URL set; deduplicate URLs and drop proposals with no surviving reference. Lifecycle tests now supply the cited search evidence. | Fixed. This does not establish person attribution or relevance merely from a URL match. |
| CR-05a | HN collects available pages within a bound. It fetched only one 30-hit page regardless of advertised pages. | Medium coverage impact. A live 90-day Paul Graham story query had 43 unique hits; previous adapter returned 30. | Fetch up to ten 100-hit pages; deduplicate object IDs. Same-window live before/after: 30 → 43, one request each. Two-page fixture: all three unique hits retained. | Fixed; 43.3% more unique items on this query only. |
| CR-05b | HN respects both requested time bounds and distinguishes malformed responses from a genuine empty page. `until` was ignored; missing/wrong `hits` looked empty, and null records could throw. | Medium correctness impact. Valid empty `hits: []` remains a legitimate empty result. | Inclusive since/until request filters and local date checks; existing Zod validates response records and pagination. Malformed pages receive classified failure. | Fixed; missing publication dates remain explicitly unknown. |
| CR-05c | Partial pages and collection caps are visible and do not advance a target checkpoint. Previous code never reached those conditions because it stopped at one page. | Medium coverage/trust impact. Anonymous HN search has an upstream retrieval ceiling, so pagination alone cannot promise exhaustive history. | Retain earlier pages on later rate-limit/JSON failures. Local ten-page limit or advertised provider truncation returns `unsupported_capability` with cause and no checkpoint. Valid-empty, duplicate, late-rate-limit, malformed-later-page and cap holdouts pass. | Fixed; a 1,000-hit ceiling remains explicit. |
| CR-06a | Rejected watch creation retains editable inputs; pending creation cannot submit twice. The original UI cleared failed profile/feed input and accepted another pending submission. | Medium recovery impact. Successful creation should still clear its form. | Clear only after successful mutation, guard busy submission; rejected and pending cases are rendered tests. | Fixed. |
| CR-06b | Load failure offers recovery and refresh failure does not simultaneously announce fresh success. The original initial failure had no retry; failed refresh also displayed the success notice. | Medium recovery/trust impact. The underlying mutation can succeed even if the refresh fails. | Retry loading action, success notice conditional on refreshed state. Successful mutations remain successful for form clearing. | Fixed. |
| CR-07 | Results arrive after asynchronous research/backfill/discovery starts without manual reload. Original browser cases failed all three transitions. Completed runs were excluded from the run list. | Medium usability impact. Controlled API responses establish client lifecycle behavior, not live collection behavior. | Poll while a run is active, display running status and an Open Run link, and keep completed runs in Research Runs. Same browser cases now pass 3/3 and expose the completed run link. | Fixed; no unaided full live-provider journey is claimed. |
| CR-08 | Malformed watch hints are refused before persistence. `blogRssHints: "not an array"` returned HTTP 200 and created a malformed watch. | Medium integrator/reliability impact. Valid profile-backed watch creation is preserved. | Parse using the existing shared handle-hints schema; HTTP 400 leaves the watchlist empty. | Fixed. |
| CR-09 | Pagination failures retain response evidence and identify the failed stage. Review found response hashes/content types discarded and all failures labeled `fetch`. | Diagnostic reliability; discovered by source inspection after the first gate, not a live-provider failure. | Retain retrieved bodies’ hash and content type; parse/shape/truncation use `adapter_boundary`. Twelve HN tests verify partial items, no checkpoint and diagnostic evidence. Stronger reviewer confirmed resolution. | Fixed. |

Smallest reproductions and actual expected/received outputs are in
[integrity-before](evidence/integrity-before.log), [HN before](evidence/hn-before.log),
[UI before](evidence/ui-before.log), [watch input before](evidence/watch-input-before.log),
and [browser before](evidence/browser-before.log). The executable regression cases
are in `tests/src/modules/content-research.test.ts`,
`tests/src/modules/content-research-hn.test.ts`,
`tests/src/unit/content-ux-regressions.test.tsx`, and
`tests/e2e/content-research-recovery.spec.ts`.

## Experiments and decisions

| Experiment | Control and falsifier | Result / decision |
|---|---|---|
| EX-01, evidence storage | Two different paths on one host, then update one; legacy file holding the other URL. Failure to retain two distinct articles falsifies the fix. | Original loses one; fixed store preserves two and updates only one. Old filenames can coexist with new names. No bulk migration or active workspace rewrite. |
| EX-02, attribution and quote provenance | Shared canonical URL with different observed adapters/counts; supported quote in only one article; invented quote as negative control. | Preserve each person's observation; reject unsupported literal quotes. Keep person-level hook and intentional global URL dedup. |
| EX-03, discovery evidence | One supplied URL plus invented URLs, including a wholly unsupported proposal. | Keep supplied URL only and drop unsupported proposal. URL membership is a necessary provenance check, not a semantic relevance classifier. |
| EX-04, HN retrieval | Immutable 90-day window, same public query and transport; original adapter versus updated adapter under `env -i PATH="$PATH"`. | [Before](evidence/live-hn-before.log): 30 unique. [After](evidence/live-hn-after.log): 43 unique, all dated items inside the window, no credential variables, one request each. The two-page and truncation experiments use fixtures to avoid large live crawls. |
| EX-05, complete local report | HN-backed 90-day backfill through ContentResearchHost, disposable profiles/workspace, real public fetch; stubbed hook and unconfigured Google outputs. | [Module witness](evidence/live-module.log): Run done, 43 unique stored items, three report and local ledger rows, independently recomputed top-three counts match, one profile pin. No model interpretation or Google publication tested. |
| EX-06, browser completion/recovery | Same controlled asynchronous responses with original and changed production web bundles. | [Before](evidence/browser-before.log): three failures. [After](evidence/browser-after.log): three passes. API interception is deliberate assistance isolating UI lifecycle. |
| EX-07, supported packaging | Build canonical Compose images, boot isolated credential-free workspace on loopback 4417. | [Health](evidence/docker-health.json) is `{"ok":true}`; [setup refusal](evidence/docker-readiness.json) returns [409](evidence/docker-readiness-status.log). Existing mandatory setup was preserved. |

Research leads, checked 2026-10-08:

- [HN Algolia API](https://hn.algolia.com/api) and its
  [upstream limit report](https://github.com/algolia/hn-search/issues/230): the direct
  anonymous endpoint exposes pagination. A separate `author_pg&hitsPerPage=2` probe
  advertised 500 pages/10,723 hits, so advertised pages do not imply unlimited
  retrieval. The issue documents a 1,000-hit limit; the source repository is archived.
  The plain documentation fetch was a JavaScript shell and Jev marked it `skip`;
  runtime JSON and upstream issue evidence informed the implementation instead.
- [Official HN API](https://github.com/HackerNews/API): public item/user/list access
  can enrich known records, but it does not substitute for named-person full-text
  historical search. Adding that extra traversal was not justified by these defects.
- [hn-get](https://github.com/iannuttall/hn-get): a local CLI/MCP plus HTTP/RSS clients
  over Firebase and Algolia. Its README claims MIT licensing, a local execution path,
  100-result search cap and no article crawling. That would duplicate an existing
  transport and would not repair our ownership/storage defects. Installation,
  transitive execution eligibility, packaging and maintenance/security were not
  independently audited; it was not admitted or integrated.
- [Awesome Hacker News](https://github.com/lebriton/awesome-hackernews) and public RSS
  discussions supplied discovery leads, not proof of eligibility or product demand.
  An additional aggregator/browser extractor would add machinery around source
  readers already present in this project, without resolving the reproduced faults.

DEC-01: retain and repair the existing module/adapter seams. Jev selected this
alternative with probability 0.99; no requirement was contradicted. No added tool
requires an installation/credential eligibility experiment, because none was added.
The changed HN path was exercised with an empty credential environment. Existing
Jev calls use the already configured judgment provider and are not a new product
runtime dependency.

## Preservation, judgments and verification

Before changing stored filenames, the canonical app was verified stopped. The first
backup attempt refused because its recorded old image ID no longer existed. That
private `.partial` result remains retained, and is not called a backup. A second
capture used a never-started container mounting the same canonical workspace and the
existing current image. The accepted receipt is
`/Users/Nicolas/Documents/backups/content-research-2026-10-08-baseline-current/result.json`:
918 files, captured at `2026-10-08T15:17:46.478Z`, restored and checksum-verified twice,
network not started. Runtime-to-source relationship remains unverified as the backup
workflow specifies. Changes after capture are outside its recovery point. The
canonical workspace was not activated or bulk-migrated in this session.

Loaded Jev skill: `/Users/Nicolas/.agents/skills/jev/SKILL.md`, SHA-256
`7b4e3f55e2b3e813ffe7e97911ef0e9ceb4e576e17332db8f3e1cf8342e84d33`.
Loaded adversarial UX skill v2.0.0:
`/Users/Nicolas/.agents/skills/adversarial-ux-test/SKILL.md`, SHA-256
`c790dcbd617e5481e50fd5aeb432526ef976c14db011b2631ea3f4f73697f157`.
Jev calls reported `typesafe/jev-1.13-20260917` through existing OpenRouter configuration.

Consequential judgment log:

- Plan: audience fit .89, observable success .87, route leakage uncertainty .74.
  Host resolution: no route was supplied to the persona; the normal app entry point
  preceded implementation diagnosis. Subsequent assisted probes are labeled above.
- Hypotheses: Jev was uncertain about filename overwrite (.16) and payload mixing
  (.71). Deterministic failing regressions proved the local faults; probability was
  not treated as proof or used to reject runtime evidence.
- Batch classification: six defect groups classified automatically; shared-payload
  classification was `review` (.79 winner, confidence .72). Host rule: a reproduced
  count/evidence mismatch against the recorded per-person input is a correctness
  defect regardless of simulated preferences. Jev claim verification subsequently
  supported the exact mismatch at .99, confidence .98.
- Source screens: official HN API and hn-get source text passed (injection .03 each);
  the JavaScript-only documentation shell was skipped. No blocked text was used.
- Verification of overwrite, payload mixing and the original asynchronous failures:
  all three verified, no contradiction/unsupported result, confidence .92/.98/.98.
- [Initial aggregate patch review](evidence/review-initial.json) escalated:
  safe-to-apply .31, correctness confidence .23, test-gap 1.67, blast-radius 1.98.
  It included production hunks and older narrow logs, without changed test hunks.
  This unfavorable result stands for that evidence. The host reviewed raw ownership,
  compatibility, schema, pagination and polling changes against new holdouts and
  current real checks. The final gate uses per-file raw diffs including changed tests
  and final logs; its result and any resolution are in the evidence ledger.

See [evidence and final verification](evidence.md) for commands, current gate
results, raw patch judgments and check logs. The separate
[Standards and Spec reviews](evidence/stronger-review.md) record the diagnostic
finding and its verified resolution. Jev gate escalation is preserved; it is not
reported as automatic approval.

## Coverage and limits

| Surface | Mode / outcome | Witness or gap |
|---|---|---|
| Docker entry, named-person watchlist, setup refusal | Executed / visible, correctly gated | Initial desktop viewport and final full-page screenshot; healthy rebuilt image and 409 refusal. |
| Watch creation/profile lifecycle | Executed with isolated fixtures | Existing prerequisites/lifecycle regressions plus malformed watch input and form recovery. |
| Real HN collection → local report | Assisted executed success | Real anonymous public source; profile created via host API, hook stub, no external publication. |
| Async daily/backfill/discovery UI | Assisted executed success | Controlled HTTP responses in real Chromium; original three failures re-attacked after fix. |
| Adapter edge cases | Executed with fixtures | Pagination, duplicate records, bounded interval, valid-empty, malformed response, late failure and truncation. |
| YouTube Trends | Partial execution | Parent/subnav navigation and unsupported custom channel URL refusal were observed. Valid authenticated measurement/Sheet write was not exercised. An initial selector timeout was harness error, not filed as a defect. |
| Google ledger/draft, live model hooks | Untested live | Existing injected module tests passed; no credentials were supplied to the disposable Docker installation or public probes. |
| Other public platforms and fresh 90-day baseline | Existing automated coverage / not a live campaign | No exhaustive social-platform collection, cancellation campaign, long-running per-person baseline calibration or human usability study. |

The ranking still measures weighted engagement level relative to the existing
per-person baseline; this session does not establish causal “why it lands,” observed
engagement velocity over time, or a calendar-complete 90-day measurement series.
Literal quote/reference checks reduce fabricated provenance but cannot prove semantic
truth, identity attribution, or source completeness. Larger collections remain
bounded and explicit about gaps. No changes were invented for flows that survived
scrutiny: setup gating, profile-backed identities, optional outputs, backfill
isolation, and the independent YouTube Trends module are preserved.
