# Person Profile adversarial teardown — 2026-10-08

Scope: Person Profile entry, identity repair, dossier research/readiness, retained
evidence, and the person-research verification CLI. Meetings and content workflows
were outside the teardown. Baseline: `9efde843f68dd8f607ce72a011a36282cba8bc8c`.
The implementation and regressions are the accompanying PR diff; measurements
below refer to that diff, rather than an unspecified later HEAD.

Assumption: the intended operator maintains useful, attributable professional
Profiles in a local Workspace. They must be able to enter an identity, understand
research blockers, inspect supporting evidence, and repair mistakes without
silently changing historical records. This follows CONTEXT.md, ADR-0062 and the
dossier acceptance criteria; simulated skepticism does not establish real-user
preferences or adoption rates.

The simulated operator knows ordinary web forms but not this codebase, wants to
save and check a professional contact, uses keyboard and pointer, and will stop
when the page offers neither success nor an actionable recovery. The initial
goal supplied no route. Normal navigation was used before implementation
inspection; direct synthetic API writes and test fixtures later assisted boundary
diagnosis and do not count as unaided discovery. F5 blocked unaided first use;
other inspected journeys succeeded with the named harness assistance. Simulated
reaction: “The page tells me to prioritise research, but gives me no control.”
This describes F5's observed surface, not a participant quotation.

Applied skill: `~/.agents/skills/adversarial-ux-test/SKILL.md`, version 2.0.0,
SHA-256 `c790dcbd617e5481e50fd5aeb432526ef976c14db011b2631ea3f4f73697f157`.

## Acceptance and coverage

Before implementation, the acceptance criteria were: malformed requests yield
actionable client refusals without writes; entry and repair share identity rules;
an edited or abandoned pending duplicate check cannot submit an old identity;
empty research states explain the next available action; and source verification
distinguishes actual access from declarations. Existing successful create,
lookup/reuse, corrections, merge, detach, archive/restore, historical reading and
privacy-delete journeys must continue passing.

Research completeness uses the existing reference corpus as a proxy, not a
claim about arbitrary people. Its hash is `14bca86ee0b97d28`: 30 people, 20
requirements, plus one collection-level intersection scenario. Individual facts
cover contribution, magnitudes, expertise, counterparties, constraints, dated
history, writing, verifiers, freshness, authority, unsuccessful work, recurring
collaboration, attribution, governance, artifacts, domain crossings, availability
and source composition. R18 has zero individual facts because it is measured
across the collection. [Coverage output](evidence/corpus-coverage.log).

| Dimension | Exercised | Practical limit |
| --- | --- | --- |
| First success and recovery | Real Docker UI/API; entry, reuse, readiness, correction, archive/restore | No live paid model run or real owner onboarding |
| Identity boundaries | Wrong JSON types, repeated filters, non-person LinkedIn addresses, normalized regional URLs | Not a fuzzing or penetration-test certification |
| Concurrency/interruption | Deferred duplicate read, identity edit, unmount, resubmission; existing research interruption tests | Requests already dispatched remain governed by existing APIs |
| Evidence correctness | Existing person corpus and tests for duplicates, conflicts, source inspection, revision retention, gaps and privacy | Fixture correctness is not live internet recall/precision |
| Access and operation | Credential-cleared anonymous probes, missing-provider Docker boot, full browser and unit gates | 27 production routes have no configured probe; relay omitted in isolated stack |
| Usability/accessibility | Existing keyboard, axe, source-inspector and 1440/375-width person journeys; real initial-state screenshot | No user study, other browsers or other OS tested |

The investigation initially reserved roughly one hour for research and probes,
with implementation and final gates taking priority afterward. New evidence
expanded the initial-state investigation. Network timeouts and model uncertainty
were preserved rather than retried unchanged until agreeable.

## Findings and dispositions

**F1 — Confirmed API contract defect, fixed.** Sending `{"fullName":42}` to
`POST /api/people` produced 500 (`value?.trim is not a function`). A malformed
profile URL and repeated scalar search query also produced 500. Wrong types in
correction/merge/detach bodies could escape into domain code. Archived identity
acceptance returned 500 for an expected restore conflict. The competing
explanation was unsupported integrator input; a client refusal is still the
documented boundary behavior. E2 demonstrates the runtime result; E3 tests no
creation, revision or invalidation change. Local Zod parsing and named error
mapping now return 400. Valid requests and archived restore/reuse remain covered.
The prior UI already showed restore guidance: this is an API classification
failure, not evidence that every archived UI journey was unusable.

**F2 — Confirmed inconsistent identity correction, fixed.** Correcting a Profile
to `https://linkedin.com/company/example` succeeded and appended revision 2,
although identifier entry rejects that address as a person. Correction also
accepted single-label hosts and preserved regional/tracked LinkedIn variants.
An intentional general-purpose website field was the strongest alternative
interpretation; these are canonical `profileUrls`, and the existing person
parser supplies the established policy. E2/E3 use the same addresses on both
paths. Correction now reuses that parser, refuses invalid URLs without history
mutation, and normalizes regional/tracked LinkedIn URLs before lookup. Historical
revisions are retained, including the intentionally bad baseline revision; no
stored-format migration or rewriting of existing Profiles is performed.

**F3 — Confirmed stale entry submission, fixed.** Start creating one name while
the same-name list read is pending, then edit the name. The old closure can
create the original identity or resurrect a warning for the previous name.
The hypothesis was initially unresolved; E4 added controlled deferred responses
and observed two red tests before implementation. Input/lifecycle generations
now cancel that pending submission. E4/E5 verify no old creation or warning,
normal resubmission, opening the real duplicate, and leaving the page. The fix
does not promise cancellation after a write has already left the browser.

**F4 — Confirmed misleading research verification summary, fixed.** The source
probe CLI printed `32/59 routes answered as documented` even when all 23 actual
probes succeeded: it counted unprobed excluded routes as successes and unprobed
production declarations as failures. Detailed rows disclosed those limits,
which reduces but does not eliminate the summary error. E6 tests successful and
failed anonymous attempts alongside explicitly unprobed routes. The summary
and exit status now depend on actual probes and disclose the other denominators.
E7's live result: **23/23 passed; 0 failed; 27 production routes unprobed; 9
excluded/unavailable routes not probed**. This establishes anonymous response
shape for those attempts, not source relevance, identity truth or completeness.

**F5 — Confirmed first-use research dead end, fixed.** A saved Profile with both
`dossier:null` and `research:null` returned early from the UI, hiding its already
supplied readiness and all research controls. The page told the user to
prioritise research but provided no way to do that or open setup. E8's real
credential-cleared Docker envelope names `provider-not-configured` and the setup
URL. Two ready/blocked no-job tests failed before the fix; both pass afterward.
The empty-state message now renders alongside the existing readiness and control
surface. This is not a provider implementation failure: the backend already
supplied the correct next action. [Before](evidence/initial-readiness-before.png)
and [after](evidence/initial-readiness-after.png) show the same disposable Profile.

## Alternatives and decisions

D1 compared retaining unsafe casts, existing Zod validation and Fastify JSON
Schema. [Fastify's validation documentation](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)
supports body/query schemas and describes default array coercion. We chose the
already installed Zod library for explicit type refusal with minimal local
change. Jev selected it with probability 1 and no contradicted requirements.
No additional package, runtime backend, credential or paid service was added.

D2 retained the existing identity parser rather than creating another correction
normalizer. E3 demonstrates consistent reuse and exact historical retention.
D3 retained the existing research controls/readiness rather than adding a second
onboarding surface; E8 exposed an early return, not a missing backend capability.
D4 retained the source catalogue and separated actual probe outcomes from
unprobed declarations, rather than pretending to run the missing probes or
discarding the recorded access gaps.

Broader discovery included the [open-source CRM list](https://github.com/sneg55/awesome-open-source-crm),
[Monica](https://github.com/monicahq/monica), community contact-management
discussions, [Schema.org sameAs](https://schema.org/sameAs), and a
[primary identity-link survey](https://arxiv.org/abs/1907.10528).
Community material was used for leads, not consequential technical claims.
Monica's repository distinguishes its beta branch from recommended stable 4.x;
retrieving that branch via the web tool failed. A CRM replacement was not a
serious integration candidate: no demonstrated Profile gap justified a second
application, data migration and operating model. Its complete licensing and
transitive execution eligibility were not verified; it was not installed.

O1, structured `sameAs` discovery, remains an **unresolved capability hypothesis**.
Such links assert entity identity; they do not independently establish it. No
holdout recall/precision benefit was demonstrated. Adding ingestion on that
basis would be speculative. Reconsider only with a reference set showing useful
incremental facts and identity-error controls. Existing public readers, retained
sources and conflict handling survived scrutiny; more sources alone is not
evidence of better Profiles. No additions require an eligibility exception.

## Experiments, checks and judgment

The [experiment/evidence ledger](evidence.md) links each requirement to the
reproduction, decision, fix and recheck. Docker is the supported app path; its
build exercised the frozen install. Tests use the existing hermetic native seam,
not an invented alternative hosting contract. Node 26.9.0, pnpm 12.3.4, Vitest
5.0.3, Playwright 1.63.0, Fastify 5.12.5 and Zod 4.6.5 were present on macOS.
Disposable Workspace and Compose project: `person-teardown-20261008`, port 4397.
Untracked user `output/` and unrelated Docker resources were preserved.

Baseline person tests had 770 passes and three CLI timeouts while competing
with build/browser work; those same three files passed 79 tests with two workers.
A later overloaded whole-tree run was interrupted after resource failures.
Neither was accepted as a product defect or as green evidence. Standalone bounded
verification supplies the final measurements below. The baseline browser run
passed 14 person journeys across five files.

Final checks and the final Jev gate are recorded in the ledger with their actual
outputs. Jev was used for source screening, risk ranking, hypothesis critique,
finding classification, claims, bounded implementation choice, expectation/UI
comparison, actual patch review and completion gating. The first patch review
escalated: correctness confidence 0.22, safe-to-apply 0.45, composite 0.647.
It was not a pass. Host source inspection and stronger runtime evidence checked
the changed boundaries, and the reattack found F5 before final verification.
F4's arithmetic was independently resolved by deterministic success/failure
fixtures, not the model's low-confidence interpretation.

Jev's F5 comparison strongly identified missing actionable setup guidance
(contradiction 0.91, confidence 0.86), but its overall and other aspects remained
uncertain. The actual early return, red tests and rebuilt UI resolve that narrow
finding. Raw judgments remain linked in the ledger; model agreement is never
independent proof.

Final measurements: 3,647 unit tests / 298 files, all static gates, 143/143 browser
tests, and the rebuilt Docker image's direct replay before and after restart.
The full final Jev payload exceeded the provider token limit. Four focused gates
all escalated (safe-to-apply 0.12–0.41); they were not silently accepted. Host
source review resolved patch uncertainty. Fresh named regressions and exact
current CLI output resolved the entry/probe claim disagreements; Jev then verified
those current results at confidence 0.89/0.99. See the ledger for distributions,
the unfavorable results, and the explicit stronger-review disposition.

The active local investigation and verification ran approximately 10:16–10:55
EDT, within the initial one-hour working budget; required PR and main CI follow
as the repository's publication gate. Disposable runtime resources were removed.

Remaining limits: no live paid model research, external account flows, production
Workspace mutation, multi-user/auth security assessment, cross-platform matrix,
or exhaustive anonymous-provider validation. The corpus is a coverage proxy;
this teardown does not certify greatest possible internet recall. Anonymous
access can change and one initial LOC probe timed out before later successful
attempts. Claims are limited to observed responses and controlled regressions.
