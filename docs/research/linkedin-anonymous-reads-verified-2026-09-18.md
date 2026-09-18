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
  "LinkedIn's robots.txt disallows archive bots" is not accurate — no archive bot is named at all.

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
  `providerQuery` (`apps/server/src/source-adapters/search.ts:568`) returns `null` for `orcid`,
  `ror` and `artic` when that name is empty. For a URL-only profile it is empty — so **the whole
  registry lane is skipped**, which is why the operation's diagnostics contain no `orcid.org`
  target at all while its `Sheila Warrick publications` query ran against the SERP providers.
- The only thing that fills that name is the #445 Identity Bootstrap, and it adopts from SERP
  results whose URL/title carries the slug — which requires the profile page to be *indexed*
  somewhere. For `sheilawarrick` it is not indexed (B §4, C §1), so adoption never fired.
- Net for this profile: **no name → no registry query → no identity anchor → no name.** The
  registry routes exist in production; nothing asked them.

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
`/usr/local/bin/browser-network-sandbox` (`apps/server/src/source-adapters/browser.ts:113`):

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
   always earn a browser-render attempt?* — For `richardachee` and `joseceresc` the render is what
   produced the retained article records; for `sheilawarrick` it is what proved the wall
   (§6.2). The shipped reader short-circuits at the direct-response wall and therefore never asks.
2. **If 1 is answered yes, the guard must change in the same commit.** Otherwise the render's
   authwall landing page is accepted and retained (§6.3) — the exact failure #423's constraint 3
   forbids. The cheap shape: extend `detectChallenge`-style detection to the rendered body (authwall
   selectors and the join-form phrases), and treat a render whose final URL is `/authwall` as a
   wall regardless of body.
3. **No posture change is needed to keep the working cases working.** The browser route is already
   a real anonymous browser; the direct transport already retrieves guest pages sometimes with an
   honest UA. The candidate repo's browser-UA declaration is not required by the app, so the
   "control evasion" judgment call in A §4.1 does not have to be made.
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

The stub served while blanketed hashes to `895d2a337cecd4bf36e6ff9a7e669a63` — **the same body** as
the subject's per-slug refusal and as Jose's early-morning refusal. Status, size, headers and
Cloudflare markers are identical: **nothing on the wire separates "this profile is not served
anonymously" from "this IP is throttled right now."**

Recovery, sampled one request per 4 minutes with a fresh slug and then, when that failed to lift it,
one request per 10 minutes after total silence: red at 08:15, 08:19, 08:22, 08:26, 08:30, 08:34,
08:38, 08:50, 09:00 and 09:10Z — a window of **at least 57 minutes**, long-lived rather than a
momentary rate limiter. A detached watcher keeps validating and will run the missing controls
(the nonexistent-slug battery below) on the first green window.

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
| Search indexes | Bing (`site:`, quoted URL, name), DuckDuckGo, Google, Startpage, Mojeek, Marginalia, SearXNG, Mwmbl, Wiby | no result anywhere carries the slug; nothing indexed under `sheilawarrick` at all |
| Archives | Wayback (replay, availability, CDX), archive.today, Arquivo.pt (CDX, timemap, textsearch), Common Crawl | no capture in any of them |
| Keyless renderers/proxies | Microlink, Jina Reader, codetabs, allorigins, corsproxy, urlscan, Google cache | refused, empty, or retired |
| Path diversity | IPv6 egress | none on this host (LinkedIn resolved to an IPv4-mapped address); no second identity |
| Named mirrors / registries | Wellfound, RocketReach, Success.ai, ZoomInfo title, The Org, Apollo, SignalHire, ContactOut, Crunchbase, Backstage, ORCID, Crossref, Wikidata P6634, DataCite, EDGAR, NPPES, VIAF, Open Library | person data exists under name similarity only (see §5); nothing attaches any of it to the slug |

Nothing in this matrix changes the verdict: the page is not served to this client, and the only
remaining way to read it is authenticated access — out of posture — or the member changing her
profile's visibility.

### 9.6 Scheduled confirmation

One control is still missing a clean reading, because regime B was in force by the time the loop
reached it: **the nonexistent slug**. The distinction it settles is between "999 means this page is
not publicly served" and "this page is refused while comparable pages are served". A detached
watcher (`tooling/recovery-battery.sh`) polls a known-public slug every 15 minutes and, on the first
reading where that slug returns the guest page, immediately fetches — one request each — the
nonexistent slug `/in/zzzzz-does-not-exist-9f3k`, the second failing slug, the subject, the subject
without `www`, `/pub/dir?firstName=Sheila&lastName=Warrick`, `/directory/people-sheila/`, and one
genuine headless-Chrome dump of the subject. Its findings land in
`.scratch/linkedin-anon-routes/raw/recovery-watch.log` and supersede this section.

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
