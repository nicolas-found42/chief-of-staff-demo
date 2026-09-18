# LinkedIn for #423: cookies, and every other means — a 2026-09-18 sweep

Written 2026-09-18 against `main` at `12db391`, on the question the maintainer asked directly:
**"can we use cookies or other means to fix this?"** It is the input to the decision still pending
on [#423](https://github.com/nicolas-found42/chief-of-staff-demo/issues/423) (three questions await
Nicolas; this document changes no ticket state and no code). It extends, and in one place corrects,
[`linkedin-reading-options.md`](linkedin-reading-options.md) (#115, 2026-08-29) and
[`person-research-without-linkedin-authentication.md`](person-research-without-linkedin-authentication.md)
(#423, 2026-09-17).

Method: five read-only research passes (sanctioned APIs + legal; open-source tooling; commercial
services; LinkedIn-free evidence sources; our own code's seams), plus curated awesome-list and
GitHub code sweeps. LinkedIn itself was touched only via `robots.txt` and two Help-Center pages,
once each. No logins, no cookies sent, no credentials requested. Every claim carries its source;
**[UNVERIFIED]** marks what could not be reached first-hand.

---

## The direct answer

Cookies **cannot fix the anonymous case, because cookies are the login case.** Every
primary-verified open-source tool that reads `linkedin.com/in/<slug>` profiles does so with a
login-derived `li_at` (usually plus the `JSESSIONID` CSRF pair) against LinkedIn's internal
Voyager API, or by driving a logged-in browser session; without one, every tool lands on the same
`/authwall` wall we record today. Using one means operating a real account in violation of
LinkedIn's User Agreement § 8.2 — with the account-restriction risk the tools' own READMEs state
plainly — and this repository's architecture excludes it at four independent layers. The honest
"other means" are the ones already built (SERP-mediated identity bootstrap, bounded public
render), two small keyless gaps this sweep scoped precisely, and — if the maintainer ever wants
LinkedIn-sourced data at all — a licensed provider behind the existing paid-provider pattern,
which is a budget and ADR decision, not a code fix.

---

## 1. What the cookie route actually is (live tooling, primary-verified)

All findings below were re-verified against the repos' own code and metadata on 2026-09-18. Full
per-project detail is in the sweep appendix at the end of this file; the decision-relevant shape:

| Route family | Representative, last real activity | Mechanism | Anonymous? | Self-stated risk |
| --- | --- | --- | --- | --- |
| Voyager REST via cookies | `tomquirk/linkedin-api` lineage (PyPI 2.3.1 live; original repo unresolved 2026-09-18; fork [nsandman/linkedin-api](https://github.com/nsandman/linkedin-api) preserves docs) | `li_at` + `JSESSIONID` cookies on `www.linkedin.com/voyager/api/*` requests | No — cookies are login | "violates Linkedin's User Agreement Section 8.2 … Linkedin may (and will) temporarily or permanently ban your account" (fork README) |
| Voyager GraphQL, logged-in session | [cullenwatson/StaffSpy](https://github.com/cullenwatson/StaffSpy) — code Dec 2024, README Sep 2026 | `requests.Session` + storage file ("lasts a week or so", README) | No | 400 BadCookies, 429s, hidden results; ships CAPTCHA-solver hooks — highest exposure |
| Playwright + saved session | [joeyism/linkedin_scraper](https://github.com/joeyism/linkedin_scraper) — code Jan 2026 | Browser `storage_state` file; DOM parse | No — `ensure_logged_in()` | `AuthenticationError` at authwall/checkpoint |
| Stealth browser on one's own account | [stickerdaniel/linkedin-mcp-server](https://github.com/stickerdaniel/linkedin-mcp-server) — code 2026-09-17, 3.5k stars | Patchright (stealth Chromium) profile; can import `li_at` from local browser cookie DBs | No | "accounts using automated tools can be restricted or banned" (README) |
| Puppeteer + pasted `li_at` | [josephlimtech/linkedin-profile-scraper-api](https://github.com/josephlimtech/linkedin-profile-scraper-api) — code Sep 2026 | `page.setCookie` li_at; warns email+password login from servers gets blocked | No | `SessionExpired` |
| Keyless **guest jobs** (not profiles) | [speedyapply/JobSpy](https://github.com/speedyapply/JobSpy) — code 2026-09-18 | Plain `requests` to `/jobs-guest/jobs/api/seeMoreJobPostings/search`, `clear_cookies=True` | **Yes — jobs only** | ~10 pages per IP before rate-limit (README) |

The load-bearing negative, checked across every repo above: **no primary-verified code path reads
`/in/<slug>` profile content anonymously.** joeyism's unauthenticated run lands on
`authwall?...sessionRedirect=.../in/...` and raises `Not logged in`; the JSON-LD/`og:`-metadata
claims for public profile pages exist only in secondary roundups (Scrapfly, Aug 2026) and were not
reproduced from code — **[UNVERIFIED], do not rely on it**. LinkedIn's `robots.txt`
(fetched 2026-09-18) disallows `/voyager/api`, `/jobs-guest/`, and `/authwall` even for
`Googlebot`/`Bingbot`, and `User-agent: *` is `Disallow: /`
(<https://www.linkedin.com/robots.txt>).

## 2. Why this repository cannot take that road today

Four independent layers, any one of which a cookie route would have to reverse:

1. **ADR-0042** (`docs/adr/0042-person-profiles-are-workspace-resources.md`): "Direct authenticated
   scraping, imported browser sessions, CAPTCHA bypass, and control evasion are not Person Profile
   sources. LinkedIn evidence may enter through public indexing or an explicitly authorized
   provider…"
2. **ADR-0049** (`docs/adr/0049-public-search-fans-out-over-independent-keyless-providers.md`):
   "No cookies, no imported sessions, no CAPTCHA bypass — public results stay untrusted
   Source-Item-class input."
3. **Issue #230's enforcement test** — `tests/src/unit/source-eligibility.test.ts` walks every
   reachable research route and fails if any route requires an API key, payment, user sign-in, or
   imported session. A cookie route fails CI by construction.
4. **The eligibility record and the reader itself** — `apps/server/src/source-adapters/eligibility.ts:479-488`
   lists the `linkedin` route as `excluded` with cost `sign-in`, and the social reader records the
   wall with `recoveryStopped: "Signing in, importing a session or using a paid proxy is out of
   scope"` (`apps/server/src/person-profile/research-readers.ts:2472-2473`).

The legal frame, from primary records (details in the 2026-09-17 document, §2.2, which this sweep
re-checked): *hiQ v. LinkedIn* settled that the CFAA likely does not bar scraping public pages
(9th Cir. 2022) — but the same case ended in a consent judgment of **$500,000** and a permanent
injunction against scraping "whether logged in to a LinkedIn account or not"
(N.D. Cal. Dkt. 406, Dec 8 2022; <https://storage.courtlistener.com/recap/gov.uscourts.cand.312704/>).
CFAA non-liability is not permission; contract, robots, and technical countermeasures remain, and
LinkedIn's own user agreement reaches data obtained "through third parties (such as search tools
or data aggregators or brokers)" (§ 8.2, <https://www.linkedin.com/legal/user-agreement>).

## 3. What "other means" are actually on the table

### 3.1 Already built (no work remains)

- **SERP-mediated identity bootstrap.** Slug-scoped seeds
  (`site:linkedin.com/in/<slug>`, `"linkedin.com/in/<slug>"`) at
  `apps/server/src/person-profile/research-plan.ts:322-330`, and the frequency-ranked transient
  adoption of SERP titles behind canonical-URL + slug-similarity guards at
  `apps/server/src/person-profile/research.ts:651-693`. Snippets are lead-grade
  Identity Signals — never retained content (per #423's own rule and ADR-0042/0097). LinkedIn's
  Help Center confirms only a member-enabled *simplified* public profile is even eligible for
  search-engine display, and refresh takes weeks-to-months
  (<https://www.linkedin.com/help/linkedin/answer/a518980>). Whether Google still indexes `/in/`
  pages in 2024-2026 could not be established from primary sources either way — the practical
  consequence is only to keep the seeds fanned across all SERP providers and record per-provider
  snippet presence (Mojeek already has a documented `site:linkedin.com/in` coverage gap:
  `apps/server/src/source-adapters/providers/mojeek.ts:16-19`).
- **Bounded clean-browser render.** `tryRender`
  (`apps/server/src/person-profile/research-readers.ts:1071-1165`, renderer in
  `apps/server/src/source-adapters/browser.ts`) renders public pages without session, identity, or
  CAPTCHA interaction, and the LinkedIn-specific merge pulls anonymous public article cards
  (2371-2404) — this is the "render attempt" #423's third question asks about. The Content Scout
  adapter's evidence gate (`linkedin.ts:118-225`) already defines the promotion bar for any future
  `linkedin-public-browser-v1` route: three representative targets × two repeats, clean browser
  only.

### 3.2 Keyless enrichment gaps this sweep scoped (the actionable "other means")

1. **Wikidata P6634 slug → entity lookup is NOT implemented.** Provenance: the 2026-09-02 stack
   survey ([public-search-providers.md](public-search-providers.md)) had already classified this
   route "THE FIX — adopt" (property live-verified; the slug lookup itself "not separately
   exercised"); the 2026-09-17 reading-options document then overstated it as existing.
   Correction to that document's Strategy-2 table: our adapter
   (`apps/server/src/source-adapters/providers/wikidata.ts`) is `wbsearchentities` name search
   only — it does not consume Property [P6634](https://www.wikidata.org/wiki/Property:P6634)
   (LinkedIn personal profile ID), P108 (employer), or P39 (position held), and runs no SPARQL. A
   slug-driven P6634 lookup is keyless, CC0
   (<https://www.wikidata.org/wiki/Wikidata:Data_access>), and small. Coverage caveat: ~13.6M
   human items exist versus on the order of a billion LinkedIn profiles
   (<https://www.wikidata.org/wiki/Wikidata:Statistics>), and the notability bar means a
   "Richard Achee"-class professional very likely has no item — record absence as "no
   notable-person record", never as negative evidence. Live-checked 2026-09-18: none of the
   three #423 slugs has a P6634 row (addendum § A.1).
2. **Wayback CDX timeline dating of company pages.** Our provider implements only the
   availability API's closest-snapshot answer (`wayback.ts:44-48`, with the 25-75 s deadline
   override documented in its header); the CDX server's timestamp-range enumeration
   (<https://github.com/internetarchive/wayback/tree/master/wayback-cdx-server>) — which converts
   a current-role claim on a team/about page into tenure brackets — is absent. Keyless; applies to
   company pages only, never to linkedin.com captures (authwall-blocked and excluded by posture).
3. **SERP X-ray patterns are already in place** (seeds above; cf. the CrossLinked approach,
   <https://github.com/m8sec/CrossLinked>, which parses the same SERP titles we already read).
   EDGAR/ORCID/OpenAlex/Crossref/DBLP/GitHub/GDELT/IA-TVNews providers already run.

### 3.3 If the maintainer ever wants LinkedIn-sourced data: the licensed route

Priced 2026-09-18 (full table in the appendix): Bright Data scraper API ~$0.0015/record PAYG
(<https://brightdata.com/pricing/web-scraper>; note its 2024 win in *Meta v. Bright Data* on
logged-out public data, <https://brightdata.com/blog/web-data/court-rules-in-favor-of-bright-data-in-meta-v-bright-data-case>),
Enrich Layer (ex-Proxycurl) ~$0.02-0.05/profile (<https://enrichlayer.com/pricing>), Apify
no-cookie profile actors ~$4-5 per 1,000 (<https://apify.com/curious_coder/linkedin-profile-scraper>),
CoreSignal ~$0.07-0.40/record (<https://coresignal.com/pricing/>). None is an official LinkedIn
partner; all lawfulness claims are vendor-asserted, and LinkedIn's § 8.2 third-party clause
reaches broker-sourced data for members. The integration seam already exists — the
`guestProfile` module-scoped-credential pattern (`packages/shared/src/schemas.ts:166`,
`apps/server/src/config.ts:212-214`, `redactConfig`) — but admitting a paid provider means an
eligibility-table entry, an ADR, and a #230 test amendment. That is a budget-plus-policy decision
for Nicolas, not a bug fix.

## 4. Side-finding needing a probe

OpenAlex moved to mandatory API keys with usage-based billing (≈$1/day free allowance) as of
February 2026 (<https://help.openalex.org/access/pricing>,
<https://help.openalex.org/api/authentication> — key requirement itself **[UNVERIFIED]** at
first-hand level in this pass). Our `openalex.ts` provider predates that and runs keyless. Before
changing anything: one bounded live probe through the provider, per the
provider-recovery-probe protocol. Recorded here so it is not lost; it is not a #423 item.

## 5. Decision framing for #423

Two of the three blocked dossiers already publish without LinkedIn (22 + 15 Person Claims; the
third is an honest negative), so the practical residue of #423 is policy, not access. Options:

| Option | What changes | Posture | Cost | Risk | Decider |
| --- | --- | --- | --- | --- | --- |
| A. Accept the limitation (status quo) | Nothing | Compliant | Zero | None | Nicolas (his three open questions already cover this) |
| B. Keyless enrichment (P6634 SPARQL; Wayback CDX dating) | 2 small providers/readers | Fully compliant, keyless | Days | Coverage is sparse for non-notable people — absence must stay a non-fact | Agent-workable on `ready-for-agent` |
| C. Licensed provider behind `guestProfile` pattern | Config schema, eligibility entry, ADR, #230 amendment | Compliant via authorized-provider clause | $ + vendor diligence | Vendor attrition (Proxycurl→Enrich Layer rebrand; activities-API shutdowns of Jul 2026 show the market churns) | Nicolas (budget + policy) |
| D. Cookies / imported sessions | Reversal of ADR-0042 + ADR-0049, #230 rewrite, new secret class | Violates UA § 8.2; hiQ consent judgment is the operating precedent | Ongoing (session upkeep, ban churn) | Account restriction is the tools' own documented expectation; legal exposure sits with the operator | Not recommended; only Nicolas could even ask for it |

## Appendix: sweep provenance

- Sanctioned APIs: Profile API is authenticated-member-only with a no-storage rule for other
  members (<https://learn.microsoft.com/en-us/linkedin/shared/integrations/people/profile-api>);
  self-serve today is OpenID Connect own-data only
  (<https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access>); SNAP is
  closed to new partners (<https://learn.microsoft.com/en-us/linkedin/sales/>); DMA portability is
  own-data, EEA/CH only
  (<https://learn.microsoft.com/en-us/linkedin/dma/data-portability/member-data-portability-member/>).
  The 2015/2020 partner-lockdown narrative could not be verified from primary sources — treat as
  secondary-only.
- Open-source sweep verdict table (mechanisms, last-verified activity, ban warnings): compiled
  2026-09-18 from repo metadata and code; per-project sources inline in § 1. `scrapedin`
  (2019-era) and the original `tomquirk` repo are treated as stale/unresolved.
- Awesome-lists sweep: LinkedIn items concentrate in OSINT collections
  (`cipher387/osint_stuff_tool_collection`, `jivoi/awesome-osint`) and Apify actor roundups
  (`cporter202/API-mega-list`); the scraping lists' relevant general tools (crawl4ai, browser-use)
  inherit the authwall — no LinkedIn-specific keyless bypass exists in their code.
- All linkedin.com fetches this sweep: `robots.txt` (×2 agents, 2026-09-18),
  <https://www.linkedin.com/help/linkedin/answer/a518980>. Nothing else; no cookies, no logins.

## Addendum: same-day keyless OSS sweep and live checks (2026-09-18, later)

Run after this document merged, same patterns (awesome-lists corpus + GitHub code grep), plus
bounded live checks. Upstream footprint: three SPARQL calls, six ORCID search calls (a jq
syntax retry re-fetched the same three names; responses were captured to files and filtered
locally), one provider-harness probe.

### A. Live checks

1. **P6634 rows for the three #423 slugs: none.** SPARQL `?p wdt:P6634 "<slug>"` against
   `query.wikidata.org` returned zero bindings for `richardachee`, `joseceresc`, and
   `shaye-james-b85087143` (2026-09-18). The § 3.2 item 1 notability caveat is now a measured
   fact for the actual blocked dossiers: the P6634 bridge cannot unlock these three, whatever
   it offers notable people generally.
2. **ORCID expanded-search for the three names: no match.** `pub.orcid.org/v3.0/expanded-search/`
   OR-expands the query tokens (43k-106k fuzzy rows per name); filtered locally for joint
   given+family matches, zero for "Richard Achee", "Jose Ceresc", "Shaye James". Both keyless
   identity bridges miss all three blocked people — the 2026-09-02 document's "one honest gap"
   is exactly where #423 sits.
3. **OpenAlex probe: throttled, not keyed.** One bounded call through the real provider
   (`scripts/debug/provider-recovery-probe.mts openalex`, query "Richard Achee") answered 429
   with Retry-After ≈ 16.9 h, and the provider recorded and honored the cooldown. A 429 is
   rate-limiting, not the February-2026 key gate (that would be 403); keyless status stays
   unverifiable from this IP today. No code defect; the OpenAlex side-finding probe is now done
   and logged.

### B. Keyless OSS options surfaced by the same patterns

- **`inventaire/inventaire`** consumes `wdt:P6634` keyless with a human-slug validation regex
  (`^[\p{Letter}0-9\-&_'’.]+$/u`,
  [properties_values_constraints.ts:279](https://github.com/inventaire/inventaire/blob/main/server/controllers/entities/lib/properties/properties_values_constraints.ts))
  — the concrete precedent to copy if the § 3.2 item 1 adapter is built.
- **`duckdb-web-archive-cdx`**
  ([midwork-finds-jobs/duckdb-web-archive](https://github.com/midwork-finds-jobs/duckdb-web-archive),
  found via [iipc/awesome-web-archiving](https://github.com/iipc/awesome-web-archiving)) queries
  the Internet Archive **and CommonCrawl** CDX APIs from SQL — a keyless precedent for the
  § 3.2 item 2 CDX dating gap, and CommonCrawl indexes as a second archive source beyond
  wayback.
- **Username-enumeration tools** — [Maigret](https://github.com/soxoj/maigret) (3000+ sites,
  with profile extraction) and [WhatsMyName](https://whatsmyname.app/) (500+ sites, OSS data
  file) — are keyless and could feed candidate profile URLs into the Identity Bootstrap slug
  stage. Classification: lead generation only. Site-existence heuristics are false-positive
  prone, and a hit is a Research Lead needing verification, never a Person Claim source.
- **[RecruitEm](https://recruitin.net/)** (X-ray query builder for LinkedIn/Xing via Google) is
  the SERP-seed pattern the app already runs; no new capability.
- Meta-lists worth indexing for future sweeps:
  [iipc/awesome-web-archiving](https://github.com/iipc/awesome-web-archiving) (2,644 stars),
  [olivierbinette/awesome-entity-resolution](https://github.com/olivierbinette/awesome-entity-resolution)
  (218 stars),
  [edoardottt/awesome-hacker-search-engines](https://github.com/edoardottt/awesome-hacker-search-engines)
  (11,188 stars), `cipher387/osint_stuff_tool_collection` (8,840 stars).

**Net:** no new adoptable search provider beyond the 2026-09-02 stack. What this pass adds:
measured confirmation that neither keyless identity bridge reaches the three blocked people, a
concrete OSS precedent for each of the two keyless enrichment gaps, and the username-lead tool
class for the Identity Bootstrap stage.

### C. Pointer and correction (added 2026-09-18, after the verification sweep)

Section 1's "load-bearing negative" — *no primary-verified code path reads `/in/<slug>` profile
content anonymously* — is corrected by
[`linkedin-anonymous-reads-verified-2026-09-18.md`](linkedin-anonymous-reads-verified-2026-09-18.md):
a browser-shaped anonymous client **does** read the guest profile page today (verified live, no
cookie, no Voyager call), gated per client shape and per profile visibility. The cookie finding
itself is unaffected: every login-derived route remains out of posture.
