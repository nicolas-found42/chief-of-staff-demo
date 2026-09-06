# Person research source eligibility

Recorded 2026-09-06 for issue #228. The executable registry is
`apps/server/src/source-adapters/eligibility.ts`; reproduce its anonymous smoke probes with
`pnpm exec tsx scripts/person-research-benchmark.mts --probe-sources`.

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
session. The probe rerun does not constitute a fresh legal/terms audit of every route or of the
incumbent provider bundle. Public metadata access does not grant blanket permission to retain
linked full text. That audit and end-to-end source-family evidence remain separate acceptance work.

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
