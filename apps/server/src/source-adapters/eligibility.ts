import { createHttpFetch, publicHttpFetch, type PublicHttpFetch } from "./http.js";

/**
 * What every research source route costs to use, and how that was established.
 *
 * Issue #228 forbids data acquisition that needs an API key, a payment, a
 * source sign-in, an imported session or a paid proxy — including free tiers
 * that require a key. A catalogue entry saying "free" does not establish any
 * of that, so each route here carries two independent things: the access terms
 * read from the source's own current documentation, and a probe that a
 * developer can run to see what the route actually answers today.
 *
 * A route that fails its probe stays in this table as an explicit gap. Deleting
 * it would turn "we cannot read this" into "there was nothing to read", which
 * is the confusion the whole benchmark exists to remove.
 */
interface SourceEligibility {
  /** The route's name, matching the search provider or reader that uses it. */
  route: string;
  family: string;
  /** What the source's own documentation says anonymous access requires. */
  terms: string;
  /** Where that was read. */
  documentation: string;
  /** Whether the route is used in production today, and why not when it is not. */
  status: "in-production" | "excluded" | "unavailable";
  /** Why an excluded or unavailable route is not used. */
  exclusion?: string;
  /** A probe URL that needs no key and returns a small anonymous response. */
  probe?: string;
  /**
   * Some routes serve JSON only to an explicit accept header and answer 406 or
   * 500 to the shared transport's HTML-first list. The probe has to ask the
   * same way production does or it measures the wrong thing.
   */
  probeAccept?: "json";
  /** What a healthy probe answer looks like, beyond a 200. */
  expect?: (body: string) => boolean;
}

/** The transport the JSON-only routes are actually reached with. */
const jsonFetch = createHttpFetch({ headers: { accept: "application/json" } });

const json = (body: string) => {
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
};

const SOURCE_ELIGIBILITY: SourceEligibility[] = [
  {
    route: "mwmbl",
    family: "general-discovery",
    terms: "Open, non-commercial web index; public API needs no account or key.",
    documentation: "https://api.mwmbl.org/",
    status: "in-production",
    probe: "https://api.mwmbl.org/api/v1/search/?s=climate",
    expect: json,
  },
  {
    route: "peertube",
    family: "spoken-evidence",
    terms: "Sepia Search indexes public PeerTube instances; the REST API is unauthenticated.",
    documentation: "https://docs.joinpeertube.org/api-rest-reference.html",
    status: "in-production",
    probe: "https://sepiasearch.org/api/v1/search/videos?search=climate&count=2",
    expect: json,
  },
  {
    route: "podcast-directory",
    family: "spoken-evidence",
    terms: "Apple's public search endpoint; no key, rate limited by IP.",
    documentation: "https://performance-partners.apple.com/search-api",
    status: "in-production",
    probe: "https://itunes.apple.com/search?media=podcast&term=agriculture&limit=2",
    expect: json,
  },
  {
    route: "youtube-captions",
    family: "spoken-evidence",
    terms:
      "The watch page lists caption tracks anonymously, but the timed-text endpoint now answers an empty body without a proof-of-origin token.",
    documentation: "https://www.youtube.com/watch",
    status: "unavailable",
    exclusion:
      "Observed 2026-09-06: every listed track returned HTTP 200 with a zero-byte body in every format (srv1, srv3, json3, vtt, ttml). Research falls back to the publisher's video description and records the gap. Local transcription would be the next route and is not installed on this host.",
  },
  {
    route: "podcastindex",
    family: "spoken-evidence",
    terms: "Requires an API key and a signed request.",
    documentation: "https://podcastindex-org.github.io/docs-api/",
    status: "excluded",
    exclusion: "A key is required, which #228 excludes even where the tier is free.",
  },
  {
    route: "bluesky",
    family: "public-social",
    terms: "public.api.bsky.app serves the app view for public data with no authentication.",
    documentation: "https://docs.bsky.app/docs/advanced-guides/atproto",
    status: "in-production",
    probe: "https://public.api.bsky.app/xrpc/app.bsky.actor.searchActors?q=climate&limit=2",
    expect: json,
  },
  {
    route: "mastodon",
    family: "public-social",
    terms:
      "Public account lookup and public statuses are readable without a token on instances that have not disabled anonymous reads.",
    documentation: "https://docs.joinmastodon.org/methods/accounts/",
    status: "in-production",
    probe: "https://mastodon.social/api/v1/accounts/lookup?acct=Gargron",
    expect: json,
  },
  {
    route: "linkedin",
    family: "public-social",
    terms: "Anonymous requests are met with an authentication wall.",
    documentation: "https://www.linkedin.com/robots.txt",
    status: "excluded",
    exclusion:
      "No keyless anonymous read exists. Research records a login-required failure for a LinkedIn URL rather than importing a session or using a paid proxy.",
  },
  {
    route: "crossref",
    family: "published-work",
    terms: "Free REST API; a mailto contact joins the polite pool. No key.",
    documentation: "https://api.crossref.org/swagger-ui/index.html",
    status: "in-production",
    probe:
      "https://api.crossref.org/works?query.bibliographic=Doudna&rows=2&mailto=owner@found42.local",
    probeAccept: "json",
    expect: json,
  },
  {
    route: "datacite",
    family: "published-work",
    terms: "Public REST API over DOI metadata; no key for search.",
    documentation: "https://support.datacite.org/docs/api",
    status: "in-production",
    probe: "https://api.datacite.org/dois?query=Doudna&page%5Bsize%5D=2",
    probeAccept: "json",
    expect: json,
  },
  {
    route: "open-library",
    family: "published-work",
    terms: "Open API over the Internet Archive's book catalogue; no key.",
    documentation: "https://openlibrary.org/developers/api",
    status: "in-production",
    probe: "https://openlibrary.org/search/authors.json?q=chimamanda",
    expect: json,
  },
  {
    route: "nppes",
    family: "professional-records",
    terms: "US federal provider registry; the API is public and needs no key.",
    documentation: "https://npiregistry.cms.hhs.gov/api-page",
    status: "in-production",
    probe: "https://npiregistry.cms.hhs.gov/api/?version=2.1&last_name=Smith&state=CA&limit=2",
    expect: json,
  },
  {
    route: "clinicaltrials",
    family: "professional-records",
    terms: "ClinicalTrials.gov API v2 is public and unauthenticated.",
    documentation: "https://clinicaltrials.gov/data-api/api",
    status: "in-production",
    probe: "https://clinicaltrials.gov/api/v2/studies?query.term=oncology&pageSize=2",
    expect: json,
  },
  {
    route: "nonprofit-explorer",
    family: "professional-records",
    terms: "ProPublica's Nonprofit Explorer API is free and needs no key.",
    documentation: "https://projects.propublica.org/nonprofits/api",
    status: "in-production",
    probe: "https://projects.propublica.org/nonprofits/api/v2/search.json?q=food+bank",
    expect: json,
  },
  {
    route: "tvmaze",
    family: "creative-records",
    terms: "Public API; commercial use of the free tier is rate limited, not keyed.",
    documentation: "https://www.tvmaze.com/api",
    status: "in-production",
    probe: "https://api.tvmaze.com/search/people?q=lena",
    expect: json,
  },
  {
    route: "library-of-congress",
    family: "creative-records",
    terms: "loc.gov serves JSON for any search with `fo=json`; no key.",
    documentation: "https://www.loc.gov/apis/json-and-yaml/",
    status: "in-production",
    probe: "https://www.loc.gov/search/?q=Ansel+Adams&fo=json&c=2",
    expect: json,
  },
  {
    route: "artic",
    family: "creative-records",
    terms: "Art Institute of Chicago public API; no key for search.",
    documentation: "https://api.artic.edu/docs/",
    status: "in-production",
    probe: "https://api.artic.edu/api/v1/artworks/search?q=Hopper&limit=2",
    expect: json,
  },
  {
    route: "commoncrawl",
    family: "historical-evidence",
    terms: "The CDX index is public and unauthenticated.",
    documentation: "https://index.commoncrawl.org/",
    status: "in-production",
    probe: "https://index.commoncrawl.org/collinfo.json",
    expect: json,
  },
];

export interface EligibilityProbeResult {
  route: string;
  family: string;
  status: SourceEligibility["status"];
  probed: boolean;
  httpStatus: number | null;
  bytes: number | null;
  shapeOk: boolean | null;
  detail: string;
}

/**
 * Run every probe anonymously and report what each route actually answered.
 *
 * A probe is a smoke test of access, not evidence that the route produces
 * usable person evidence. The benchmark is what establishes the second, and
 * the two are reported separately on purpose.
 */
export async function probeSourceEligibility(
  fetch: PublicHttpFetch = publicHttpFetch,
): Promise<EligibilityProbeResult[]> {
  const results: EligibilityProbeResult[] = [];
  for (const entry of SOURCE_ELIGIBILITY) {
    if (!entry.probe) {
      results.push({
        route: entry.route,
        family: entry.family,
        status: entry.status,
        probed: false,
        httpStatus: null,
        bytes: null,
        shapeOk: null,
        detail: entry.exclusion ?? "No probe defined for this route.",
      });
      continue;
    }
    try {
      const transport =
        entry.probeAccept === "json" && fetch === publicHttpFetch ? jsonFetch : fetch;
      const response = await transport(entry.probe, { timeoutMs: 25_000 });
      const shapeOk = entry.expect ? entry.expect(response.body) : response.body.length > 0;
      results.push({
        route: entry.route,
        family: entry.family,
        status: entry.status,
        probed: true,
        httpStatus: response.status,
        bytes: response.body.length,
        shapeOk,
        detail:
          response.status === 200 && shapeOk
            ? "Answered anonymously with the expected shape."
            : `Answered ${String(response.status)}${shapeOk ? "" : " with an unexpected shape"}.`,
      });
    } catch (error) {
      results.push({
        route: entry.route,
        family: entry.family,
        status: entry.status,
        probed: true,
        httpStatus: null,
        bytes: null,
        shapeOk: false,
        detail: `Probe failed: ${error instanceof Error ? error.message : "unknown error"}.`,
      });
    }
  }
  return results;
}
