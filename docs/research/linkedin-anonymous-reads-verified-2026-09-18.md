# Anonymous LinkedIn reads, verified first-hand: code, routes, and the two gates (2026-09-18)

Written 2026-09-18 against `main` at `8194dd2`, on the maintainer's question for
[#423](https://github.com/nicolas-found42/chief-of-staff-demo/issues/423): *"I believe anonymous
LinkedIn read code exists on GitHub somewhere — find it and verify what each example actually
does."* It extends [`linkedin-cookies-and-access-sweep-2026-09-18.md`](linkedin-cookies-and-access-sweep-2026-09-18.md)
(the cookie and licensed-route sweep), correcting it in one place and one earlier code observation
in another (§8, closing note).

Method: four lanes. **A** GitHub code harvest — awesome-list corpus, `gh search`, grep.app — every
candidate opened at a pinned commit and executed where possible. **B** live anonymous routes from
this workstation: 59 single-shot requests across archives, caches, keyless renderers, search
engines and LinkedIn's own non-person surfaces. **C** public surfaces other than the profile page
(registries, naming patterns, identity signals). **D** the application's own posture: the shipped
reader plus one bounded anonymous browser render of the subject URL, made with the production
renderer. Rules held by every lane: no login, no cookie, no imported session, no CAPTCHA
interaction, no proxy, no retry against a challenge. Every claim carries its source;
`[UNVERIFIED]` and `[INFERENCE]` mark what was not established first-hand. Fragments and raw
bodies: `.scratch/linkedin-anon-routes/` (untracked).

---

## The direct answer

**Yes — an anonymous read of a LinkedIn profile page exists, and it is not a GitHub trick.** It is
an ordinary `GET https://www.linkedin.com/in/<slug>` from a client that looks like a browser,
parsed as HTML: `og:title`/`og:description`/`og:type=profile` plus the guest DOM's
`.top-card-layout__*` nodes. No cookie, no Voyager API, no session, no CAPTCHA solver, no proxy.
Verified live today: `billgates` → HTTP 200, 678,187 B; `joseceresc` → HTTP 200, 764,268 B; both
with `pageKey public_profile_v3_desktop`.

**But the page is gated twice, and the gates are the substance.** The same URL returns HTTP 999
(the 1,530-byte authwall redirector) for a curl-shaped client and 200 for a browser-shaped one
within the same minute; and with one identical client, one slug returns 200 while another returns
999 seconds apart. Yield is therefore *per client shape, per slug, per moment*. Nothing here
supports "LinkedIn profiles are anonymously readable", and nothing supports "…are not". No code
makes it deterministic, which is why no awesome-list tool packages it: the GitHub projects supply
the *parser* and the *guard rails*, not the access.

**For the profile that started this (`linkedin.com/in/sheilawarrick`), every route is closed
today**: 999 for a curl client and for a browser-header client (four attempts), 999 and then an
`/authwall?…sessionRedirect=/in/sheilawarrick` landing for a real headless browser (D), no capture
in any archive (B), no SERP result carrying the slug (B, D), and no attributable public evidence
under the slug at all. That matches `shaye-james-b85087143` and is a *per-profile* result, not a
statement about the site: `richardachee` and `joseceresc` both went URL-only → published dossier on
this same code hours earlier.

**What it changes for the app:** nothing about its posture — its reader and its browser route are
already anonymous, non-evasive clients — and one thing about its selection, which is the open
question 2 already on #423; D §3 adds the change that must accompany it.

---

## 1. The two gates, measured

### 1.1 Client identity

```
# same machine, same minute, residential IP, no cookies
curl -A 'curl/8.7.1' .../in/sheilawarrick                          -> 999 (1,530 B)
curl -A 'curl/8.7.1' .../in/joseceresc                             -> 999 (1,530 B)
# browser header set (Chrome UA + accept / sec-fetch set), no cookies:
  billgates                                                        -> 200, 678,187 B
  joseceresc                                                       -> 200, 764,268 B
  joseceresc?trk=public_profile                                    -> 200, 750,628 B
  sheilawarrick (twice, 3 s apart)                                 -> 999, 1,530 B
```

The 999 body is a JS redirector and nothing else — no `og:` tag, no `pageKey`:

```
window.location.href = "https://" + domain + "/authwall?trk=" + trk + "&trkInfo=" + trkInfo
```

`[UNVERIFIED]` no repo issue or upstream document was found describing today's UA-dependent split.
The candidate repo's README blames "datacenter IPs"; the observation above is from a residential
IP, so that explanation is incomplete rather than wrong.

**Bound on the rule, from the app's own transport.** The shipped reader sends an honest,
self-identifying UA (`Found42-Content-Scout/1.0 (+public-source-monitor)`,
`apps/server/src/source-adapters/http.ts:282`) and still retrieved the *guest* profile page for
`richardachee` and `joseceresc` over plain HTTP earlier today — the retained sources carry
`Article listed by …` cards and, for Jose, the "empty experience rows" limitation. A browser UA
helps, but this is not a single UA rule; treat it as a scored client identity with per-slug
variation.

### 1.2 Per-profile visibility — corrected in the addendum

Same client, seconds apart: `billgates`, `joseceresc`, `richardachee` returned the guest page;
`sheilawarrick` and `shaye-james-b85087143` returned 999 / the authwall — including under the exact
header set that worked for the others. `[INFERENCE]` the cause is the profile's own public
visibility setting; it was not confirmed from LinkedIn documentation. Two secondary observations
pointed the same way: Jose's guest page carries
`<p class="blur" aria-hidden="true">****** **********</p>` for job titles (its positions parse empty
while company names stay visible), while the *same* parser against Bill Gates' guest page returned 3
positions and 2 schools in full.

**The addendum below narrows this.** The same slugs that 999 here (`richardachee`, `joseceresc`)
999'd for a whole remediation campaign on 2026-09-16 and returned the guest page on 2026-09-18 — so
the gate is not a fixed per-profile property. A second, *IP-wide* 999 regime was reproduced under
request velocity, and it is byte-identical on the wire to the per-slug refusal. Read the addendum
before quoting anything in this section as a profile-visibility verdict.

---

## 2. What the anonymous guest page contains

Live, `joseceresc`, 2026-09-18, no cookies:

- `<meta name="pageKey" content="public_profile_v3_desktop">`
- `og:type=profile`, `og:title` (e.g. `Jose Cervantes Escamilla - Airbnb | LinkedIn`),
  `og:description`, `og:image`, `og:url`
- the guest DOM's full-depth top card, summary and education chips; `.top-card-layout__title` and
  `.top-card-layout__headline` are the nodes every public parser targets
- **job titles redacted with asterisks** on some profiles (one `class="blur"` node on Jose's page);
  239 `sign-in-modal` markers and 12 `blurred-overlay` markers are upsell furniture, not content
- **no `Person` JSON-LD.** The page's single `application/ld+json` block is `@type: Article` for a
  *pulse* article authored by the person. A plan that expects schema.org profile data from
  anonymous HTML has no basis here; `og:` parsing is the fallback that works
- `<meta name="robots" content="max-image-preview:large, noarchive">` **and**
  `<meta name="bingbot" content="max-image-preview:large, archive">`: LinkedIn explicitly grants
  Bing archival while denying general archiving — primary-source support for the public-indexing
  ingest path ADR-0042 already allows. The same two tags appear in the candidate repo's
  2026-07-27 fixture
  ([`williamhgates.html` L9-L14](https://github.com/aadisriram/nodejs-linkedin-scraper/blob/c0e2688a22dcd55e61fd4aba99bbc96279bfa26d/test/fixtures/williamhgates.html#L9-L14)).

---

## 3. The candidates, read at pinned commits

"Auth class" is read from the code, not the README. Stars and `pushed_at` from `gh api` on
2026-09-18.

| repo | mechanism | auth class | verdict |
| --- | --- | --- | --- |
| [aadisriram/nodejs-linkedin-scraper](https://github.com/aadisriram/nodejs-linkedin-scraper/blob/c0e2688a22dcd55e61fd4aba99bbc96279bfa26d/src/fetch.ts#L38-L45) @ `c0e2688` · MIT · 15★ · pushed 2026-07-27 | `fetch` of `/in/<slug>`, Chrome UA, Cheerio top-card parse + `og:` fallback, explicit 999/challenge handling | **anonymous, no cookie** (declares a browser UA) | **works today, verified end-to-end** — the one candidate we executed |
| [juhnny5/resumectl](https://github.com/juhnny5/resumectl/blob/e8d481ead427b182f2fef6b43573f1ea4d108ed6/internal/linkedin/scraper.go#L131-L177) @ `e8d481e` · no license · 68★ · pushed 2026-07-29 | Go GET of `/in/<slug>` with Chrome UA and HTML parse; optional `li_at` cookie upgrades to Voyager | **anonymous branch, no cookie**; cookie branch out of scope | same mechanism, independent confirmation |
| [hueyy/HungryHippo](https://github.com/hueyy/HungryHippo/blob/b8576398972bec8d5c8e6808c9095bcb636deb28/src/muncher/linkedin.ts#L7-L26) @ `b857639` · EUPL-1.2 · 54★ · pushed 2025-02-11 | axios GET + Cheerio `.top-card-layout__title` / `__headline` unfurl | **anonymous, no cookie** (2019-era Chrome UA) | dormant; confirms name+headline is the advertised unfurl output |
| [microlinkhq/metascraper](https://github.com/microlinkhq/metascraper/blob/3914e46522974b0c551d33f964f0e5840c99b288/packages/metascraper/test/integration/linkedin-company/index.js#L24-L30) @ `3914e46` · MIT · 2,737★ | metadata parser over supplied HTML; fetches nothing | n/a (parser) | usable parse step; its fixtures are company and pulse, **no person profile** |
| [speedyapply/JobSpy](https://github.com/speedyapply/JobSpy/blob/fda080a373e8226f3fd60635323f5da9af9892b1/jobspy/linkedin/__init__.py#L116-L131) @ `fda080a` · MIT · 4,299★ · pushed 2026-02-18 | `/jobs-guest/…/seeMoreJobPostings/search`, browser header set | **anonymous, no cookie** | works (200 with its headers, 429 with curl's); **jobs only, no person data** |
| [m8sec/CrossLinked](https://github.com/m8sec/CrossLinked/blob/2ae8d7bd5b1e9378f45cbf6ed38a3e79ded3acaf/crosslinked/search.py#L41-L72) @ `2ae8d7b` · GPL-3.0 · 1,593★ · 2024-11-26 | scrapes Google/Bing SERPs for `site:linkedin.com/in+"<org>"`; never touches LinkedIn | anonymous | substitute only (names from org); `[UNVERIFIED]` whether SERP scraping still works |
| [python-scrapy-playbook/linkedin-python-scrapy-scraper](https://github.com/python-scrapy-playbook/linkedin-python-scrapy-scraper/blob/e007e8326207ce8229f2f505cf3785855234862c/linkedin/spiders/linkedin_people_profile.py#L16-L40) @ `e007e83` · 113★ | Scrapy selectors for exactly the guest DOM, routed through a paid proxy (README: 30 credits/request) | anonymous shape, **paid proxy** | out of posture as shipped; selectors useful as reference |
| [jobroche/InSpy](https://github.com/jobroche/InSpy/blob/HEAD/lib/workbench.py#L55-L67) @ HEAD · MIT · 575★ · 2023-07-11 | anonymous GET of `/title/<role>-at-<company>`, explicit 999 branch | anonymous | **retired surface**: probe 2026-09-18 → browser UA 999, curl UA 404 |

Every other candidate in the harvest resolves to a login, a cookie (`li_at`), a CAPTCHA solver, a
stealth/anti-detect browser, or a paid API — one line each with its primary source in the A
fragment. That list includes `l4rm4nd/LinkedInDumper`, `joeyism/linkedin_scraper`,
`stickerdaniel/*`, `cullenwatson/StaffSpy` (CapSolver), `mdsecactivebreach/LinkedInt`,
`hqman/linkedin-scraper`, `CyberYozh-data/yozh-scraper` (Camoufox), RSSHub's company-posts route
(moved to `patchright` in commit `cfcdc34e1`, 2026-06-06), `eracle/linkedin` (paid provider), and
the Apify / Proxycurl / PhantomBuster class. **None of them changes the answer above.**

### 3.1 The candidate we executed: `aadisriram/nodejs-linkedin-scraper`

Request construction (no cookie anywhere in the repo):

```ts
// src/fetch.ts L38-L45
  const headers: Record<string, string> = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": acceptLanguage,
    "User-Agent": userAgent,
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };
```

999 and 429 are classified as an explicit blocked-channel signal rather than retried blindly
(`src/errors.ts` L55-L63), and challenge detection separates a real wall from public markup
(`src/fetch.ts` L114-L129: `looksLikeChallenge` on `authwall`, `pagekey" content="auth_wall`,
`challenge-form`, `security challenge` **without** `public_profile`; `hasPublicMarker` on
`public_profile` / `top-card-layout__title` / `og:type="profile"`). Parsing is two-layer — DOM
selectors with an `og:` fallback (`src/parse/top-card.ts` L11-L23):

```ts
  const name =
    textOf($(".top-card-layout__title").first()) ||
    textOf($("h1").first()) || undefined;
  const headline =
    textOf($(".top-card-layout__headline").first()) || undefined;
```

Verification on 2026-09-18:

- the repo's own live smoke test passes from this machine, zero cookies:
  `LIVE_LINKEDIN=1 npx vitest run test/integration/live.test.ts` → `2 passed | 1 skipped`;
- its parser on *our* live Gates response → `name: "Bill Gates"`,
  `headline: "Chair, Gates Foundation and Founder, Breakthrough Energy"`, 3 positions,
  2 educations;
- the same call on the live `joseceresc` response → name/headline/location only: empty
  `positions`/`educations`/`skills` (the asterisk-blurred variant).

Caveat, stated for the maintainer: the browser-UA declaration is load-bearing for this repo's
curl-shaped client, and whether declaring one sits inside ADR-0042's "control evasion" line is a
judgment call. The app does not need the judgment: its browser route *is* a browser, and its
direct transport works sometimes with an honest UA (§1.1).

### 3.2 The same mechanism, independently: `juhnny5/resumectl`

```go
// internal/linkedin/scraper.go L130-L177 (abridged)
// FetchProfile retrieves data from a public LinkedIn profile (without authentication)
func FetchProfile(username string) (*LinkedInProfile, error) { return FetchProfileWithAuth(username, "") }

// If sessionCookie is provided (li_at cookie), all data will be accessible via Voyager API
func FetchProfileWithAuth(username string, sessionCookie string) (*LinkedInProfile, error) {
    if sessionCookie != "" { profile, err := fetchViaVoyagerAPI(client, username, sessionCookie); ... }
    // Fallback: retrieve via public HTML page
    req.Header.Set("User-Agent", "Mozilla/5.0 ... Chrome/120.0.0.0 Safari/537.36")
    if sessionCookie != "" { req.Header.Set("Cookie", "li_at="+sessionCookie) }
    if resp.StatusCode != http.StatusOK {
        return nil, fmt.Errorf("LinkedIn returned status %d - the profile may be private or not exist", resp.StatusCode)
    }
```

The cookie branch is the login case and stays out of scope; the anonymous branch reproduces the
header set that returns 200. Two independent repos, two languages, one mechanism: **there is no
secret endpoint.** "Unfurl" is just `og:`/DOM parsing of the page a browser-shaped client can
fetch — no oEmbed or share-preview endpoint exists for profiles ([INFERENCE], consistent with the
absence of any such endpoint across the surveyed code).

---

## 4. Live routes: 59 requests, zero person data

Every row in the B fragment is a single request from this workstation with no cookies, no login
and no retry against a challenge. What it establishes, by family:

- **Archives: none to cite.** Wayback replay 404 ("The Wayback Machine has not archived that
  URL") for both slugs; `archive.org` availability API 429 and the CDX host serving an Internet
  Archive outage page at probe time; archive.today `/newest/` → "No results" for both;
  Arquivo.pt textsearch `estimated_nr_results: 0`; MemGator 404; TimeTravel and `cc.bingj.com`
  are no longer in DNS. So there is no archived body containing a name or headline for either
  subject — and no archive route to fall back on while `linkedin.com` walls a slug.
- **Google cache: gone.** The `webcache` endpoint answers with a Google Search JS stub;
  Google's own changelog confirms the `cache:` operator was retired (Sep 2024).
- **Keyless renderers: refused.** `r.jina.ai` 403 Cloudflare interstitial, microlink 400
  "EPROXYNEEDED … uses antibot protection", urlscan 401 (key required), and the CORS proxies
  522/empty.
- **Search engines: no slug match.** Bing is the only engine that answers (and returns "about
  19,500 results" for a `site:` query with zero `/in/` result URLs); Mojeek refuses at the
  network layer (403 even for a plain UA), DuckDuckGo's HTML endpoint serves its CAPTCHA modal,
  Marginalia's keyless API is daily-limited, and the rest are down or gated. Local SearXNG's own
  control query reports `brave too many requests`, `duckduckgo CAPTCHA`, `google cse too many
  requests`, `startpage Suspended: CAPTCHA`. This *nuances* `mojeek.ts`'s "coverage gap" framing:
  today's failure is a block, not an empty index.
- **LinkedIn's non-person surfaces that still answer anonymously**: `/jobs-guest/…/seeMoreJobPostings/search`
  (200 with 30 job cards under a browser header set; 429 under curl) and `/company/linkedin/`
  (200, `pageKey d_org_guest_company_overview`). `/pulse/` is 404, `/pub/dir/` is 999,
  `/title/<role>-at-<company>` is retired.
- **`robots.txt`** (4,862 lines, 120,190 B, 77 agent blocks): the header forbids automated access;
  `User-agent: *` is `Disallow: /`; 41 blocks each disallow `/authwall`, `/voyager/api`,
  `/jobs-guest/`, `/search*`; **no block disallows `/in/`**; CDP/dataset crawlers are not named,
  so archive bots fall under the `*` catch-all (CCBot is named with `Disallow: /`).
  **Correction to `person-research-without-linkedin-authentication.md`**: its statement that
  "LinkedIn's robots.txt disallows archive bots" is imprecise — CCBot (Common Crawl's crawler) is
  named with `Disallow: /`, but the *replay* services (Wayback, archive.today, Arquivo.pt) are
  never named, so they fall under the `*` catch-all. Nothing in the file turns on the distinction,
  but "no archive bot is named" would contradict this very parenthetical.

---

## 5. Public surfaces other than the profile page

C tested 40-plus third-party surfaces with one anonymous GET each (app reader UA, no cookies, no
CAPTCHA interaction) plus the keyless registries this app already knows. Per-surface ToS text,
`robots.txt` lines and the legal classification for every row are in the C fragment, §4.

Attribution caution first, because it governs every row: **several distinct Sheila Warricks
surface** — an Iowa pork-industry GM, a Columbia University economics co-author, a Shake Shack
business-intelligence analyst, a singer, a salon stylist, a Raleigh resident. **Nothing below
carries the LinkedIn slug**, so every hit is a name-similarity candidate under ADR-0097: a lead for
a human to confirm, never an identity the app may adopt.

### 5.1 Person-profile mirrors: exactly one surface answered for both subjects

| Surface | URL tested | Anonymous result | Posture |
| --- | --- | --- | --- |
| Wellfound | `/u/sheila-warrick`, `/u/jose-cervantes-escamilla` | **200** (108 KB each): name, and for the subject "Worked at InterviewJet"; the control shows name only | strongest person-profile read found; `robots.txt` disallows `/u/` → index-only until ToS is read |
| RocketReach | `/sheila-warrick-email_28552357` | **200** once (68,937 B): role ("Territory Representative for Recruitment"), employer (Lifeserve Blood Center), Des Moines IA, work history 2016–now, **masked** emails/phones. A second RocketReach page and the control returned Cloudflare 403 minutes later | intermittent; name-slug path is not disallowed, retention posture unresolved |
| Success.ai | `/profile/sheila-warrick-785448685754` | **200** (158 KB) "Sheila Warrick – Real Estate Business Intelligence @ Shake Shack" | LinkedIn-shaped mirror, ToS unread → index-only |
| ZoomInfo | `/p/Sheila-Warrick/-1644903095` | 403 PerimeterX; the index title alone names "World Pork Expo General Manager and Director of Projects and Events at National Pork Producers Council", Urbandale, Iowa | index-only |
| The Org | `/org/airbnb`, `/org/interviewjet` | **200** with embedded `FlatPosition` JSON (name/role/slug); `interviewjet`'s roster contains no "Warrick" | company rosters usable as a public source; the person overlay path (`?p=`) is robots-disallowed |
| Apollo | person URLs (`/people/<First>/<Last>/<id>`) | **410 Gone** (also 410 in Common Crawl's Aug-2026 index) | avoid |
| SignalHire, ContactOut, Crunchbase, Backstage | representative person URLs | Cloudflare 403 | avoid |
| GitHub | `github.com/sheilawarrick`, `github.com/joseceresc` | 404 each; keyless user search `total_count: 0` for both handles and both full names | nothing |
| About.me, Linktree | `/sheilawarrick` | 404 each | nothing |
| PII brokers (TruePeopleSearch, FastBackgroundCheck) | — | CAPTCHA/challenge walls | avoid — broker data is out of posture |

### 5.2 Venue pages do the identity work

Five publisher-owned pages answered 200 and name Sheila Warrick with a role: the Farm Progress
press release hiring NPPC's World Pork Expo general manager; the KQLX "Farm Talk" episode
"Sheila Warrick – World Pork Expo"; MEEA Vol 25 proceedings ("Sheila Warrick, **Columbia
University, USA**"); the `hos.pub` article "Green Bonds: A Catalyst for Climate Resilience…";
and the AKA Tau Omega contact page ("Technology Chairman Sheila Warrick"). All are legitimate
sources; none carries the LinkedIn slug, and they do not all describe the same person.

### 5.3 Keyless registries

| Registry | Endpoint (as sent) | Observed 2026-09-18 | App already uses |
| --- | --- | --- | --- |
| ORCID search | `pub.orcid.org/v3.0/expanded-search/?q=Sheila Warrick` | 200: **Sheila Warrick, iD `0009-0003-5164-8421`, Columbia University** | yes |
| ORCID record | `…/v3.0/0009-0003-5164-8421/record` | 200, 5,173 B: name, Columbia employment, "Green Bonds…" (2025); `researcher-urls: []` — no LinkedIn URL | yes |
| Crossref | `api.crossref.org/works?query.author=Sheila+Warrick` | 200: DOI `10.2139/ssrn.4479784`, "Green-Inclusive-Finance…", Sheila Warrick third author | yes |
| Wikidata P6634 (LinkedIn URL) | SPARQL `?item wdt:P6634 "sheilawarrick"` | 200, **empty bindings** (the `joseceresc` repeat returned 502 and was not retried) | **P6634 is not used** |
| DataCite, EDGAR full-text, NPPES, VIAF, Open Library, Apple Podcasts | as listed in the C fragment | all answered keyless with zero or empty results | most |
| DBLP | `dblp.org/search/author/api` | **Anubis anti-bot page instead of JSON** — corrects the `LIVE` observation in `apps/server/src/source-adapters/eligibility.ts` | yes |
| OpenAlex | `api.openalex.org/authors?search=…` | **429**, per-IP daily budget exhausted (resets midnight UTC) | yes |

Reading: the registries resolve identity anchors for the *Columbia* candidate (an ORCID iD, an
institutional affiliation, a DOI'd co-authored paper) — and still not one of them attaches that
person to the LinkedIn slug. Wikidata's P6634 bridge, which would do exactly that, has no statement
for `sheilawarrick` today.

### 5.4 Why the app's own run never reached any of them

Verified by reading this tree, and worth stating because it is the difference between "the app
looked and found nothing" and "the app never asked":

- The research engine passes `fullName: profile.fullName` into discovery
  (`apps/server/src/person-profile/research.ts:560`), and
  `providerQuery` (`apps/server/src/source-adapters/search.ts:568`) gates **three** providers on
  that name: `orcid` (returns `null` without a name), `ror` (needs an organization) and `artic`
  (needs a name). For a URL-only profile those three are skipped — which is why the operation's
  diagnostics contain no `orcid.org` target at all. Every other provider (`crossref`, `datacite`,
  `openalex`, `wikidata`, `dblp`, …) receives the planner's query text unchanged; Crossref was
  asked `query.bibliographic=Sheila Warrick publications`-shaped text
  (`apps/server/src/source-adapters/providers/person-records.ts:133`) and DOI-bearing registry
  results did reach selection in this very run. So the lane is not dark — it answers *planner
  prose*, which cannot confirm a slug either.
- The only thing that fills the name is the #445 Identity Bootstrap, and it adopts from SERP
  results whose URL/title carries the slug — which requires the profile page to be *indexed*
  somewhere. For `sheilawarrick` it is not indexed (B §4, C §1), so adoption never fired.
- Net for this profile: **no name → three registry providers skipped, the rest queried with prose
  → no identity anchor → no name.** The registry routes exist in production; nothing asked them
  the question their APIs can answer.

---

## 6. What the application does today

Observed live on this tree: profile `person_9b03430009cb`, operation
`df6333f2-27a3-4c6f-bc71-e71395dc675f` (fresh operation, no checkpoint), plus one bounded render
made with the production renderer.

### 6.1 The direct read is walled, classified, and no render is attempted

```
access | login-required | linkedin.com served a sign-in page to an anonymous reader.
       Login-gating marker observed in this response: "LinkedIn authentication-wall redirect".
```

The marker comes from `readSocial` (`apps/server/src/person-profile/research-readers.ts:2350`):

```ts
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

Because `wallMarker` is set, the wall branch is taken and **no render is attempted for the
canonical URL**. The URL lead closes `inaccessible`; the operation ends `incomplete`
(`disposition: bounded`, `classification: safety-bound-exhausted`), 0 sources, 0 claims, dossier
`null`. That state is honest — it says the ceiling was reached, not that the person has no public
information — and it is what the UI shows.

### 6.2 One bounded render: the browser lands on the authwall

Made 2026-09-18 ~07:45Z with the application's own production renderer — no session, no cookie,
one request, the same `playwrightBrowserRenderer()` the reader calls, whose chromium executable is
`/usr/local/bin/browser-network-sandbox` (`apps/server/src/source-adapters/browser.ts:113`). It was
made **before the IP-wide blanket of §9 began (~08:15Z)**, when control slugs in the same window
still served the full guest page — so the landing below is this subject's healthy-window answer,
not a throttling artifact:

```json
{
  "status": 200,
  "finalUrl": "https://www.linkedin.com/authwall?trk=bf&trkInfo=bf&original_referer=https://www.linkedin.com/in/sheilawarrick/&sessionRedirect=https%3A%2F%2Fwww.linkedin.com%2Fin%2Fsheilawarrick",
  "bytes": 66423,
  "elapsedMs": 1309,
  "challenge": null,
  "socialWallMarker": null,
  "accepted": true,
  "readableBytes": 1642,
  "publicProfileName": null,
  "articleCards": 0
}
```

The readable text is the sign-in shell (`Join LinkedIn / Email / Password (6+ characters) / First
name / Last name / …`). So the browser *does* execute the stub's client-side hop, and what it
lands on is the join form — not the profile. Compare the same-profile class that recovered earlier
today: `richardachee`'s journey recorded
`rendering | retrieval-recovered | browser-renderer | the bounded anonymous browser route returned readable text`
and retained 9 attributed article records; `joseceresc`'s did too, with the empty-rows
`login-required` limitation alongside.

### 6.3 Finding: the wall guard is asymmetric

`tryRender` re-tests only what the browser returned (`research-readers.ts:1076-1084`):

```ts
const rendered = await context.render(url);
if (
  rendered.status >= 400 ||
  detectChallenge(rendered.body, rendered.contentType) ||
  (family === "public-social" && detectSocialWallMarker(rendered.body))
)
  throw new Error("The anonymous browser did not return an accessible public document.");
```

For the body above, all three predicates pass. `detectChallenge`
(`research-diagnostics.ts:282-311`) keys on the *stub's* phrases (`sign in to continue`,
`please log in`, `login required`, `join linkedin to see`) plus `[class~="authwall"], [id="authwall"]`
within the first 20 KB; a rendered join form carries none of them. `detectSocialWallMarker` keys on
post-feed phrases (`show more posts from`, `log in to see more`, `join the conversation`); a join
form says "Join LinkedIn". **So a rendered authwall page is accepted as a recovered source, and its
text — a sign-in shell — would be retained and extracted from.**

Reachability, stated precisely: **[INFERENCE]** a *direct* response carrying none of the markers (a
bare 999 whose body is an invisible stub, or a 200 JS shell) passes into `readHtml`, whose parse
gate finds no readable text and then calls `tryRender` — the path where the accepted shell is
returned. What is *verified* is the acceptance itself: `detectChallenge` compiled from this tree
returned `null` for the real rendered body, and the marker lists are as quoted. What is *not*
verified is that LinkedIn currently serves such a marker-less response for a profile URL; today it
served the marker-bearing stub, so the guard held.

This matters because #423's constraint 3 says "Never treat search snippets or a sign-in shell as
the missing profile content." Today's guard depends on *where* the wall appears, not on what a
retained source must never be.

---

## 7. Verdict for `linkedin.com/in/sheilawarrick`

| Route | Result (2026-09-18) |
| --- | --- |
| Direct guarded HTTP (shipped reader, honest UA) | HTTP 999 stub with client-side `/authwall` hop → `login-required`, no render |
| Browser-header HTTP (Chrome UA set, no cookie) | HTTP 999, 1,530 B — twice, 3 s apart |
| Bounded anonymous browser render (production renderer) | 200 at `/authwall?…sessionRedirect=/in/sheilawarrick` → join form, 1,642 readable bytes |
| Keyless search index (the operation's 22 discovery queries, slug seeds included) | no result carrying `/in/sheilawarrick`; no name adopted |
| Archives (Wayback, archive.today, Arquivo.pt) | no capture of the slug anywhere |
| Guest surfaces | jobs-only and company pages; `/in/`, `/pub/dir/` all the same 999 stub |
| Public registries / naming signals | ORCID, Crossref and five venue pages name *a* Sheila Warrick keylessly; none carries the slug; no single surface ties the slug to any of them (§5) |

**Honest outcome: not anonymously readable today, and no attributable public evidence under this
slug.** The profile stays URL-only with an empty dossier. That is the designed
`unavailable`-class verdict — one of the two outcomes #423's acceptance allows ("its precise
persistent limitation") — and it is a per-profile result: the same code path published dossiers for
two other slugs hours earlier. §5 does surface name-similarity candidates (ORCID/Columbia, Wellfound
"Worked at InterviewJet", the Iowa pork-industry role), but several distinct people share the name
and none of the pages carries the slug, so confirming which — if any — is this person is the
owner's call, not the app's.

---

## 8. Decision framing for #423

Nothing here changes code. Four items for the maintainer:

1. **Question 2 on the issue is now evidence-backed.** *Should a Profile's own canonical URL
   always earn a browser-render attempt?* — The verbatim provenance notes from the 2026-09-18
   journey run split the record: for `richardachee` the direct HTTP response supplied 3 of the 9
   retained article records and the bounded render supplied 6; for `joseceresc` it was 3 of 4 and
   1 (`artifacts/person-profile-remediation/20260918T035740Z-issue-423-journeys/workspace/person-source-documents/`).
   Neither of those direct reads was walled, so what the render demonstrably adds is *breadth on a
   page that already rendered*. For `sheilawarrick` the only render of a walled canonical URL
   landed on `/authwall` and retained nothing. **Wall → render recovery is therefore untested**:
   no observed case has a walled direct read followed by a productive render, and the shipped
   reader short-circuits at the direct-response wall and never asks.
2. **If 1 is answered yes, the guard must change in the same commit.** Otherwise the render's
   authwall landing page is accepted and retained (§6.3) — the exact failure #423's constraint 3
   forbids. The cheap shape: extend `detectChallenge`-style detection to the rendered body (authwall
   selectors and the join-form phrases), and treat a render whose final URL is `/authwall` as a
   wall regardless of body.
3. **Adopting the route is a posture decision, not a free win — this doc cannot render it.**
   ADR-0042's affirmative grant is narrower than "keyless": *"LinkedIn evidence may enter through
   public indexing or an explicitly authorized provider"*, and a direct anonymous fetch of
   `/in/<slug>` is neither. The repo already recorded this exact route, live-probed on 2026-09-01,
   as posture **(b) "Do not adopt"** — `docs/research/public-search-providers.md`, "LinkedIn — the
   route map" (`:317-352`, the row reading "Logged-out `linkedin.com/in/<slug>` fetch … **works
   today** … Do not adopt (available if the user chooses to relax)"). The transport side is
   likewise governed: `browserUserAgent` (`apps/server/src/source-adapters/http.ts:33-37`) is the
   documented browser-like UA exception and is imported by exactly one provider
   (`providers/duckduckgo.ts:48`; the comment names Mojeek, whose provider rides the descriptive
   default UA instead). **So the correct next step is an ADR that either re-affirms the exclusion
   or adopts the direct read and extends the UA exception to LinkedIn with a named provider
   boundary** — the "control evasion" judgment call in A §4.1 still does not have to be made,
   because nothing here proposes disguising a client beyond the repo's existing documented
   exception class. One record is now stale regardless of the decision: `eligibility.ts:479-488`
   excludes the `linkedin` route on the ground that *"No keyless anonymous read exists"*, which is
   no longer accurate — the read exists from a browser-shaped client when the IP is not blanketed
   (§9). The exclusion may still be right; its stated reason is not.
4. **The registry lane is dark for exactly the profiles that need it (§5.4).** `providerQuery`
   skips `orcid`/`ror`/`artic` when the operation profile has no name, and the only thing that
   gives it one is the #445 bootstrap, which needs the page to be indexed. C found the anchors
   that lane would have resolved with a bare-name query (ORCID iD, Columbia, SSRN DOI) — so if the
   intended answer for a URL-only profile is "resolve the person from keyless registries", that
   needs a deliberate decision about where a candidate name may come from, and both facets above
   assume it is *not* the slug. A name-similarity adoption would attach some other Sheila
   Warrick's record to this profile; the registries find candidates, they do not confirm the
   slug.

One dated correction for the code: `eligibility.ts` records DBLP's publication search as a
`LIVE` keyless route; today DBLP serves an Anubis anti-bot challenge instead of JSON (C §3). Not
changed here — it is a one-line comment fix for whoever owns that file.

What remains true from the sweep and is not reopened: cookies are the login case, Voyager requires
`li_at`, every starred tool needs a session, and none of that is adoptable under ADR-0042.

## 9. Addendum, same day: the two 999 regimes

Written after the sweep, following a live diagnosis loop
(`.scratch/linkedin-anon-routes/tooling/anon-probe.mjs`, one command, one verdict per slug×client;
full log in `.scratch/linkedin-anon-routes/E-anon-read-diagnosis.md`). It corrects §1.2 and the
reading of §6.2, and it adds one behaviour the app has no defence against.

### 9.1 Regime A — per-slug refusal, in a healthy client

Single GET per slug with the §1.1 Chrome header set, same client, same second:

| slug | result |
| --- | --- |
| `sheilawarrick` | 999, 1 530 B |
| `shaye-james-b85087143` | 999, 1 530 B |
| `joseceresc` | 200, `pageKey public_profile_v3_desktop`, guest card, name parsed |
| `richardachee` | 200, same |
| `satyanadella` (never requested before) | 200, same |
| `reidhoffman` (never requested before) | 200, same |

Two never-probed slugs going green in the same seconds rules out an IP-wide block at that moment and
rules out client-stack effects; the two refusals are slug-shaped.

### 9.2 Regime B — an IP-wide blanket, byte-identical on the wire

Continuing to probe — ~50 requests in ~3 minutes across modes — turned *every* slug red, including
the three that were green seconds earlier: the homepage-first cookie mode, the Google-referer mode,
locale variants, and seven URL shapes of the subject (`/`, `?trk=`, `?locale=`, `?original_referer=`,
`/en`, `?lipi=`, `/pub/dir/…`) all returned the 1 530-byte stub. A real anonymous Chrome (153, fresh
profile, no cookies, `navigator.webdriver=false`, attached over CDP without `--enable-automation`)
took the stub too for `joseceresc` — main document 999, then the stub's own JS hop to
`/authwall?…sessionRedirect=/in/joseceresc`, `pageKey auth_wall_desktop_profile`, h1 "Join LinkedIn".

The stub served while blanketed is **byte-identical to the per-slug refusal**, and the identity
holds across clients, regimes and days: all eleven archived 1 530-byte samples from this machine
(`raw/li-in-chrome.body`, `li-in-curl.body`, `li-in-jose.body`, `li-pubdir-*.body`, the burst
probes) hash to `md5 895d2a337cecd4bf36e6ff9a7e669a63` = `sha256
644031a68bde879af85bcc9cb3e6fa1e9a6b0f61d49307581974b5dbc09d3de8`. That same SHA-256 is what the
app stored for its 07:41Z attempt (`person-research.json`, attempt `b2f4ca74…`) and what
`person-research-without-linkedin-authentication.md` §1.2 recorded a day earlier — so the two
regimes serve literally the same bytes from this machine. (An apparent mismatch was an
MD5-versus-SHA-256 comparison, now settled.) Status, size, headers and Cloudflare markers are
identical too: **nothing on the wire separates "this profile is not served anonymously" from "this
IP is throttled right now."**

Recovery was then measured with a **silence-then-single-probe** policy, not continuous sampling,
because a sliding-window limiter would be kept hot by the sampler itself: one request per 10
minutes after total silence stayed red at 08:50, 09:00 and 09:10Z, and a detached watcher that
probed once per 15 minutes stayed red at 09:14 → 10:59Z. **The blanket window is at least three
hours** (08:15 → 11:14Z), long-lived rather than a momentary rate limiter. The watcher now doubles
its silent window after every red reading (20 min, 40, 80, …) and only a validated green reading
starts the battery; its findings land in `raw/recovery-watch.log`.

### 9.3 Why this makes the gate time-varying, not a profile property

`artifacts/person-profile-remediation/20260916T024320Z/report.md` records **HTTP 999 for
`richardachee` and `joseceresc`** throughout the 2026-09-16 campaign — the two slugs that returned
the guest page today. Same machine, same client family, inverted outcomes two days apart. The rate
contrast is also on record: the sweep's own 59 requests (33 of them LinkedIn-facing) spread over 32
minutes never triggered the blanket, while the diagnosis loop's ~50 requests in ~3 minutes did — a
rate-shaped bot-management response, not a UA rule.

### 9.4 What it changes for the app

1. **§6.2's authwall landing is not evidence about the subject.** The app's own bounded render ran
   inside its own heated window (the operation had just spent ~200 requests), and the same renderer
   lands on the same join form for a control slug under the blanket. Treat that observation as "this
   client was not served a page", nothing more. The authwall page itself was also inspected in a real
   anonymous browser (75 KB, 413 readable bytes): it carries no member name, slug or headline — no
   identity salvage there either.
2. **The app can publish a false `unavailable` verdict.** The stub's `authwall` redirect is what
   `readSocial` keys on (`research-readers.ts:2351` → `login-required` at `:2424`), and the two
   regimes are byte-identical, so a queued refresh or a batch that trips the blanket mid-run will
   record wall verdicts for profiles that are public — and the result is persisted. `[INFERENCE]`
   from the code path plus the byte-identical bodies; not reproduced end-to-end today.
3. **A behavioural discriminator is the only detector.** Since the two regimes are byte-identical,
   the fix cannot live in response parsing: it needs a *known-good control* read (a public slug the
   reader has succeeded on recently) plus a cadence/backoff rule, and it should downgrade the
   verdict to "not served to this client; cause unresolved" rather than implying a wall.

### 9.5 Route matrix actually exhausted for the subject

| Family | Tried | Result |
| --- | --- | --- |
| Direct guest page | curl UA, Chrome UA, full Chrome header set, Bun/undici stack, real curl stack | 999 on every shape; controls 200 in the same seconds |
| Mobile surface | iPhone Safari header set | control A 200 (`public_profile_v3_mobile`, name parsed); control B, both freshes and the subject 999 — the guest page exists on this surface, the subject is refused |
| URL shapes | trailing slash, `?trk=public_profile`, `?locale=en_US`, `?original_referer=google`, `/en`, `?lipi=…`, `/pub/dir/Sheila/Warrick` | 999 on all seven |
| Anonymous browser | real Chrome 153, fresh profile, no cookies, `navigator.webdriver=false`, headed, over CDP | stub → `/authwall` join form; no identity in the 75 KB page |
| Other LinkedIn surfaces | jobs guest API, company guest pages, `/pub/dir`, robots | jobs/company work and carry no person data; person namespace refused |
| Not yet probed (queued in the cool window) | `m.linkedin.com/in/<slug>`, `/public-profile/in/<slug>`, `/people-guest/people-search?keywords=…`, `/directory/people-sheila/`, plus the nonexistent-slug control in the fetch mode and in a real headless-Chrome page load (the production renderer is a separate leg, present only when the app container runs — §9.6) | `/people/search/`, `/people-guest/` and `/public-profile/` appear in LinkedIn's own robots disallow lists and were never probed by any lane; the control settles whether a red row proves existence-plus-gating or nothing at all (§9.6) |
| Archives | Wayback (replay, availability, CDX), archive.today, Arquivo.pt (CDX, timemap, textsearch), Common Crawl, GhostArchive | no capture in any of them; GhostArchive answers "Page 0 out of 0", and Common Crawl's 2026-34 index returns 404 for the slug **and for `billgates`** — LinkedIn names `CCBot` in robots, so no crawl holds any `/in/` page, which is why crawls were already dropped as a visibility proxy (§7). |
| Keyless renderers/proxies | Microlink, Jina Reader, codetabs, allorigins, corsproxy, urlscan, Google cache | refused, empty, or retired |
| Search indexes | Bing (`site:`, quoted URL, name), DuckDuckGo, Google, Startpage, Mojeek, Marginalia, SearXNG, Mwmbl, Wiby | **the index lane is void, not negative.** Bing's SERPs decode to filler for every one of these queries (barcode generators for the `/posts` query, SOC-2 pages for the name, calculator sites for the slug) — a degraded or substituted SERP backend on this machine, so "nothing indexed" is not established and is not used anywhere in this document as evidence of non-publicness. The app's own 22 discovery queries ran into the same wall (`document-empty | html-reader | https://www.google.com/search?q=Sheila+Warrick`). |
| Path diversity | IPv6 egress | none on this host (LinkedIn resolved to an IPv4-mapped address); no second identity |
| Named mirrors / registries | Wellfound, RocketReach, Success.ai, ZoomInfo title, The Org, Apollo, SignalHire, ContactOut, Crunchbase, Backstage, ORCID, Crossref, Wikidata P6634, DataCite, EDGAR, NPPES, VIAF, Open Library | person data exists under name similarity only (see §5); nothing attaches any of it to the slug |

Nothing in this matrix changes the verdict: the page is not served to this client, and the only
remaining way to read it is authenticated access — out of posture — or the member changing her
profile's visibility.

### 9.6 Scheduled confirmation

Two controls were still missing clean readings when regime B arrived, and one of them decides the
verdict:

- **The nonexistent slug.** A bot-scored client can receive the same 999 stub for "this profile is
  not publicly served" and for "this vanity URL does not resolve". The battery therefore fetches
  `/in/zzzzz-does-not-exist-9f3k` **in the same batch as the subject**, in the same fetch mode and
  in a real headless-Chrome page load. Those renderer legs are stock
  `--headless=new --dump-dom` loads, not the application's production renderer;
  `tooling/recovery-battery-v2.sh` adds one production-renderer render of each URL when the app
  container is running and logs a SKIPPED row when it is not, because the detached battery cannot
  require a container. If the nonexistent slug returns the stub too, the subject's red row proves
  neither state; if it 404s or renders a not-found guest page while the subject keeps 999/authwall,
  existence-plus-gating is established and the remedy changes accordingly.
- **Subject URL namespaces never probed by any lane**: `m.linkedin.com/in/<slug>`,
  `/public-profile/in/<slug>`, `/people-guest/people-search?keywords=…`, `/directory/people-sheila/`
  and the subject without `www`.

A detached watcher (`tooling/recovery-battery-v2.sh`, v1 at
`tooling/recovery-battery.sh`) enforces **silence-then-single-probe**: one
validate request against a known-public slug, preceded by a silent window that doubles after every
red reading (20 min, 40, 80, …), because a fixed 15-minute cadence kept the blanket hot for three
hours. Only a validated green reading starts the battery — one request per shape, plus one real
headless-Chrome page load for the subject and one for the control (and, when the app container is
running, one production-renderer render of each), no retries — and the run exits.
Findings land in `.scratch/linkedin-anon-routes/raw/recovery-watch.log` and supersede this section.

**Request ledger and posture.** Every LinkedIn-facing request this diagnosis made is counted:
33 during the 32-minute sweep (B lane), ~50 in the three-minute burst that tripped the blanket,
and one per 15 minutes afterwards. That is far above the earlier sweeps' LinkedIn budget
(robots.txt plus one or two Help pages), and the burst is what produced regime B — which is why
the recovery measurement above had to be redesigned around silence. The probe matrix is
*characterization*: §10.1 states the posture boundary and the two diagnosis-only shapes.

---

## 10. Review pass, same day: prior art, corrections, and three verified code facts

A read-only overlap pass (subagent `OverlapClassify`, transcript at
`history://OverlapClassify`) compared this document against the cluster
(`linkedin-reading-options.md`, `linkedin-cookies-and-access-sweep-2026-09-18.md`,
`person-research-without-linkedin-authentication.md`, `anti-bot-keyless-search.md`,
`github-awesome-harvest-2026-08-30.md`, `person-research-github-patterns.md`, and the decisive
`public-search-providers.md`). Everything it asserted that this section relies on was re-checked
in the files first-hand.

### 10.1 Prior art: what this document did not discover

- **The working route was already in the repo, already probed, already classified.**
  `public-search-providers.md:317-352` ("LinkedIn — the route map", live-probed 2026-09-01) records
  the logged-out `/in/<slug>` fetch returning "HTTP 200, ~819 KB guest preview with headline/role
  tokens — **works today**" and marks it posture **(b) / "Do not adopt"**. That is the same route
  §1 of this document re-verified. The contribution here is the *verification* — several slugs with
  same-client controls, the per-slug gate, the volume gate, the route matrix, and the app-posture
  analysis — not the discovery.
- **The shape of regime B is already documented for another provider.** `providers/mojeek.ts:8-19`
  states Mojeek's "anti-bot gate is intermittent and volume-based, not UA-fingerprinted — live
  2026-09-02: the same UA was challenged under probe bursts and passed when quiet, whatever the
  header set". §9.2's finding is the same class of gate, measured on LinkedIn.
- **Negative conclusions the cluster already reached and this document does not need to re-argue**:
  every maintained OSS scraper needs `li_at` (`github-awesome-harvest-2026-08-30.md` §4.1-4.3,
  incl. `LinkedInDumper`, `playwright_stealth`, Apify actors); no Invidious-like keyless frontend
  exists; archive.today and the Google/Bing caches are dead for this purpose; Mojeek has a
  `site:linkedin.com/in` coverage gap; Wikidata P6634 and ORCID `researcher-url`s are the two
  keyless *slug seeders*; robots.txt forbids the whole surface and the header forbids automated
  access. A candidate repo that only re-packages UA spoofing or stealth adds nothing.
- **Stale record, arising from this document**: `eligibility.ts:479-488` excludes the `linkedin`
  route because *"No keyless anonymous read exists."* That reason is now false (the read exists
  from a browser-shaped client outside regime B). The *exclusion* may still be the right verdict —
  on posture grounds (§8 item 3) — but it should be re-decided by an ADR rather than resting on a
  negative that no longer holds. A second live-status field is stale the same way: `eligibility.ts`
  carries the `dblp` route as `LIVE` (`:289-297`), while §4 of this document observed DBLP's
  Anubis anti-bot page instead of JSON; `providers/dblp.ts:42-45` already reflects that in its
  comments, so the eligibility record is what needs the update.
- **One mechanism caveat, not a correction.** §4 reads today's Mojeek failure as a network-layer
  block (403 for a plain UA) and says so "nuances" the standing coverage-gap framing
  (`public-search-providers.md:341`, `providers/mojeek.ts:8-19`: an intermittent, volume-based gate
  that is *not* UA-fingerprinted, plus a `site:linkedin.com/in` index gap). Both can be true at
  different times — the standing records were measured 2026-09-01/02, today's was a burst-adjacent
  single probe — and the volume-based mechanism is the one that matches §9.2. Read §4 as a
  same-day observation, not as a refutation.
- **Probe posture, stated once.** Two shapes in this document are *diagnosis only* and are not
  proposed for production: the per-shape UA variants (§4, used to test whether the refusal was
  client-shaped) and the CDP attach with automation signals suppressed (§9.2 Run 3, used to show a
  real browser took the same blanket). Production stays with the shipped exceptions: no stealth
  tooling, no cookie import, no proxy, no CAPTCHA interaction, no per-shape UA hunting.
- **Small doc/code divergence, out of scope here**: `http.ts:33-37`'s comment names Mojeek among the
  providers using `browserUserAgent`, but only `duckduckgo.ts:48` imports the constant, and
  `mojeek.ts` documents the opposite practice deliberately. Worth one line in a cleanup PR; not
  touched by this one.
- **Three framing differences left open on purpose** (they need a decision, not a fact):
  (i) this document treats broker-sourced person data as out of posture, while
  `linkedin-reading-options.md` §4.2 holds dataset vendors posture-clean and terms-colliding;
  (ii) `linkedin-cookies-and-access-sweep-2026-09-18.md:53-56` records that robots.txt disallows
  `/authwall` even for Googlebot/Bingbot, while §2 above records the served page's `<meta
  name="robots">` — a robots.txt rule and a meta directive are different instruments, and which one
  governs an index reference was not established here; (iii) `person-research-without-linkedin-authentication.md`
  §4.2 proposed schema.org JSON-LD Person extraction, which has no target on the guest profile page
  (§2: its single `ld+json` block is an `Article`) though it still applies to third-party pages
  that carry Person JSON-LD.

### 10.2 In-scope routes neither this document nor the cluster tried

Listed for the *identity bootstrap* lane (they surface a name or a slug, never the profile page),
all keyless and anonymous, none attempted here: Common Crawl's **CDX index catalogue** (ADR-0072
keeps the index reachable while excluding capture retrieval), Internet Archive **item metadata**
(`advancedsearch.php`), GDELT, Internet Archive TV News, GLEIF, Europe PMC, StackExchange, Arctic
Shift / Reddit RSS, PeerTube and Sepia search, Wikipedia opensearch, Yandex and Stract, and
LinkedIn's **country-subdomain namespaces** (`uk.linkedin.com/in/…` and peers — a URL namespace no
lane probed; the battery now carries `m.linkedin.com` and `/public-profile/` alongside it).
`[UNVERIFIED]` as to yield: the read-only pass listed them as untried, and no request was made.

### 10.3 Verified: the app's 0 sources is structural, not a wall artifact

`decideIdentity` (`apps/server/src/person-profile/research.ts:1977`) decides attribution in this
order: a private transcript; then a URL that equals a `profileUrls` entry or a matched source
(`:1997-2001`, anchor `signal`); then an email; and then the name.
`const name = profile.fullName ? foldName(profile.fullName) : null; if (!name || !foldName(read.text).includes(name)) return { decision: "unmatched" … }`
(`:2043-2048`). **While `fullName` is null, every public document exits `unmatched` before the
employer check ever runs** unless its URL is the profile's own. And the name-only `probable`
branch requires `corroborating.length === 0 && profile.emails.length === 0 && profile.profileUrls.length === 0`
(`:2101-2110`) — which a URL-only profile never satisfies, so even a same-name document is
`unmatched` ("The name appears but none of the Profile's other signals do").

So for `person_9b03430009cb` (URL only, `sources: 0`, `requests: 96`, `conclusion: bounded`) the
fresh run's zero sources is a property of the profile's signal set, not only of the wall and the
namesake noise. The operations in this tree retained *dozens* of correctly-`identity-unmatched`
documents about other Sheila Warricks; none could ever match. **The unblock is one of two things**:
an owner correction that adds a name and an employer (a new profile revision), or the #445
bootstrap surfacing a SERP result that carries her profile URL — which is also the only event that
would let the URL signal do the matching. No retry of the existing repair changes either.

### 10.4 Verified: a re-run will not re-ask the seed queries

`research-queue.ts` dispatch: an explicit request on an existing job keeps the checkpoint when the
previous conclusion is `bounded` or `interrupted` (`:352-372`; the comment: "the new allowance
resumes the retained traversal rather than rereading it") and the checkpoint is deleted only for
`reason === "evidence"`, a changed `profileRevision` (`:322-323`), or a conclusion outside
`bounded`/`interrupted`. The subject's job is `conclusion: bounded` with
`checkpoint.profileRevision: 1` and 179 visited targets — including all four seed queries. A
post-recovery run therefore **resumes**; it does not mint the fresh traversal that #445's bootstrap
needs. The run that exercises the bootstrap is the one that follows a revision/evidence change.

### 10.5 Verified: the wall branch is correct, and the retention hole is narrower and sharper

- **Reachability correction.** `readPersonSource` classifies `linkedin.com` as `public-social`
  (`research-readers.ts:195-241`) → `readSocial`; the reader body is entered only under
  `response.status < 400 && !challenge && !wallMarker` (`:2359`). A 999 therefore takes the wall
  branch and **never reaches `readHtml` or `tryRender`** — the earlier reading that a walled direct
  response could still be rendered is wrong, and §6.1's observation stands as written.
- **The reachable bad shape is a marker-less 2xx**, and it is not hypothetical: the production
  renderer's own result for the subject was `status 200`, `finalUrl /authwall`, `challenge: null`,
  `socialWallMarker: null`, **`accepted: true`**, `readableBytes: 1642`, no profile name (§6.2).
  The same acceptance predicates `tryRender` applies (`research-readers.ts:1076-1084`) would accept
  that body on the direct path too.
- **The retention link.** `decideIdentity` is called with `pending.url` — the *requested* URL
  (`research.ts:947`) — and matches it against `profileUrls` (`:1997-2001`). `retain()` keys the
  `self-report` classification on `read.finalUrl` instead (`:2129-2140`). So a join-form body
  accepted as `retrieved` would be recorded as `matched`/`signal` on the strength of the request,
  retained with `access: retrieved`, and extracted — while *not* being labelled a self-report,
  because the final URL is `/authwall`. That is the precise shape of the constraint-3 violation
  (sign-in shell treated as profile content), and it is why the guard fix in §8 item 2 is not
  cosmetic: extending the marker lists to the join-form phrases and treating a `/authwall` final
  URL as a wall closes both the render path and this direct path.

---

## Appendix: provenance

- **A — GitHub code harvest.** Awesome-list corpus (brandonhimpfen/awesome-linkedin,
  awesomelistsio/awesome-linkedin, jivoi/awesome-osint, lorien/awesome-web-scraping,
  The-Web-Scraping-Playbook/awesome-linkedin-scrapers), `gh search code`/`repos`, grep.app; 30+
  repos cloned at pinned HEAD shas; one candidate executed (its live smoke test + its parser
  against live responses). Fragment: `.scratch/linkedin-anon-routes/A-github-code-examples.md`
  (413 lines).
- **B — live routes.** 59 single-shot requests, 2026-09-18 07:38–08:10Z, raw bodies and headers in
  `.scratch/linkedin-anon-routes/raw/` (91 files). Fragment:
  `.scratch/linkedin-anon-routes/B-live-routes.md` (345 lines).
- **C — public surfaces.** 40-plus single-shot anonymous GETs on 2026-09-18 across person-profile
  mirrors, venue pages, PII brokers and the keyless registries (plus `robots.txt` reads and
  Common Crawl index records), with the control subject run through the same probe set. Raw
  evidence in `.scratch/linkedin-anon-routes/raw/` (`live/`, `registry-*.json`, `*.robots.txt`).
  Fragment: `.scratch/linkedin-anon-routes/C-public-surfaces.md` (243 lines).
- **D — application posture.** The shipped reader's diagnostics for operation
  `df6333f2-…` (workspace `person-research.json`, 525 diagnostic entries read), one bounded render
  as §6.2, plus the local #423 journey evidence
  (`artifacts/person-profile-remediation/20260918T035740Z-issue-423-journeys/logs/`, whose
  `diagnostics-richardachee.json` / `-joseceresc.json` / `-shaye-james-b85087143.json` supply the
  last row of §6.2). Fragment: `.scratch/linkedin-anon-routes/D-app-render-posture.md` (153 lines).
