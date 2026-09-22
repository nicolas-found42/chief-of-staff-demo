# A LinkedIn post's declared author can anchor Person identity

ADR-0097 treats a Profile's own URL as an Identity Signal, but a public LinkedIn
post or article can remain readable when the member's guest profile page is
refused. Its schema.org `Article` or `SocialMediaPosting` data declares
`author.url` as the member's `/in/<slug>` URL. A request for the post URL alone
does not establish who wrote the page (#423).

## The decision

For a logged-out read of a LinkedIn `/posts/` or `/pulse/` page, compare the
page's declared JSON-LD `author.url` with the Person Profile's own `profileUrls`
using `linkedInProfileIdentity`. An exact profile identity match anchors the
document as `signal`. A declared author URL for someone else rejects the
document for this Profile, even if its text names the Profile or a prior source
linked to the post. The requested URL and its slug never supply this anchor.

When the matched declaration includes `author.name`, retain that name as
source text and let Identity Bootstrap use it after the substantive read. The
page remains self-report, with its source URL and provenance attached; the
author declaration does not independently verify the person's assertions.

## Boundaries and consequences

Only the page's own `Article` or `SocialMediaPosting` JSON-LD on those two
LinkedIn paths can make this author anchor. A malformed declaration or one
without a valid `/in/<slug>` URL earns no new signal. The rule adds no login,
cookie, session, render route or extra HTTP request. Anonymous plain HTTP
reads of discovered URLs remain within ADR-0100's posture.

This extends ADR-0097's `signal` class to a page that declares the Profile's
own URL as its author. The alternative of trusting the requested post URL was
rejected because a redirect, stale search hit or slug collision can return a
different author's page (#466 review).

## How it is verified

Fictional `Article` and `SocialMediaPosting` pages drive `readPersonSource`
and `PersonResearch.run`. A matching declared author reaches extraction and
can supply a name to Identity Bootstrap; a different declared author is
rejected even when the requested URL looks like the Profile's slug.
