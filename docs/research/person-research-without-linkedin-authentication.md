# Person Research Without LinkedIn Authentication: Architecture, Legal Grounding, and Remediation Roadmap

**Document:** `docs/research/person-research-without-linkedin-authentication.md` 
**Status:** Working Research & Remediation Architecture 
**Date:** 2026-09-17 
**Context:** Remediating Issue
[#423](https://github.com/nicolas-found42/chief-of-staff-demo/issues/423) ("LinkedIn: resolve
anonymous HTTP 999 authentication-wall access for three Person Profiles") and establishing the
long-term architecture for Person Profile research without LinkedIn credentials. 
**Related Documents & ADRs:**
- Prior research: [`docs/research/linkedin-reading-options.md`](linkedin-reading-options.md),
  [`docs/research/person-source-eligibility.md`](person-source-eligibility.md),
  [`docs/research/public-search-providers.md`](public-search-providers.md)
- Architectural Decisions: [ADR-0042](../adr/0042-person-profiles-are-workspace-resources.md),
  [ADR-0049](../adr/0049-public-search-fans-out-over-independent-keyless-providers.md),
  [ADR-0062](../adr/0062-person-profiles-are-automatically-researched-dossiers.md),
  [ADR-0072](../adr/0072-common-crawl-capture-retrieval-is-excluded.md),
  [ADR-0097](../adr/0097-a-published-person-claim-must-be-about-the-subject.md)
- Codebase implementations:
  [`apps/server/src/person-profile/identifier.ts`](../../apps/server/src/person-profile/identifier.ts),
  [`apps/server/src/person-profile/sources.ts`](../../apps/server/src/person-profile/sources.ts),
  [`apps/server/src/person-profile/research-readers.ts`](../../apps/server/src/person-profile/research-readers.ts),
  [`apps/server/src/person-profile/research-plan.ts`](../../apps/server/src/person-profile/research-plan.ts),
  [`apps/server/src/person-profile/research.ts`](../../apps/server/src/person-profile/research.ts)

---

## Executive Summary

The central question put to this investigation is: **"How can we achieve our intended outcome of
Person Profile research without LinkedIn authentication?"**

The short answer is that **LinkedIn was never the intended outcome; LinkedIn was merely one
intermediary surface.** The intended outcome is establishing verified identity (full name, role,
employer, public handles), acquiring primary evidence across career milestones, publications,
talks, and institutional records, and compiling structured claims with verbatim citations and
capture dates to enable downstream workspace workflows (such as Meeting Brief Generator and
Content Research).

In Issue [#423](https://github.com/nicolas-found42/chief-of-staff-demo/issues/423), three
anonymous requests to LinkedIn profile URLs (`richardachee`, `joseceresc`,
`shaye-james-b85087143`) returned HTTP 999 responses redirecting to `/authwall`. The
application's diagnostic layer correctly classified these as `login-required` with `access:
blocked`
([`research-readers.ts:2350-2358`](../../apps/server/src/person-profile/research-readers.ts)).
However, because the research engine previously relied on fetching the LinkedIn HTML page to
extract the person's `<title>` tag when only a profile URL was provided, the failure to read the
URL left `profile.fullName` as `null`. Consequently, `seedQueries()` emitted **zero** queries
([`research-plan.ts:302-318`](../../apps/server/src/person-profile/research-plan.ts)),
completely stalling the research operation.

This research establishes five concrete, fully compliant strategies to achieve the intended
outcome without authenticating to LinkedIn:
1. **URL/Slug Index Resolution via Keyless Public Search:** Extracting name and employer hints
   directly from public search engine index metadata (`site:linkedin.com/in/<slug>` or
   `"linkedin.com/in/<slug>"`) without fetching LinkedIn servers directly, fixing the
   `seedQueries()` null-name gap.
2. **Multi-Registry Keyless Professional & Institutional Intelligence:** Exploiting established
   keyless public registries—Wikidata (including Property `P6634` LinkedIn slug lookup), ORCID
   Public API, OpenAlex, Crossref, DataCite, SEC EDGAR (Form 10-K, DEF 14A), DBLP, and
   ProPublica Nonprofit Explorer (Form 990).
3. **Open Web Personal & Publishing Footprint:** Reaching person-owned blogs, corporate
   leadership rosters, press releases, Substack newsletters, RSS/Atom feeds, Bluesky AT Protocol
   feeds, Mastodon ActivityPub endpoints, and podcast directories.
4. **Operator-Provided Permitted Artifacts:** Integrating local resumes, CVs, vCards, or
   user-supplied LinkedIn self-service data exports as private Workspace documents
   ([`research.ts:758-776`](../../apps/server/src/person-profile/research.ts)).
5. **Architectural Blueprints for Approved B2B Enrichment:** Defining the integration pattern
   for licensed third-party data providers (e.g., ReverseContact V2, People Data Labs) using
   module-scoped secrets
   ([`packages/shared/src/schemas.ts`](../../packages/shared/src/schemas.ts)) while upholding
   privacy boundaries and data provenance.

Every factual claim below is grounded in high-trust primary documentation, statutory and case
law, or repository source code.

---

## 1. Defining the Intended Outcome

### 1.1 The Actual Goal of Person Profile Research

To determine how to succeed without LinkedIn authentication, we must define what Person Profile
research actually accomplishes in this architecture:

1. **Identity Resolution:** Resolving unambiguous identity signals from sparse inputs—deriving
   canonical full name, aliases, verified email addresses, confirmed current employer, role, and
   public social/web identifiers
   ([ADR-0042](../adr/0042-person-profiles-are-workspace-resources.md)).
2. **Evidence Acquisition:** Gathering durable, multi-family evidence across seven source
   families:
   - `identity-affiliation` (e.g., ORCID, Wikidata)
   - `professional-records` (e.g., SEC EDGAR, NPPES, ClinicalTrials.gov)
   - `publication-records` (e.g., Crossref, OpenAlex, DataCite, DBLP)
   - `documents-publishers` (e.g., company websites, corporate bios, press releases, news
     articles)
   - `public-social` (e.g., Bluesky, Mastodon, public web references)
   - `historical-evidence` (e.g., Internet Archive Wayback Machine captures)
   - `workspace` (e.g., meeting transcripts, operator-uploaded documents)
3. **Structured Claim Extraction & Attribution:** Synthesizing factual claims categorized across
   eight dossier areas: Overview, Career, Work, Expertise, Ideas, Connections, Recognition, and
   Context ([ADR-0062](../adr/0062-person-profiles-are-automatically-researched-dossiers.md)).
   Every published claim must be grounded in retained source text, carrying an exact quote,
   source URL, and capture timestamp, while satisfying subject-attribution filters to prevent
   attributing namesake facts
   ([ADR-0097](../adr/0097-a-published-person-claim-must-be-about-the-subject.md)).
4. **Downstream Enablement:** Supplying clean, factual dossiers to downstream modules, notably
   Meeting Brief Generator (pre-meeting dossiers for attendees) and Content Research (tracking
   domain experts and collaborators).

At no point does the application contract require that a dossier contain a verbatim copy of a
LinkedIn profile page. The requirement is accurate, attributable evidence answering who the
person is and what they have done.

### 1.2 The Anatomy of Issue #423

On 2026-09-16, Issue [#423](https://github.com/nicolas-found42/chief-of-staff-demo/issues/423)
recorded three anonymous HTTP requests executed via the application's guarded transport:
- `https://www.linkedin.com/in/richardachee/` &rarr; HTTP 999 (1,038 ms)
- `https://www.linkedin.com/in/joseceresc/` &rarr; HTTP 999 (827 ms)
- `https://www.linkedin.com/in/shaye-james-b85087143/` &rarr; HTTP 999 (613 ms)

All three requests returned an identical 1,530-character HTML/JavaScript payload (SHA-256
`644031a68bde879af85bcc9cb3e6fa1e9a6b0f61d49307581974b5dbc09d3de8`) executing client-side
redirection:
```javascript
window.location.href = "https://" + domain + "/authwall?trk=" + trk;
```

In pull request [#422](https://github.com/nicolas-found42/chief-of-staff-demo/pull/422) (merged
into `main` at `03ebd33`), the diagnostic classifier in
[`apps/server/src/person-profile/research-readers.ts`](../../apps/server/src/person-profile/research-readers.ts)
was updated:
```typescript
const authRedirect =
  response?.status === 999 &&
  /(^|\.)linkedin\.com$/.test(host) &&
  /window\.location\.href\s*=[^;\n]*["']\/authwall\?/i.test(response.body);
const wallMarker = authRedirect
  ? "LinkedIn authentication-wall redirect"
  : response && !challenge
    ? detectSocialWallMarker(response.body)
    : null;
```
This correctly records a diagnostic failure with `stage: "access"`, `code: "login-required"`,
`outcome: "failed"`, and returns an unavailable result (`access: "blocked"`).

### 1.3 The Root Architectural Flaw: URL-Only Input vs. Name+URL Input

The real failure mode exposed by Issue #423 is not the HTTP 999 itself; it is how the research
loop responds to an unreadable seed URL when no full name was provided initially.

Consider the two user input paths:

#### Path A: Name + URL Provided (e.g. Richard Achee)
1. The profile is initialized with `fullName: "Richard Achee"` and `profileUrls:
   ["https://www.linkedin.com/in/richardachee/"]`.
2. In Round 1 of `PersonResearch.run`
   ([`research.ts:476`](../../apps/server/src/person-profile/research.ts)),
   `seedQueries(profile)` evaluates:
```typescript
export function seedQueries(profile: PersonProfile): string[] {
const name = profile.fullName?.trim();
const employer = profile.currentEmployer?.trim();
const seeds: string[] = [];
for (const email of profile.emails.slice(0, 2)) seeds.push(email);
if (name) {
seeds.push(employer ? `"${name}" ${employer}` : `"${name}"`);
seeds.push(`"${name}" biography role career`);
seeds.push(`"${name}" interview OR podcast OR talk`);
seeds.push(`"${name}" profile OR announcement OR appointment`);
seeds.push(`"${name}" publication OR filing OR registry OR award`);
for (const hint of profile.employerHints.slice(0, 2)) seeds.push(`"${name}" ${hint}`);
} else if (employer) {
seeds.push(employer);
}
return [...new Set(seeds.filter(Boolean))].slice(0, 8);
}
```
3. Because `name` is present, `seedQueries()` emits up to 7 discovery queries into `leads`.
4. While the seed URL `linkedin.com/in/richardachee/` is read in Round 1 and fails with HTTP 999
   `login-required`, the query leads execute in subsequent rounds.
5. Search providers (SearXNG, Google News, Bing News, OpenAlex, Crossref, etc.) return
   alternative sources: corporate announcements, interviews, GitHub repositories, and
   institutional articles.
6. **Observed Result in PR #444:** The Richard Achee research run completed end-to-end against
   live OpenRouter `inception/mercury-2.5`, publishing **8 verified claims with citations and 1
   grounded work record**, despite LinkedIn completely blocking direct access!

#### Path B: URL-Only Provided (e.g. `linkedin.com/in/joseceresc/`)
1. The operator inputs `linkedin.com/in/joseceresc/`.
2. `parsePersonIdentifier()`
   ([`identifier.ts:70-74`](../../apps/server/src/person-profile/identifier.ts)) yields:
```typescript
signals.profileUrls = ["https://www.linkedin.com/in/joseceresc"];
signals.handles = { linkedin: ["joseceresc"] };
signals.fullNames = [];
```
Initial `profile.fullName` is `null`.
3. In `PersonResearch.run`
   ([`research.ts:520-536`](../../apps/server/src/person-profile/research.ts)), the engine
   delays general discovery search queries to allow the seed URL to supply the proper name:
> *"A Profile's own URL is read before any query though (spec: the URL slug abbreviates the name
— 'joseceresc' — while the page it serves carries the proper one, so the name every later search
uses has to come from the read, not the handle). While such a lead is still pending, discovery
waits one round; the read happens this round's selection below."*
4. The seed URL is read via `readSocial()` &rarr; returns HTTP 999 `/authwall`.
5. `read.access` is `"blocked"`. `read.text` is empty. The lead is marked `inaccessible`.
6. Because access is gated on that attempt, no HTML `<title>` tag is available from that fetch
   to populate `fullName`. (Note: As recorded in Issue #423's implementation comment, upstream
   access is time-varying and per-request: a subsequent authorized probe of Jose returned
   partially readable HTML with an experience-section login limitation. The failure is not that
   title extraction can never work, but that a gated request leaves the operation with no name
   anchor.)
7. When `seedQueries(profile)`
   ([`research-plan.ts:302-318`](../../apps/server/src/person-profile/research-plan.ts))
   evaluates:
   - `profile.fullName` is `null`
   - `profile.emails` is `[]`
   - `profile.currentEmployer` is `null`
   - `seedQueries(profile)` returns **`[]` (an empty array)**.
8. While `publicQueries(signals)` in
   [`sources.ts:167`](../../apps/server/src/person-profile/sources.ts) does emit `"${url}"` for
   candidate intake, the *research operation's* query queue in `research-plan.ts:seedQueries`
   emits no queries when `fullName` is null.
9. **Inferred Code-Path Consequence:** If no name was supplied and the seed read is gated,
   `leads.pending()` contains zero queries and zero URLs. The operation reaches the end of its
   pending work without discovering alternative sources, solely because `seedQueries()` did not
   emit identity bootstrap queries for the profile URL or handle.
---

## 2. Why LinkedIn Authentication is Prohibited and Unavailable

Proposals to solve Issue #423 by logging in, passing session cookies, or automating browser
sessions are dead on arrival across technical, legal, and architectural dimensions.

### 2.1 Official LinkedIn API Constraints

Primary Source: Microsoft Learn — LinkedIn Developer Documentation 
- Getting Access:
  <https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access> 
- OpenID Connect:
  <https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2>
- Community Management API:
  <https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview>
- Posts API:
  <https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api> 
- Sales Navigator (SNAP): <https://learn.microsoft.com/en-us/linkedin/sales/sales-navigator> 
- Member Data Portability:
  <https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/member-data-portability-member/>

The official developer surface is strictly bifurcated:

| Permission Tier | Specific Permissions | Capability & Scope | Applicability to 3rd-Party Research |
| :--- | :--- | :--- | :--- |
| **Open Permissions** (Self-serve) | `openid`, `profile`, `email`, `w_member_social` | Retrieves the *authenticated user's own* basic name, headline, photo, and email address; writes posts on their behalf. | **None.** Cannot read third-party profiles, experience, education, or posts. |
| **Closed Permissions** | `r_member_social` | Retrieves member posts, comments, likes. | **Closed.** Microsoft documentation states verbatim: *"r_member_social is a closed permission. We're not accepting access requests at this time due to resource constraints."* |
| **Partner-Gated (SNAP)** | `r_sales_nav_profiles`, `r_sales_nav_analytics` | Accesses matched public member profiles for enterprise CRM/sales tools. | **Inaccessible.** Requires approval as a Sales Navigator Application Platform partner, commercial agreements, and customer Sales Navigator seat licenses. |
| **DMA Member Portability** | `r_dma_portability_self_serve` | Fetches historical snapshot of a member's own activity (`MEMBER_SHARE_INFO`). | **Inapplicable.** Hard geographic gate: EEA and Switzerland residents only. Self-serve for own member data only. |

**Primary Conclusion:** There is no official LinkedIn API—open, standard, or vetted—that allows
an independent software tool to look up arbitrary third-party member profiles.

### 2.2 Contractual & Legal Prohibitions

Primary Sources:
- LinkedIn User Agreement § 8.2 (Effective November 3, 2025):
  <https://www.linkedin.com/legal/user-agreement>
- LinkedIn API Terms of Use (Effective January 13, 2023):
  <https://www.linkedin.com/legal/l/api-terms-of-use>
- LinkedIn `robots.txt`: <https://www.linkedin.com/robots.txt>
- *hiQ Labs, Inc. v. LinkedIn Corp.*, No. 17-16783 (9th Cir. Apr. 18, 2022):
  <https://cdn.ca9.uscourts.gov/datastore/opinions/2022/04/18/17-16783.pdf>
- *hiQ Labs, Inc. v. LinkedIn Corp.*, No. 3:17-cv-03301-EMC (N.D. Cal.): Summary Judgment Order
  Dkt. 404 (Oct. 27, 2022), Consent Judgment and Permanent Injunction Dkt. 406 (Dec. 8, 2022):
  <https://storage.courtlistener.com/recap/gov.uscourts.cand.312704/>

#### User Agreement § 8.2 ("Don'ts")
Users expressly agree not to:
1. *"Develop, support or use software, devices, scripts, robots or any other means or processes
   (such as crawlers, browser plugins and add-ons or any other technology) to scrape or copy the
   Services"*
2. *"Override any security feature or bypass or circumvent any access controls or use limits of
   the Services"*
3. *"Copy, use, display or distribute any information (including content) obtained from the
   Services, whether directly or through third parties (such as search tools or data aggregators
   or brokers), without the consent of the content owner"*
4. *"Use bots or other unauthorized automated methods to access the Services..."*

Clause 3 is particularly binding: it explicitly bars acquiring data derived from LinkedIn via
third-party brokers or aggregators without consent.

#### The *hiQ v. LinkedIn* Precedent
The common industry folklore that *hiQ v. LinkedIn* legalized web scraping is completely
contradicted by the actual docket records:
- **9th Circuit Ruling (2022):** Decided only that accessing public data without authentication
  likely did not violate the Computer Fraud and Abuse Act (CFAA) § 1030 for preliminary
  injunction purposes. The court explicitly noted that common law claims, including **breach of
  contract** and trespass to chattels, remained fully actionable.
- **District Court Summary Judgment (Dkt. 404, Oct 27, 2022):** Judge Edward M. Chen ruled at
  page 12: *"In sum, the relevant language of the User Agreement unambiguously prohibits hiQ's
  scraping and unauthorized use of the scraped data."*
- **Final Consent Judgment & Permanent Injunction (Dkt. 406, Dec 8, 2022):** Judgment in the
  amount of **$500,000** entered against hiQ in favor of LinkedIn. The court permanently
  enjoined hiQ from accessing or copying data from LinkedIn in violation of the User Agreement:
> *(i) using automated means to access and/or copy data from the LinkedIn platform, **whether
logged in to a LinkedIn account or not**, without express written permission of LinkedIn...*
HiQ was ordered to permanently destroy all scraping software and all LinkedIn-derived data.

#### `robots.txt`
LinkedIn's served `robots.txt` specifies:
```
User-agent: *
Disallow: /
```
While commercial search engine spiders (`Googlebot`, `Bingbot`) have specific crawl allowances,
all generic automated clients are explicitly disallowed across the entire host.

### 2.3 Application Architecture & Ethics Governance

The application's fundamental architecture forbids authentication circumvention:
- **ADR-0042:** *"Direct authenticated scraping, imported browser sessions, CAPTCHA bypass, and
  control evasion are not Person Profile sources. LinkedIn evidence may enter through public
  indexing or an explicitly authorized provider..."*
- **ADR-0049:** Establishes public web search as an anonymous fan-out over independent keyless
  providers. *"No cookies, no imported sessions, no CAPTCHA bypass — public results stay
  untrusted Source-Item-class input."*
- **Issue #230 & `tests/src/unit/source-eligibility.test.ts`:** A strict automated test suite
  walks every reachable research route and fails if any route requires an API key, payment, user
  sign-in, imported session, or paid proxy.
- **Issue #256:** Mandates that authentication walls must be recorded as factual access
  limitations rather than bypassed.

Any proposal to inject `li_at` cookies, deploy headless browser login bots, or route requests
through residential proxy networks violates the core tenets of this repository.

---

## 3. Concrete Strategies Without LinkedIn Authentication

To achieve the intended outcome without LinkedIn authentication, the application must diversify
its identity resolution, registry intelligence, and open web discovery.

```
                    ┌──────────────────────────────────────────────┐
                    │    Operator Input: Profile URL or Name       │
                    │   e.g. linkedin.com/in/joseceresc/           │
                    └──────────────────────┬───────────────────────┘
                                           │
                    ┌──────────────────────▼───────────────────────┐
                    │    STRATEGY 1: Search Index Resolution       │
                    │   Query: site:linkedin.com/in/joseceresc     │
                    │   Target: SearXNG, Bing, Google News, DDG    │
                    └──────────────────────┬───────────────────────┘
                                           │ Resolves SERP Title:
                                           │ "Jose Ceres - Senior Engineer | LinkedIn"
                                           │ -> fullName: "Jose Ceres"
                                           │ -> employerHints: ["Senior Engineer"]
                                           │
         ┌─────────────────────────────────┴─────────────────────────────────┐
         │                                                                   │
┌────────▼────────────────────────┐                               ┌──────────▼────────────────────────┐
│ STRATEGY 2: Keyless Registries  │                               │ STRATEGY 3: Open Web Footprint    │
├─────────────────────────────────┤                               ├───────────────────────────────────┤
│ • Wikidata (P6634 Slug lookup)  │                               │ • Company Leadership / Team Pages │
│ • ORCID Public API (Bio/Works)  │                               │ • Personal Blogs & Substacks      │
│ • OpenAlex (Author/Affiliation) │                               │ • Bluesky AT Protocol (public)    │
│ • Crossref / DataCite (DOIs)    │                               │ • Press Releases & News RSS       │
│ • SEC EDGAR (10-K, DEF 14A)     │                               │ • Mastodon ActivityPub            │
│ • ProPublica 990 (Nonprofit)    │                               │ • Podcasts & Interview Transcripts│
└────────────────┬────────────────┘                               └──────────────────┬────────────────┘
                 │                                                                   │
                 └─────────────────────────────────┬─────────────────────────────────┘
                                                   │
                                  ┌────────────────▼────────────────┐
                                  │   Dossier Extraction Pipeline   │
                                  │  • Strict Subject Check (#0097) │
                                  │  • Retain Source Documents      │
                                  │  • Publish Grounded Claims      │
                                  └─────────────────────────────────┘
```

---

### Strategy 1: URL/Slug Index Resolution via Keyless Public Search

#### The Mechanism
Search engines crawl and index public LinkedIn profiles. Even when LinkedIn serves an HTTP 999
response to our IP, Google, Bing, SearXNG, DuckDuckGo, and Mojeek maintain indexed
representations of those public profiles.

Crucially, the search engine's indexed `<title>` tag consistently adopts the pattern:
```
<Full Name> - <Role / Employer> | LinkedIn
```
or
```
<Full Name> – <Role> at <Company> | LinkedIn
```

When an operator provides `https://www.linkedin.com/in/joseceresc/`, we do not need to fetch
`linkedin.com`. Instead, we query public search engines for the exact URL or slug:
```
site:linkedin.com/in/joseceresc
```
or
```
"linkedin.com/in/joseceresc"
```

The search engine result arrives as a standard `PublicSearchResult`:
```json
{
  "title": "Jose Ceres - Senior Platform Engineer - CloudScale | LinkedIn",
  "url": "https://www.linkedin.com/in/joseceresc",
  "snippet": "View Jose Ceres’ profile on LinkedIn, a professional community of 1 billion members..."
}
```

#### The Issue #423 Boundary: Signals vs. Content
**Critical Rule from Issue #423:** *"Never treat search snippets or a sign-in shell as the
missing profile content."*

A search engine result title or snippet must **never** be retained as a source document or
parsed directly into career claims. Instead, per
[ADR-0042](../adr/0042-person-profiles-are-workspace-resources.md) and
[ADR-0097](../adr/0097-a-published-person-claim-must-be-about-the-subject.md), SERP metadata
serves strictly as an **Identity Signal**:
1. The parsed title yields a candidate name (`"Jose Ceres"`) and employer hint (`"CloudScale"`).
2. These candidate signals unblock subsequent discovery queries in the research loop.
3. Any claims published in the dossier must be extracted from actual retrieved third-party
   source documents (e.g. corporate leadership rosters, SEC filings, conference programs,
   published articles) that pass `decideIdentity()` subject-attribution checks. A snippet is
   never a substitute for missing primary text.

#### Narrow Scope of the Query Code Gap
It is important to be precise about where the code gap is and is not:
- In
  [`apps/server/src/person-profile/sources.ts:167`](../../apps/server/src/person-profile/sources.ts),
  `publicQueries()` *already* queries the profile URL verbatim (`for (const url of
  signals.profileUrls.slice(0, 2)) queries.push(`"${url}"`)`) during initial candidate
  harvesting in `createPublicWebPersonProfileSource()`.
- The specific gap lies in
  [`apps/server/src/person-profile/research-plan.ts:302-318`](../../apps/server/src/person-profile/research-plan.ts)
  (`seedQueries()`), which drives the *research operation's active query queue*
  ([`research.ts:476`](../../apps/server/src/person-profile/research.ts)). Because
  `seedQueries()` only evaluates `profile.fullName`, `profile.emails`, and
  `profile.currentEmployer`, it emits `[]` when only a profile URL was provided, leaving the
  operation with no queries to run once the direct URL read is gated.
```typescript
// CURRENT DEFECTIVE CODE IN research-plan.ts
export function seedQueries(profile: PersonProfile): string[] {
  const name = profile.fullName?.trim();
  const employer = profile.currentEmployer?.trim();
  const seeds: string[] = [];
  for (const email of profile.emails.slice(0, 2)) seeds.push(email);
  if (name) {
    seeds.push(employer ? `"${name}" ${employer}` : `"${name}"`);
    // ... name-based queries ...
  } else if (employer) {
    seeds.push(employer);
  }
  return [...new Set(seeds.filter(Boolean))].slice(0, 8);
}
```
When `fullName` is null, this function returns `[]`.

#### The Remediation
When `profile.fullName` is null, `seedQueries()` must inspect `profile.profileUrls` and extract
LinkedIn/social handles, generating search queries specifically designed to resolve the person's
identity:
```typescript
// REMEDIATED PATTERN FOR research-plan.ts
export function seedQueries(profile: PersonProfile): string[] {
  const name = profile.fullName?.trim();
  const employer = profile.currentEmployer?.trim();
  const seeds: string[] = [];
  for (const email of profile.emails.slice(0, 2)) seeds.push(email);
  if (name) {
    seeds.push(employer ? `"${name}" ${employer}` : `"${name}"`);
    seeds.push(`"${name}" biography role career`);
    seeds.push(`"${name}" interview OR podcast OR talk`);
    seeds.push(`"${name}" profile OR announcement OR appointment`);
    seeds.push(`"${name}" publication OR filing OR registry OR award`);
    for (const hint of profile.employerHints.slice(0, 2)) seeds.push(`"${name}" ${hint}`);
  } else {
    // Identity bootstrap queries for URL-only profiles:
    for (const url of profile.profileUrls.slice(0, 2)) {
      const parsed = socialUrl(url);
      if (parsed?.platform === "linkedin" && parsed.handle) {
        seeds.push(`site:linkedin.com/in/${parsed.handle}`);
        seeds.push(`"linkedin.com/in/${parsed.handle}"`);
      } else {
        seeds.push(`"${url}"`);
      }
    }
    if (employer) seeds.push(employer);
  }
  return [...new Set(seeds.filter(Boolean))].slice(0, 8);
}
```

When the search result returns, a regex parser in
[`sources.ts`](../../apps/server/src/person-profile/sources.ts) or
[`research.ts`](../../apps/server/src/person-profile/research.ts) unpacks the title:
```typescript
const match = /^(.+?)\s*[-–—]\s*(.+?)\s*\|\s*LinkedIn/i.exec(result.title);
if (match) {
  const candidateName = match[1]?.trim();
  const candidateRoleOrEmployer = match[2]?.trim();
  // Immediately update profile.fullName to unlock full discovery!
}
```
This enables full downstream discovery across all other providers without ever making a network
request to `linkedin.com`.

---

### Strategy 2: Multi-Registry Keyless Professional & Institutional Intelligence

The application already includes production search adapters and record readers for verified,
high-trust, keyless registries
([ADR-0049](../adr/0049-public-search-fans-out-over-independent-keyless-providers.md),
[`person-source-eligibility.md`](person-source-eligibility.md)).

| Registry / Source | Access Route & Primary Spec | Data Contributed to Dossier | Verified Anonymous Status |
| :--- | :--- | :--- | :--- |
| **Wikidata** | `https://www.wikidata.org/w/api.php` via `wbsearchentities` & SPARQL | Maps LinkedIn slugs (`Property:P6634`), employers (`P108`), roles (`P106`), education (`P69`), and canonical birth/biography data. | **Verified HTTP 200** keyless ([`wikidata.ts`](../../apps/server/src/source-adapters/providers/wikidata.ts)) |
| **ORCID** | `https://pub.orcid.org/v3.0/` ([API Tutorials](https://info.orcid.org/documentation/api-tutorials/)) | Unauthenticated public API. Authoritative affiliations, employments, education, and external `researcher-url` entries (often linking personal websites and LinkedIn profiles). | **Verified HTTP 200** keyless ([`orcid.ts`](../../apps/server/src/source-adapters/providers/orcid.ts)) |
| **OpenAlex** | `https://api.openalex.org/authors` ([OpenAlex API Guide](https://help.openalex.org/api/authentication/)) | CC0 scholar graph. Institutional affiliations, publication history, co-authorship networks, and citation metrics. | **Verified HTTP 200** keyless ([`openalex.ts`](../../apps/server/src/source-adapters/providers/openalex.ts)) |
| **Crossref & DataCite** | `api.crossref.org/works` & `api.datacite.org/dois` | Bibliographic metadata for papers, books, datasets, and software releases. | **Verified HTTP 200** keyless ([`person-records.ts`](../../apps/server/src/source-adapters/providers/person-records.ts)) |
| **SEC EDGAR** | `https://efts.sec.gov/LATEST/search-index` ([SEC Developer Guide](https://www.sec.gov/edgar/searchedgar/accessing-edgar-data.htm)) | Annual Form 10-K and Proxy Statement DEF 14A filings. Unambiguous, legally sworn disclosures of executive officer and director positions, bios, and compensation. | **Verified HTTP 200** with declared User-Agent ([`edgar.ts`](../../apps/server/src/source-adapters/providers/edgar.ts)) |
| **ProPublica Nonprofit Explorer** | `projects.propublica.org/nonprofits/api/v2/` | IRS Form 990 filings for 501(c) organizations. Trustees, executive directors, officers, and governance connections. | **Verified HTTP 200** keyless ([`person-records.ts:250`](../../apps/server/src/source-adapters/providers/person-records.ts)) |
| **DBLP** | `https://dblp.org/search/publ/api` | Complete computer science bibliography, conferences, and journals. | **Verified HTTP 200** keyless ([`dblp.ts`](../../apps/server/src/source-adapters/providers/dblp.ts)) |
| **GitHub Users** | `https://api.github.com/search/users` ([GitHub REST API Docs](https://docs.github.com/en/rest/users)) | Keyless public user search (60 requests/hour unauthenticated). Bio, company, location, public repositories, and blog URLs. | **Verified HTTP 200** keyless ([`github-users.ts`](../../apps/server/src/source-adapters/providers/github-users.ts)) |
| **CMS NPPES** | `https://npiregistry.cms.hhs.gov/api/` | US National Provider Identifier registry. Certified healthcare credentials, medical licenses, and hospital affiliations. | **Verified HTTP 200** keyless ([`person-records.ts:191`](../../apps/server/src/source-adapters/providers/person-records.ts)) |
| **ClinicalTrials.gov** | `https://clinicaltrials.gov/api/v2/studies` | Clinical study records naming principal investigators, sponsors, and research protocols. | **Verified HTTP 200** keyless ([`person-records.ts:227`](../../apps/server/src/source-adapters/providers/person-records.ts)) |

#### Exploiting Wikidata P6634 ("LinkedIn Personal Profile ID")
Wikidata maintains Property `P6634` (<https://www.wikidata.org/wiki/Property:P6634>). For
notable individuals, researchers, and public figures, Wikidata directly associates their
LinkedIn slug with their Wikidata entity.

A keyless SPARQL query to `https://query.wikidata.org/sparql`:
```sparql
SELECT ?person ?personLabel ?employerLabel ?occupationLabel WHERE {
  ?person wdt:P6634 "joseceresc" .
  OPTIONAL { ?person wdt:P108 ?employer . }
  OPTIONAL { ?person wdt:P106 ?occupation . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
```
This query maps the slug `joseceresc` directly to the individual, their employer, and their
occupation, without touching LinkedIn.

---

### Strategy 3: Open Web Personal & Publishing Footprint

Rather than viewing social media walled gardens as the primary truth, the research pipeline
prioritizes surfaces that the person actually owns or publishes on:

1. **Company Team & Leadership Pages:** Corporate "About Us" and "Team" rosters provide verified
   employment and executive titles.
2. **Personal Websites & Blogs:** Typically located on custom domains, GitHub Pages, or
   Substack. The application's `discoverFeeds()` engine
   ([`apps/server/src/source-adapters/feeds.ts`](../../apps/server/src/source-adapters/feeds.ts))
   automatically harvests RSS and Atom feeds declared by candidate sites
   ([`sources.ts:287-306`](../../apps/server/src/person-profile/sources.ts)).
3. **Substack Newsletters:** Substack publishes unauthenticated web pages and RSS feeds
   (`<subdomain>.substack.com/feed`), allowing the extraction of long-form articles, opinions,
   and author bios.
4. **Bluesky & the AT Protocol:** Bluesky provides public, unauthenticated AppView endpoints
   (`https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed`). The reader
   ([`research-readers.ts:2506-2532`](../../apps/server/src/person-profile/research-readers.ts))
   directly fetches author feeds, with post-level author and repost attribution.
5. **Mastodon & ActivityPub:** Unauthenticated account endpoints
   (`https://<instance>/api/v1/accounts/lookup?acct=<user>`) yield public statuses and
   biographical notes.
6. **Press Releases & Media:** Bing News RSS and Google News RSS provide timely, unauthenticated
   coverage of appointments, funding announcements, and speaking engagements.
7. **Spoken Media:** Apple podcast directory searches
   (`performance-partners.apple.com/search-api`) identify guest appearances and interview
   episodes.

---

### Strategy 4: Operator-Provided Permitted Artifacts (Supplied Exports)

Where public web evidence is sparse or behind access walls, the application architecture already
supports **Workspace Private Documents**
([ADR-0042](../adr/0042-person-profiles-are-workspace-resources.md),
[`research.ts:758-776`](../../apps/server/src/person-profile/research.ts)).

#### Supported Ingestion Paths
1. **Resume / CV Document Upload:** An operator can attach a PDF, Markdown, or text document
   containing the person's resume or curriculum vitae.
2. **vCard / Contact Cards:** Standard `.vcf` contact files containing name, email,
   organization, title, and social links.
3. **Meeting Invites / Calendar Notes:** Structured meeting invitations from Google Calendar or
   Outlook containing attendee bios and roles.
4. **User-Provided LinkedIn Data Export (Lawfully Entitled):** A user or subject can download
   their own personal data archive directly from LinkedIn's self-service export portal
   (<https://www.linkedin.com/mypreferences/d/download-my-data>). This is strictly scoped to the
   operator's own profile or data provided directly with the subject's explicit consent; a third
   party's self-service export cannot be obtained or ingested without permission. The archive
   format includes `Positions.csv`, `Education.csv`, and `Profile.csv`.
#### Code Integration
In
[`apps/server/src/person-profile/research.ts:759-776`](../../apps/server/src/person-profile/research.ts):
```typescript
if (privateDocument) {
  read = {
    text: privateDocument.text.slice(0, 500000),
    capturedAt: null,
    completeness: privateDocument.text.length > 500000 ? "partial" : "full",
    access: "retrieved",
    outboundUrls: [],
    family: "workspace",
    route: "workspace-transcript",
    upstreamIndex: null,
    publishedAt: null,
    author: null,
    anchors: [],
    provenanceNote: "A Workspace Transcript confirmed for this Profile.",
    sourceVersion: null,
    rights: null,
    finalUrl: pending.url,
  };
}
```
Such documents are attributed directly to the `workspace` family. They provide 100% compliant,
first-party verified baseline evidence without requiring any external network requests.

---

### Strategy 5: Architecture for Approved Third-Party Enrichment (If Licensed)

If the workspace operator chooses to license an approved B2B commercial enrichment provider, the
codebase already has a proven architectural pattern for module-scoped third-party credentials.

#### 1. The Precedent: `guestProfile` Pattern
Meeting Brief Generator previously integrated third-party guest lookups via a module-scoped
schema in [`packages/shared/src/schemas.ts:166`](../../packages/shared/src/schemas.ts) and
[`apps/server/src/config.ts:212-214`](../../apps/server/src/config.ts):
```typescript
guestProfile: z.object({
  endpoint: z.string().url(),
  apiKey: z.string().min(1),
  lastVerifiedAt: z.string().datetime().nullable(),
  lastCheckAt: z.string().datetime().nullable(),
  lastCheckState: z.enum(["connected", "unreachable", "invalid-key"]),
  lastCheckDetail: z.string().nullable(),
})
```

#### 2. Commercial Enrichment Candidates
As evaluated in [`linkedin-reading-options.md:438-463`](linkedin-reading-options.md):
- **ReverseContact / Visum SAS (<https://reversecontact.com>):**
  - Live B2B enrichment API (`https://api.reversecontact.com/v2/`).
  - Terms: Visum SAS, French law. Visum acts as an independent controller.
  - Capability: Person & Company Enrichment by email or LinkedIn URL. Note: Visum permanently
    retired post/activity scraping endpoints on July 1, 2026, but core B2B profile enrichment
    remains active.
- **People Data Labs (PDL) (<https://www.peopledatalabs.com>):**
  - Enterprise person-enrichment API with resume/workforce datasets.
- **Coresignal (<https://coresignal.com>):**
  - Certified by Ethical Web Data Collection Initiative. Provides structured employee and
    company records.

#### 3. Architectural Rules for External Enrichment
If an approved provider is configured:
1. **Module-Scoped Secret Management:** The API key must be declared in module config, validated
   via health check endpoints, and registered in `redactConfig` in
   [`apps/server/src/config.ts:203-230`](../../apps/server/src/config.ts) to ensure keys never
   leak into logs or client-facing JSON.
2. **Explicit Data Provenance:** Records ingested from a third-party vendor must carry `source:
   "b2b-enrichment"` and `provenanceNote: "Enriched via licensed B2B provider <VendorName>"`.
3. **Transparent Match Confidence:** Enrichment data must pass the same
   `PersonResearch.decideIdentity()` gates as public documents, requiring name or email
   corroboration.
4. **Graceful Fallback:** If the enrichment quota is exhausted (HTTP 429), the API key is
   revoked, or the vendor is unreachable, the pipeline must fall back cleanly to keyless public
   search and multi-registry discovery without halting the research operation.

---

## 4. Acceptance & Remediation Plan for Issue #423

To resolve Issue #423 cleanly without waiting for LinkedIn's anonymous HTTP 999 response to
disappear, the following engineering steps must be executed:

### 4.1 Implementation Roadmap

| Task | File Target | Remediation Action |
| :--- | :--- | :--- |
| **Step 1: Expand Seed Queries for URL-only Inputs** | `apps/server/src/person-profile/research-plan.ts` | Update `seedQueries(profile)`: when `profile.fullName` is null, inspect `profile.profileUrls` and `profile.handles`. Emit `site:linkedin.com/in/<slug>` and `"linkedin.com/in/<slug>"` so public search providers can resolve the profile's indexed metadata. |
| **Step 2: Parse Identity Signals from Search SERPs** | `apps/server/src/person-profile/sources.ts` and `research.ts` | In `publicQueries()` and search result ingestion, parse standard LinkedIn title formats (`<Name> - <Role/Employer> \| LinkedIn`). Populate `profile.fullName` and `profile.employerHints` when discovered, unlocking subsequent research rounds. |
| **Step 3: Unblock Discovery on Authwall Encounter** | `apps/server/src/person-profile/research.ts` | In `PersonResearch.run()`, ensure that when a seed URL returns `access: "blocked"` with `login-required`, discovery queries are immediately unlocked and dispatched in the same or subsequent round rather than stalling. |
| **Step 4: Verify the Three Benchmark Profiles** | Test harness & isolated execution | Execute end-to-end research runs for: <br>1. `https://www.linkedin.com/in/richardachee/`<br>2. `https://www.linkedin.com/in/joseceresc/`<br>3. `https://www.linkedin.com/in/shaye-james-b85087143/`<br>Verify that each profile resolves identity and compiles a grounded dossier via alternative sources. |

### 4.2 Acceptance Criteria for Closing Issue #423

1. **Deterministic Identity Resolution from URL Inputs:**
   - Creating a Person Profile with only a LinkedIn profile URL (e.g.
     `linkedin.com/in/joseceresc/`) must generate seed search queries targeting the URL and
     handle.
   - The search results must extract the subject's full name from indexed SERP titles and update
     `profile.fullName`.
2. **Zero Stalled Runs on HTTP 999:**
   - An HTTP 999 authentication-wall response on a seed URL must record a diagnostic failure
     (`login-required`), mark the single URL lead as `inaccessible`, and proceed with public
     search discovery.
   - The research operation must not terminate with 0 queries and 0 sources; it must fan out
     across the configured search providers.
3. ** Attributable Dossier Assembly:**
   - For all three URLs named in Issue #423, the research operation must compile a Person
     Dossier containing published claims with verbatim citations and capture dates sourced from
     open web pages, news articles, or registries.
4. **Zero Credential or Posture Regressions:**
   - No session cookies (`li_at`), automated logins, CAPTCHA bypasses, or paid proxy
     integrations may be introduced.
   - `tests/src/unit/source-eligibility.test.ts` and
     `tests/src/modules/person-research-social-walls.test.ts` must pass completely.

---

## 5. Multi-Source Community, Open Source & Academic Research Findings

To test and strengthen our architecture against the broader engineering and scientific state of
the art, five targeted investigations were executed across curated awesome lists, GitHub
repositories, Reddit practitioner communities, Stack Overflow / Stack Exchange, and arXiv
academic research.

### 5.1 Awesome Lists: Curated Tooling & Registries Filtered by Standing Acquisition Posture

Investigation across `awesome-osint`, `Awesome-Entity-Resolution`, `awesome-knowledge-graph`,
and `awesome-duckdb`.

**Repo Acquisition Filter
([ADR-0049](../adr/0049-public-search-fans-out-over-independent-keyless-providers.md), Issue
#230, Issue #423):** 
Any external tool or library that relies on authenticated sessions, session cookie injection
(`li_at`), residential proxy rotation, CAPTCHA bypasses, or undocumented private APIs is
**strictly rejected**. Only pure local-first algorithmic libraries (record linkage, name
parsing, schema extraction) and keyless public search patterns pass eligibility (#230).

1. **Eligible Local-First Record Linkage & Parsing Frameworks:**
   - **Splink**
     ([`moj-analytical-services/splink`](https://github.com/moj-analytical-services/splink)):
     Fast, probabilistic record linkage implementing the Fellegi-Sunter mathematical model
     backed by DuckDB and SQLite. Runs 100% locally without external network calls or
     credentials, enabling offline clustering of public records.
   - **Dedupe** ([`dedupeio/dedupe`](https://github.com/dedupeio/dedupe)): Active-learning
     record linkage for fuzzy matching and de-duplication with blocking rules.
   - **probablepeople**
     ([`datamade/probablepeople`](https://github.com/datamade/probablepeople)): Conditional
     Random Field (CRF) name parser that segments compound and international names into Prefix,
     GivenName, Surname, and Suffix tokens, preventing naive string splits from corrupting
     identity matching.
   - **html-metadata** ([`wikimedia/html-metadata`](https://github.com/wikimedia/html-metadata))
     & **Trafilatura** ([`trafilatura.readthedocs.io`](https://trafilatura.readthedocs.io/)):
     Pure parsers extracting Schema.org `Person` JSON-LD, Microdata, and OpenGraph metadata from
     unauthenticated web pages.
2. **Reconnaissance Patterns Evaluated & Filtered:**
   - **WhatsMyName** ([`whatsmyname.app`](https://whatsmyname.app/)) & **Maigret**
     ([`soxoj/maigret`](https://github.com/soxoj/maigret)): Check username availability and
     public profiles across hundreds of sites. While active bulk scanning across hundreds of
     hosts is excluded from our runtime pipeline to avoid new-host transport escalation (#230),
     the underlying principle—that public handles (`joseceresc`) often match across keyless
     platforms like GitHub, Mastodon, and personal blogs—validates using handle seeds in keyless
     search engine queries (`sources.ts`).
   - **Rejected Routes:** Commercial scraping wrappers, automated LinkedIn browser runners, and
     credentialed scrapers are recorded as explicit non-options.

### 5.2 GitHub Open Source Ecosystem: Real-World Implementations

1. **`Yomguithereal/talisman`** (<https://github.com/Yomguithereal/talisman>):
   - Pure TypeScript/JavaScript NLP and record linkage library.
   - Provides high-performance implementations of Jaro-Winkler, Monge-Elkan, Levenshtein, Double
     Metaphone, and Soundex.
   - **Direct application:** Drop-in enhancement for
     `apps/server/src/person-profile/resolver.ts` to replace naive lowercase substring checks
     with phonetic and token-set similarity.
2. **`m8sec/CrossLinked`** (<https://github.com/m8sec/CrossLinked>):
   - Reconnaissance tool that leverages Google and Bing search index results for
     `site:linkedin.com/in/` dorks without API keys or credentials.
   - Validates Strategy 1: parses indexed search engine titles (stripping trailing delimiters,
     splitting name and role/employer) to identify candidates without sending requests to
     LinkedIn.
3. **`dedupeio/dedupe`** (<https://github.com/dedupeio/dedupe>):
   - Implements *blocking predicates*—generating compact disjunctive normal form (DNF) blocking
     rules (e.g. `first_token(employer) & soundex(surname)`) that prune candidate comparison
     pairs from $O(N^2)$ to $O(N)$, allowing our dossier resolution engine to scale without
     latency penalties.

### 5.3 Practitioner Experiences & Industry Field Reports (Practitioner-Reported)

Observations gathered from practitioner discussions across `r/webscraping`, `r/OSINT`,
`r/AI_Agents`, `r/gtmengineering`, and `r/netsec` (2024–2026):

1. **The State of Direct Anonymous LinkedIn Scraping:**
   - *Practitioner-reported:* Developers widely report that LinkedIn's anti-bot infrastructure
     enforces JA4 TLS fingerprinting, HTTP/2 frame inspection, and Arkose Labs challenges on
     unauthenticated requests, frequently returning HTTP 999 redirects to `/authwall`.
   - *Practitioner-reported:* Unauthenticated scraping scripts and residential proxy pools
     experience severe failure rates (reported between 85% and 95%), reinforcing that direct
     scraping is technically fragile and operationally unviable.
2. **Industry Landscape and Vendor Attrition:**
   - *Practitioner-reported:* Community discussions highlight increasing legal and technical
     enforcement against unauthorized scraping vendors (such as reports of litigation and
     shutdowns affecting third-party scraping providers like Proxycurl in 2025).
   - Building core features on unauthorized third-party scrapers is widely viewed in the
     engineering community as an unsustainable operational risk.
3. **Deprecation of Legacy Workarounds:**
   - *Practitioner-reported:* Google's removal of the `cache:` search operator in early 2024 and
     retirement of the Mobile-Friendly Test tool closed off historical search-engine cache
     retrieval workarounds.
   - LinkedIn's `robots.txt` disallows archive bots, restricting public archive snapshots.
4. **Established Practitioner Alternatives:**
   - **SERP Metadata Harvesting:** Extracting public title and snippet metadata from search
     engines (Google, Bing, SearXNG, Mojeek) to obtain candidate identity signals without
     visiting the target social site.
   - **Cross-Referencing Keyless Registries:** Querying authoritative public registries (SEC
     EDGAR, OpenAlex, ORCID, GitHub, DBLP) that officially welcome automated access.
   - **Corporate Domain Ingestion:** Reading first-party company "About" and "Team" rosters,
     press releases, and conference speaker bios.

### 5.4 Stack Overflow & Stack Exchange: Algorithms & Best Practices

1. **Fellegi-Sunter Unsupervised Parameter Estimation:**
   - Discussions on Cross Validated ([Robin Linacre, *Cross Validated: Generating M/U
     Probabilities in
     Fellegi-Sunter*](https://stats.stackexchange.com/questions/71012/generating-m-u-probabilities-in-fellegi-sunter-record-linkage))
     outline how to estimate $u_i$ probabilities without labeled training data by sampling the
     Cartesian product of uncorrelated input records (where non-matches represent $>99.9\%$ of
     comparisons).
   - Agreement weight $w_i^+ = \log_2(m_i / u_i)$ and disagreement weight $w_i^- = \log_2((1 -
     m_i) / (1 - u_i))$ provide optimal mathematical bounds for match classification.
2. **SERP Title Parsing Patterns:**
   - Established regex patterns for Google and Bing indexed LinkedIn titles:
```typescript
const titleRegex1 = /^(.+?)\s*[-–—]\s*(.+?)\s*\|\s*LinkedIn$/i;
const titleRegex2 = /^(.+?)\s*[-–—]\s*(.+?)\s+at\s+(.+?)\s*\|\s*LinkedIn$/i;
```
3. **Schema.org JSON-LD Extraction:**
   - Querying all `<script type="application/ld+json">` elements and recursively walking
     `@graph` structures for objects with `@type: "Person"`, extracting `name`, `jobTitle`,
     `worksFor` (`name`), `alumniOf`, and `sameAs` URLs.
4. **Wikidata SPARQL Optimization:**
   - Avoid Cartesian joins on Blazegraph by binding Property `P6634` directly in the triple
     pattern and utilizing the Wikibase label service (`SERVICE wikibase:label { bd:serviceParam
     wikibase:language "en". }`).
5. **Circuit Breakers for HTTP 999:**
   - Recognizing HTTP 999 as a terminal refusal for that specific URL; failing fast without
     retries, cooling down the host, and routing the operation to independent search and
     registry providers.

### 5.5 Academic Research: arXiv Preprints

Two academic preprints from arXiv provide algorithmic and theoretical background for our Person
Profile research engine:

1. **`arXiv:2409.08966` — User Identity Linkage on Social Networks: A Review of Modern
   Techniques and Applications** 
*Caterina Senette, Marco Siino, Maurizio Tesconi (Sep 13, 2024)* 
   - URL: <https://arxiv.org/abs/2409.08966>
   - **Core Methodology:** This survey provides a comprehensive analysis of User Identity
     Linkage (UIL) across social networks. The survey reports prior work finding that 59% of
     users share the same username across social networks, and that username-string entropy
     materially affects linking likelihood. High-entropy usernames serve as robust,
     platform-agnostic identity anchors even without access to private social graph connections.
   - **Direct Application:** Validates Strategy 1 by confirming that public handle entropy (such
     as the slug `joseceresc` extracted from a profile URL) is a statistically reliable seed for
     cross-platform public search queries (`sources.ts`, `research-plan.ts`), allowing discovery
     of verified accounts on GitHub, Bluesky, or personal blogs.
2. **`arXiv:2401.03426` — On Leveraging Large Language Models for Enhancing Entity Resolution: A
   Cost-efficient Approach** 
*Huahang Li, Longyu Feng, Shuangyin Li, Fei Hao, Chen Jason Zhang, Yuanfeng Song (Jan 7, 2024)* 
   - URL: <https://arxiv.org/abs/2401.03426>
   - **Core Methodology:** Directly prompting LLMs to evaluate all pairwise combinations of
     entity records from heterogeneous sources results in $O(N^2)$ quadratic complexity,
     creating prohibitive latency and token cost. The authors develop an active uncertainty
     reduction framework: candidate entity pairs are first clustered using deterministic,
     low-cost blocking rules (e.g. token overlap, exact name keys). Only high-uncertainty
     boundary pairs are submitted to the LLM for natural-language verification.
   - **Direct Application:** Directly guides the optimization of
     `PersonResearch.decideIdentity()` in `research.ts`. Candidate web records retrieved during
     search fan-out are pre-filtered using deterministic rule-based checks (name tokens,
     employer domains); the LLM judge is reserved exclusively for borderline cases, maintaining
     high precision while respecting the local-first execution budget.

## 6. Primary Source Index

1. **LinkedIn Developer Portal & Microsoft Learn:**
   - LinkedIn API Access Overview:
     <https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access>
   - Sign In with LinkedIn using OpenID Connect:
     <https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2>
   - Posts API:
     <https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api>
   - Community Management Overview:
     <https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview>
   - Sales Navigator Integration (SNAP):
     <https://learn.microsoft.com/en-us/linkedin/sales/sales-navigator>
   - Member Data Portability API:
     <https://learn.microsoft.com/en-us/linkedin/dma/member-data-portability/member-data-portability-member/>
2. **Terms of Service & Robots Directives:**
   - LinkedIn User Agreement (Effective Nov 3, 2025):
     <https://www.linkedin.com/legal/user-agreement>
   - LinkedIn API Terms of Use (Effective Jan 13, 2023):
     <https://www.linkedin.com/legal/l/api-terms-of-use>
   - LinkedIn Robots Exclusion Standard: <https://www.linkedin.com/robots.txt>
3. **Statutory & Case Law (U.S. Federal Courts):**
   - *hiQ Labs, Inc. v. LinkedIn Corp.*, 31 F.4th 1180 (9th Cir. 2022):
     <https://cdn.ca9.uscourts.gov/datastore/opinions/2022/04/18/17-16783.pdf>
   - *hiQ Labs, Inc. v. LinkedIn Corp.*, No. 3:17-cv-03301-EMC (N.D. Cal.):
     - Summary Judgment Order (Dkt. 404):
       <https://storage.courtlistener.com/recap/gov.uscourts.cand.312704/gov.uscourts.cand.312704.404.0_1.pdf>
     - Consent Judgment and Permanent Injunction (Dkt. 406):
       <https://storage.courtlistener.com/recap/gov.uscourts.cand.312704/gov.uscourts.cand.312704.406.0.pdf>
4. **Public Registries & Protocols:**
   - Wikidata Property P6634 (LinkedIn personal profile ID):
     <https://www.wikidata.org/wiki/Property:P6634>
   - ORCID Public API v3.0 Documentation: <https://info.orcid.org/documentation/api-tutorials/>
   - OpenAlex API Documentation: <https://help.openalex.org/api/authentication/>
   - Crossref REST API: <https://www.crossref.org/documentation/retrieve-metadata/rest-api/>
   - DataCite REST API: <https://support.datacite.org/docs/api>
   - SEC EDGAR Search Index: <https://efts.sec.gov/LATEST/search-index>
   - DBLP Computer Science Bibliography:
     <https://dblp.org/faq/Am+I+allowed+to+crawl+the+dblp+website>
   - ProPublica Nonprofit Explorer API v2: <https://projects.propublica.org/nonprofits/api>
   - Bluesky AT Protocol Documentation: <https://docs.bsky.app/>
5. **Academic Research Papers (arXiv):**
   - Senette et al., *User Identity Linkage on Social Networks*, arXiv:2409.08966:
     <https://arxiv.org/abs/2409.08966>
   - Li et al., *On Leveraging Large Language Models for Enhancing Entity Resolution: A
     Cost-efficient Approach*, arXiv:2401.03426: <https://arxiv.org/abs/2401.03426>
6. **Open Source Repositories & Community Sources:**
   - Splink (Probabilistic Record Linkage): <https://github.com/moj-analytical-services/splink>
   - Talisman (JS/TS NLP & Metrics): <https://github.com/Yomguithereal/talisman>
   - Dedupe (Machine Learning Record Linkage): <https://github.com/dedupeio/dedupe>
   - CrossLinked (SERP LinkedIn Dork Parser): <https://github.com/m8sec/CrossLinked>
   - Maigret (OSINT Username Reconnaissance): <https://github.com/soxoj/maigret>
   - WhatsMyName (Username Check Engine): <https://whatsmyname.app/>
   - probablepeople (CRF Name Parser): <https://github.com/datamade/probablepeople>
   - html-metadata (Schema.org JSON-LD Parser): <https://github.com/wikimedia/html-metadata>
   - Trafilatura (Text & Bio Extraction): <https://trafilatura.readthedocs.io/>
   - Robin Linacre, Cross Validated Fellegi-Sunter Parameter Estimation:
     <https://stats.stackexchange.com/questions/71012/generating-m-u-probabilities-in-fellegi-sunter-record-linkage>
   - Reddit r/scrapingtools on LinkedIn 999:
     <https://www.reddit.com/r/scrapingtools/comments/1vo6szo/linkedin_started_throwing_999s_at_residential/>
   - Reddit r/scrapy on Response 999:
     <https://www.reddit.com/r/scrapy/comments/1927zpd/how_to_handle_response_999/>
