# Person research source eligibility

Recorded 2026-09-06 for issue #228. The executable registry is
`apps/server/src/source-adapters/eligibility.ts`; reproduce its anonymous smoke probes with
`pnpm exec tsx scripts/person-research-benchmark.mts --probe-sources`.

## The standing check (#230)

The registry now covers the whole configured collection — the incumbent ADR-0049 provider bundle
audited into it as well as the #228 expansion families — and every entry carries a structured
`cost`, not prose. `tests/src/unit/source-eligibility.test.ts` walks the routes production can
actually reach and fails when any of them costs a key, a payment, a sign-in, an imported session
or a paid proxy. A free tier that requires a key counts as keyed. The restriction is data
acquisition only; the application's configurable LLM inference providers are unaffected.

Two of its assertions are behavioural rather than declarative: it drives the real search composite
with the global `fetch` stubbed, so curated per-provider transports are visible, and fails on any
credential header or non-omitted credentials mode. It then walls every route with an HTTP 401 and
fails if a single new host is reached — a keyed or paid escalation from a failed anonymous route
would show up as that host.

Two entries are worth naming because they look like exceptions and are not. Marginalia's documented
anonymous path sends the literal published constant `API-Key: public`, which is contended across
every caller and issued to nobody; the check pins that literal, so a key that ever becomes *obtained*
stops passing. SEC EDGAR requires a declared contact in the User-Agent, which identifies the caller
rather than authenticating it, and grants no access another caller cannot get by declaring its own.

A route that fails its probe stays in the record as an explicit gap rather than being deleted.

The latest run received HTTP 200 and parseable JSON from all 15 probed routes. Three other
entries record exclusions or prior unavailability and were **not probed** by this command.
The CLI's “18/18 answered as documented” includes those three entries; it does not mean 18
successful live probes. A JSON response establishes anonymous endpoint access, not useful
person evidence, source independence, full-text rights, or successful dossier extraction.

| Route | Primary documentation | Probe result |
| --- | --- | --- |
| MWMBL | [API](https://api.mwmbl.org/) | 200, JSON |
| PeerTube / Sepia Search | [REST API](https://docs.joinpeertube.org/api-rest-reference.html) | 200, JSON |
| Apple podcast directory | [Search API](https://performance-partners.apple.com/search-api) | 200, JSON |
| Bluesky | [AT Protocol guide](https://docs.bsky.app/docs/advanced-guides/atproto) | 200, JSON |
| Mastodon | [Accounts API](https://docs.joinmastodon.org/methods/accounts/) | 200, JSON; anonymous access remains instance-dependent |
| Crossref | [REST API](https://api.crossref.org/swagger-ui/index.html) | 200, JSON with JSON Accept header |
| DataCite | [API](https://support.datacite.org/docs/api) | 200, JSON with JSON Accept header |
| Open Library | [API](https://openlibrary.org/developers/api) | 200, JSON |
| NPPES | [API](https://npiregistry.cms.hhs.gov/api-page) | 200, JSON |
| ClinicalTrials.gov | [API v2](https://clinicaltrials.gov/data-api/api) | 200, JSON |
| Nonprofit Explorer | [API](https://projects.propublica.org/nonprofits/api) | 200, JSON |
| TVMaze | [API and licensing](https://www.tvmaze.com/api) | 200, JSON |
| Library of Congress | [JSON API](https://www.loc.gov/apis/json-and-yaml/) | 200, JSON |
| Art Institute of Chicago | [API](https://api.artic.edu/docs/) | 200, JSON |
| Common Crawl | [Index](https://index.commoncrawl.org/) | 200, index catalogue JSON; this does not prove capture-content retrieval |

These documentation links are the registry's recorded sources from the prior implementation
session. The probe rerun itself is not a terms audit. The bounded primary-document review below
was added later on 2026-09-06; it covers these fifteen expansion routes, not the incumbent
provider bundle. Public metadata access does not grant blanket permission to retain linked full
text. Unresolved terms and item-level rights remain explicit below.

| Unavailable or excluded route | Recorded reason | Remaining evidence limitation |
| --- | --- | --- |
| YouTube timed text | Earlier anonymous requests returned empty HTTP 200 bodies for listed tracks. No local transcription integration is available to person research. | The current probe command does not recheck these tracks. Publisher descriptions are not transcripts. |
| Podcast Index | API key and signed request required. | Excluded even if a keyed tier is free. |
| LinkedIn | Prior anonymous access encountered an authentication wall. | Do not infer that every URL requires login from hostname or HTTP 403 alone; a per-request body is needed for that diagnostic. |

Bluesky feeds may include other people's posts. Production now retains the per-post author,
post URI and repost marker instead of attributing every entry to the feed owner. The earlier
retained Gebru reference feed lacks these fields; its statements are not authored as personal
facts until original-post provenance is verified.

The benchmark uses temporary workspaces and existing configurable inference providers.
No source key, imported session, paid proxy, external message or Task is part of these probes.

## Primary-document eligibility review, 2026-09-06

Scope: public search/read routes only; no write, account, paid, or authenticated APIs. This review
does not change the frozen benchmark references or retroactively certify their retained excerpts.
“Verified” below means the stated primary documentation was inspected, not that all returned
items have reuse permission. The HTTP/JSON observations above remain the prior smoke results;
they were not rerun by this documentation review.

| Expansion route | Current anonymous-access evidence | Retention limits and disposition |
| --- | --- | --- |
| MWMBL | [Terms](https://api.mwmbl.org/static/terms-and-conditions/), effective May 10, 2025, explicitly allow basic search without an account. The linked service and terms rendered anonymously. | User contributions and crawler/index data use CC BY-NC-SA 4.0, subject to third-party rights. The terms prohibit scraping and excessive automated queries. This does **not** establish that every bounded API search is prohibited. Ordinary search discovery and retention/redistribution of index data are different uses: retain source pointers; do not describe copied result datasets as unrestricted or commercially licensed. The API's permitted automation volume is not specified in the inspected terms. |
| PeerTube / Sepia Search | [PeerTube search guide](https://docs.joinpeertube.org/use/search) describes global search through an external index; [REST reference](https://docs.joinpeertube.org/api-rest-reference) documents per-video licences, including reserved-rights choices. The earlier Sepia API probe was anonymous. | PeerTube's AGPL software licence does not license videos, descriptions, captions, or transcripts. Check the video's licence and publisher/instance terms. Sepia's page returned an app shell and its `/about` route was unavailable to this inspection; a separate current Sepia-specific service-terms review is **unverified**. Public search capability is established, blanket retention permission is not. |
| Apple podcast directory | [Search API](https://performance-partners.apple.com/search-api) documents public query URLs without a key and approximately 20 calls/minute, subject to change; it recommends caching. Documentation rendered anonymously. | Promotional previews, artwork, and other assets have store-promotion/display restrictions. Directory discovery does not license the podcast audio or publisher transcript. Use catalogue links for discovery; evaluate the publisher feed and text separately. No blanket licence for retained podcast text was established. |
| Bluesky | [API hosts/auth](https://bsky.network/docs/api-directory/) explicitly documents unauthenticated public AppView requests at `public.api.bsky.app`. [Terms](https://bsky.social/about/support/tos), updated August 14, 2025, and [developer guidelines](https://bsky.network/docs/developer-guidelines/) rendered anonymously. | Authors retain content ownership; Bluesky's operational licence is not a public-domain dedication. Preserve original author/post URI and repost attribution, and evaluate any retained quotation separately. Developer guidelines require a way to delete content on request and public developer contact information for services within their scope. A public read does not justify indefinite whole-feed copying or imply the feed owner authored reposts. |
| Mastodon | [Public-data guide](https://docs.joinmastodon.org/client/public/) explicitly describes anonymous account/status reads and warns that instance administrators can disable public timelines. Documentation rendered anonymously. | Access and terms are per instance. Software/docs licensing does not license user posts. The attempted `mastodon.social/terms` retrieval failed, so this review does **not** certify that instance's current retention terms. Public endpoint availability remains conditional; no universal Mastodon content licence is established. |
| Crossref | [REST API documentation](https://www.crossref.org/documentation/retrieve-metadata/rest-api/) was read through direct anonymous HTTP 200 after the initial web fetch failed. It expressly requires no sign-up; the polite pool uses contact information, not a key. | The same page permits use of almost all bibliographic metadata for any purpose, but specifically warns that abstracts may remain copyrighted by authors/publishers. Preserve DOI and metadata provenance; do not apply the metadata permission to abstracts or linked full text without their own rights basis. |
| DataCite | [REST API](https://support.datacite.org/docs/api) expressly separates unauthenticated Public API retrieval from authenticated Member API writes/private records. It asks frequent scripted clients to identify application and contact in User-Agent. | [Data File Use Policy](https://support.datacite.org/docs/datacite-data-file-use-policy), inspected through web retrieval, applies a CC0 waiver to the Data File while excluding rights in linked resources and individuals' privacy/publicity rights. That policy's scope is the Data File; it is not a licence for linked datasets or articles. Metadata retrieval is verified; verify the relevant metadata/licence representation before labelling a particular retained API field CC0. |
| Open Library | [API guidelines](https://openlibrary.org/developers/api) rendered via direct anonymous HTTP 200. Low-volume human-facing discovery is intended; bulk harvest, HTML scraping, and high-traffic backend use are discouraged/prohibited by the listed guidelines. Default limit 1 request/second; identified requests with application/contact receive 3/second. | [Using Open Library Data](https://openlibrary.org/help/faq/using), also directly read, asks contributors for CC0 and makes catalogue access/download available. This does not establish that book text, covers, or third-party descriptions share that licence. Use author/work catalogue records within rate limits, cache responses, and use dumps for bulk work. |
| NPPES | The API documentation routes returned only a JavaScript shell. [CMS's current public-access guidance](https://www.cms.gov/initiatives/burden-reduction/overview/interoperability/frequently-asked-questions/bulk-upload-reviewing-updating-digital-contact-information-national-plan-provider-enumeration-system) identifies the registry/API and public dissemination; [NPI files](https://download.cms.gov/nppes/NPI_Files.html) publishes current downloads. | This supports public provider-record discovery, with the prior anonymous API probe supplying observed access. The current API's detailed documentation/limits remain **unverified in this pass**. CMS explicitly warns that an NPI does not validate licensure or credentials. Restrict facts to the public record actually matched; avoid copying unrelated contact fields or implying clinical competence. |
| ClinicalTrials.gov | [Download guidance](https://clinicaltrials.gov/data-api/how-download-study-records) identifies public API data. The live API/docs and [terms URL](https://clinicaltrials.gov/about-site/terms-conditions) returned only an app shell during direct inspection; the primary-source search index exposed the terms text. | Indexed primary terms (dated January 31, 2023) describe free access, attribution, processing dates, updates/modifications, no proprietary claims, no promotional use of extracted emails, and third-party/international copyright caveats. Because direct terms text was not recovered, **current served terms verification remains incomplete**; do not infer that all trial submissions, protocols, or attachments are public domain. Sponsor/investigator submission is not independent validation by NIH. |
| Nonprofit Explorer | [API v2](https://projects.propublica.org/nonprofits/api) rendered anonymously and documents GET/JSON requests without credentials. It identifies IRS sources and warns that linked filing PDFs are rate limited. | [ProPublica's Data Store terms](https://projects.propublica.org/datastore/terms/) prohibit standalone redistribution/resale of covered raw data and require attribution. Their precise application to this separately documented API is **unverified**; the API page supplies no blanket retention licence. Do not automatically apply either its news-story licence or Data Store restrictions to every API field. Prefer independently retrieved IRS records when that resolves provenance and rights; inspect filing-specific content. |
| TVMaze | [API](https://www.tvmaze.com/api) rendered anonymously and documents public endpoints, at least 20 calls/10 seconds/IP, 429 backoff, and caching. | API data are CC BY-SA with attribution and ShareAlike obligations; the API page expressly permits use for any purpose under those conditions. Preserve TVMaze attribution/links and the licence. This is a verified conditional reuse route, not unrestricted `public-record` material or a licence for linked television/video works. |
| Library of Congress | [API limits](https://www.loc.gov/apis/json-and-yaml/working-within-limits/) and [legal overview](https://www.loc.gov/legal/) rendered through web retrieval; direct Python requests received 403. The legal page recommends at most 10 requests/minute across machines, respecting robots, and may terminate programs exceeding 24 hours. | The Library generally does not own collection-item rights. Item/collection Rights and Access statements control what can be reused; public-domain status must be established for the item, not inferred from `loc.gov` or JSON access. Public lookup remains supported, but returned creative works and images need individual assessment. |
| Art Institute of Chicago | [API documentation](https://api.artic.edu/docs/) rendered anonymously and documents public requests. The current schema identifies artwork `description` as CC BY 4.0; other artwork response data as CC0, both subject to site terms. | Preserve field-specific licence distinctions; do not mark every field CC0. The incorporated [site terms](https://www.artic.edu/terms) returned 403, leaving that part of the current review **unverified**. Image rights and linked media must be checked separately; a metadata response does not establish every image is public domain. |
| Common Crawl | [Index server](https://index.commoncrawl.org/) and [Terms](https://commoncrawl.org/terms-of-use), updated March 7, 2024, rendered anonymously. The prior probe tested only the index catalogue, not WARC capture retrieval. | Section 2(l) prohibits collecting personal information for use separately from Crawled Content; section 2 also preserves source-site terms and third-party rights. Dossier reuse is **unresolved**, not automatically permitted or categorically forbidden: retaining cited source content may differ from a separate extracted personal-data database, but the terms provide no explicit citation exception. Index discovery is distinct from capture retention. Do not certify personal-fact extraction from captures until that data flow is assessed against this restriction. |

The resulting engineering recommendations are specific rather than host-wide bans: enforce
provider-specific rate limits (notably Apple, Open Library, and LoC); preserve licence and
attribution metadata; keep abstracts, media, and linked full text out of blanket metadata rights
claims; and record incomplete verification as such. No production configuration change was
made by this audit. In particular, neither MWMBL's scraping clause nor Common Crawl's
separate-use clause has been inflated into a claim that all ordinary anonymous API discovery
is prohibited. The existing Podcast Index/key, YouTube caption-body, and observed LinkedIn
auth-wall exclusions above remain unchanged.

## Production-reader check: official Fowler testimony

At `2026-09-06T09:30:06.305Z`, an isolated `/private/tmp` harness called the actual
`readPersonSource` with production `publicHttpFetch` and `publicHttpFetchBytes`, an empty
snippet, a fresh `ResearchAttemptRecorder`, and a 25-second request limit. It used no model,
configuration credentials, live Workspace, mocked transport, or fixed-document replacement.
The URL was the [official Senate PDF](https://www.foreign.senate.gov/imo/media/doc/0a63ba71-93fa-f089-be57-fa00af74aad5/030624_Fowler_Testimony1.pdf).

Observed result: `route: document-reader`, `family: documents-publishers`,
`access: retrieved`, `completeness: full`, 7,154 text characters, with both `Cary Fowler`
and `Deputy Coordinator for Diplomacy` present. Extracted-text SHA-256:
`db30dd96eea4639466a8b9efd37cf841586eaccdbeb6c81a9d560e655a7b5415`.
No failed attempts were recorded; the reader returned no page anchors. The production family
is therefore `documents-publishers`, despite the document's institutional provenance; this
does not prove incremental source-family coverage in a benchmark. Its substantive credit and
rights assessment is in
[the primary-credit note](person-benchmark-primary-credit-validation-2026-09-06.md).
Temporary reproduction files: `/private/tmp/issue-228-senate-reader.mts` and
`/private/tmp/issue-228-senate-reader.json`. Their salient observations are retained here because
temporary files may expire. No benchmark corpus or reference version was changed.

## Publication and deposit record routes, 2026-09-07

Recorded for issue #249, which reads publication and deposit records as evidence rather than as
catalogue hits. Reading one record by identifier is a different endpoint from searching an index,
so the three read routes carry their own entries in `eligibility.ts` — `crossref-record`,
`datacite-record` and `openalex-record` — each with the terms read today and its own anonymous
probe. The search entries for the same indexes are unchanged apart from Crossref's documentation
link and OpenAlex's terms, both of which had drifted (below).

| Route | Terms read 2026-09-07 | Anonymous probe |
| --- | --- | --- |
| `crossref-record` | [REST API documentation](https://www.crossref.org/documentation/retrieve-metadata/rest-api/): "No sign-up is required to use the REST API, and almost none of the metadata is subject to copyright, and you may use it for any purpose. Some abstracts contained in the metadata may be subject to copyright by publishers or authors." | `https://api.crossref.org/works/10.1126%2Fscience.1225829` — 200, 10,237 bytes, parseable JSON |
| `datacite-record` | [Data File Use Policy](https://support.datacite.org/docs/datacite-data-file-use-policy) (page updated 2026-08-07): CC0 over the Data File — "all DOIs and deposited metadata" — with the waiver expressly not reaching linked resources or the privacy and publicity rights of the individuals described. The [API guide](https://support.datacite.org/docs/api) separates the unauthenticated Public API from the authenticated Member API. | `https://api.datacite.org/dois/10.5281%2Fzenodo.31780` — 200, 5,038 bytes, parseable JSON |
| `openalex-record` | [API authentication](https://help.openalex.org/api/authentication/): "OpenAlex data is free, and so is casual use of the API — you can make basic queries with no key at all." A free key needs an account and raises the daily budget tenfold; beyond that, [pricing](https://help.openalex.org/access/pricing/) is pay-as-you-go. The API reference states the data are CC0. | `https://api.openalex.org/works/W2045435533` — 200, 34,375 bytes, parseable JSON |

### OpenAlex's terms moved, and the registry said otherwise

The prior entry recorded "free and keyless; a mailto contact joins the polite pool" against
`docs.openalex.org`, which now redirects to a help centre that does not carry that page. The
current model is a budget: an anonymous request on 2026-09-07 answered 200 and reported its own
keyless allowance in `x-ratelimit-limit: 1000` / `x-ratelimit-limit-usd: 0.1`, shared per IP and
reset at midnight UTC. A free API key needs an account, which #228 excludes exactly as it excludes
a free tier behind a key, and larger budgets are paid. The route stays eligible for as long as the
keyless tier answers; a 429 here is budget exhaustion and is never answered with a key.

### What a retained record may be used for

Each retained record now carries its rights per material rather than one verdict for the whole
response, because the permissions genuinely differ inside one body:

- **Metadata** is retained under the index's own documented permission, named in the record.
- **An abstract** is retained only where the record declares a licence over the deposited resource
  itself — a DataCite `rightsList` entry, say. Crossref's metadata permission expressly stops short
  of abstracts, and a Crossref `license` entry describes the version of record rather than the
  abstract field, so a Crossref abstract is withheld with that reason recorded. OpenAlex ships the
  abstract only as an inverted index, which is not reconstructed into retained text.
- **Linked full text** is never fetched under a metadata permission. The link is kept as a lead, to
  be read under whatever its own route establishes.

A person's appearance in a record establishes participation in the work it describes. It does not
establish the scope of their individual contribution, so the rendering states that limit and the
extraction path drops the personal-scope fields of a Work Record — the contribution and the
authority roles — when a publication or deposit record is the only source behind them. A later
source that does state a contribution still fills them in.

A DOI is one namespace over several registration agencies, so a DOI the work index does not hold is
stepped down to the deposit index before the human-facing page is tried; the 404 is recorded as an
alternative-route attempt rather than as a failure to read the record.

None of these routes needs a key, a payment, a sign-in, an imported session or a paid proxy. No
production configuration changed in this audit beyond the corrected OpenAlex terms.

The registry's own probe command (`--probe-sources`) was run on 2026-09-07 and reported
`crossref-record`, `datacite-record` and `openalex-record` answering 200 with the expected shape,
alongside the routes it already probed. One unrelated observation from the same run belongs here
rather than in a commit message: `open-library` reported `Probe failed: fetch failed`, while the
same URL answered 200 to a direct request seconds later — a transient result on a route this
ticket did not touch, recorded so a later run does not read it as new.
