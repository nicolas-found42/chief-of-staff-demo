# Logged-out LinkedIn retrieval for Person Profiles: what is public and how to read it (2026-09-22)

Written 2026-09-22 against `main` at `4353104` (#466 merged, #423 closed). The owner's scope, in
chat: *retrieve the information in a logged-off state — no cookies or faking sign-in*. This note
answers how far that reaches and how to implement it here. It builds on
[`linkedin-anonymous-reads-verified-2026-09-18.md`](linkedin-anonymous-reads-verified-2026-09-18.md)
(the guest profile page, the two 999 regimes, the 59-request route matrix) and does not repeat it.

Out of scope, and not researched: anything whose purpose is to defeat LinkedIn's bot detection,
such as IP rotation, proxies, or browser-fingerprint disguise. The routes below are the ones
LinkedIn serves to a logged-out visitor.

Method: LinkedIn Help Center pages; `gh api` repository metadata and source at `HEAD`; a
repository test fixture captured live on 2026-07-27; web search of Stack Overflow, Reddit and
community write-ups; **three** single logged-out requests from this workstation (§7), with the
app's own honest user agent, no cookie and no retry. `[UNVERIFIED]` marks what was not established
first-hand.

---

## The direct answer

**The logged-out reach is exactly what each member publishes, and no method goes further.**
LinkedIn defines the public profile as "a streamlined version of your profile that shows up in
search engine results, and is visible to people who aren't signed in", and the member chooses
its sections ([a517984](https://www.linkedin.com/help/linkedin/answer/a517984)). "Disabling your
public profile hides your public profile from non-LinkedIn members or search tools results"
([a518980](https://www.linkedin.com/help/linkedin/answer/a518980)). For such a member, no
logged-out route to their profile page exists.

**Within that ceiling, the app reads less than is there.** Three gaps are worth implementing (§6):

1. **A structured parser for the guest profile page.** Today experience and education reach
   extraction as Readability prose; only the articles section is parsed structurally.
2. **Public posts and articles as identity anchors.** Their embedded schema.org data names the
   author with `author.url` equal to the member's own `/in/<slug>`, verified live today (§3). That
   ties the text to the Profile's own URL without reading the profile page, which is the one route
   left for a member whose profile page is refused but whose posts are public.
3. **Exact dates from post IDs.** A post's 19-digit activity ID encodes its creation time (§4), so
   every listed post gets a date without another request.

**The 999 gate needs a cadence policy, not a workaround.** The 09-18 measurement stands: an
IP-wide 999 regime is byte-identical to a per-profile refusal. Reading fewer pages, with a
known-good control before recording a wall, is the fix (§5).

---

## 1. What a member can publish to logged-out visitors

| Section (public-profile setting) | Source |
| --- | --- |
| Headline, Summary | [Indiana FSSA guide, 2019-02-12](https://www.in.gov/fssa/thehub/files/LinkedIn_Public_Profile_Visibility.pdf) |
| Current experience, Past experience: each "details" or "details and descriptions" | same |
| Education | same |
| Articles & activity | same |
| Profile badge (creation) | same; [a517984](https://www.linkedin.com/help/linkedin/answer/a517984) |

The list comes from a 2019 guide; LinkedIn's current pages state that sections are toggleable
without listing them ([a518980](https://www.linkedin.com/help/linkedin/answer/a518980),
[a1340507](https://www.linkedin.com/help/linkedin/answer/a1340507)). `[UNVERIFIED]` whether the
2026 toggles match. Search engines refresh "several weeks or months" after a change, and "LinkedIn
doesn't control that refresh process" (a518980), so a search index can hold a public profile's
content after the member has hidden it, and can lack a newly public one.

**Consequence for #423's Shaye result.** A refusal that persists across days (2026-09-16, 09-18,
09-22, byte-identical) while control slugs load is consistent with a disabled public profile.
`[INFERENCE]`: LinkedIn serves the same stub for an IP-wide block, so this is not proven; the
nonexistent-slug control in §5 is what would separate them.

## 2. The guest profile page: what is there to parse

Measured on a live capture of `/in/williamhgates` committed 2026-07-27
([aadisriram/nodejs-linkedin-scraper `test/fixtures/williamhgates.html`](https://github.com/aadisriram/nodejs-linkedin-scraper/tree/c0e2688a22dcd55e61fd4aba99bbc96279bfa26d/test/fixtures),
488,164 bytes), parsed here with the app's own `cheerio`:

| `data-section` | Content found |
| --- | --- |
| `experience` | 3 `li.experience-item`, each with title, company link, date range ("2000 - Present 26 years") |
| `educationsDetails` | 2 `li.education__list-item` |
| `currentPositionsDetails` | top-card current-role chips (4) |
| `summary`, `websites`, `picture` | as named |
| `articles` | article cards with `/pulse/` URLs |
| `posts` | 10 post cards: post text and a relative age ("21h", "1d"); **no `<time>` element**; links to `/posts/<slug>_…-activity-<id>` |

The 09-18 note adds two properties of real pages: some members' job titles are **redacted with
asterisks** (`class="blur"`) while company names stay visible, and the page has **no Person
JSON-LD**. Its single `ld+json` block is an `Article` (09-18 §2).

**A working TypeScript parser already exists.** `aadisriram/nodejs-linkedin-scraper` (MIT, 15★,
pushed 2026-07-27, Cheerio) parses the top card (`.top-card-layout__title`,
`.top-card-layout__headline`, `og:` fallbacks), `li.experience-item` (title, subtitle, company
URL, location, description, date range), `li.education__list-item` (skipping blurred cards), and
the summary, skills, projects, honors, languages, volunteering, publications and recommendations
sections (`src/parse/*.ts`). It ships five live fixtures with expected JSON, and it throws a
distinct error for 999/429 and for authwall or challenge bodies (`src/errors.ts:28-59`,
`src/fetch.ts:117-125`). The 09-18 note executed it end to end.

**What this app does today.** `readSocial` → `readHtml` runs Readability over the page and
prepends only the `Page title:` line and the article cards (`linkedInProfileText`,
`apps/server/src/person-profile/linkedin-articles.ts:14`). No code in `apps/server/src` reads
`experience-item`, `education__list` or `top-card-layout`. Experience and education reach the
model as whatever prose Readability kept, which is how #423's "missing role/date fragments"
arose.

## 3. Public posts and articles: logged-out, dated, and self-attributing

Two single logged-out requests on 2026-09-22 with the app's reader user agent
(`Found42-Content-Scout/1.0 (+public-source-monitor)`), both to pages linked from the guest profile
above:

| URL | Result | Embedded schema.org data |
| --- | --- | --- |
| `/pulse/memories-from-inspiring-trip-rwanda-bill-gates-ojyye` | **200**, 237,156 B, `pageKey d_flagship2_pulse_read`, `og:type article` | `Article`, `author.name` "Bill Gates", **`author.url` `https://www.linkedin.com/in/williamhgates`**, `datePublished` 2026-07-26T16:59:42Z |
| `/posts/williamhgates_memories-…-activity-7487189920416108544-e7fn` | **200**, 208,899 B | `SocialMediaPosting`, same `author.name` and **`author.url`**, `datePublished` 2026-07-26T16:59:42.270Z, 10 comments (each with its own dated entry) |

Three properties follow:

- **The author link is an Identity Signal on the page itself.** `author.url` names the member's
  own profile URL, so a post or article whose `author.url` matches one of the Profile's
  `profileUrls` is the subject's own writing. That is the same anchor class ADR-0097 already grants
  the Profile's own URL, established without the profile page. `decideIdentity` today keys only on
  the *requested* URL (`apps/server/src/person-profile/research.ts:1997-2001`), so these pages
  are matched by name alone, or not at all while `fullName` is null (09-18 §10.3).
- **The post URL carries the slug.** `/posts/<slug>_<title>-activity-<id>` begins with the vanity
  name, so a search result for `site:linkedin.com/posts/<slug>_` is attributable before any fetch.
  This is a seed the #445 Identity Bootstrap does not issue today (its seeds are `/in/<slug>`
  shaped, 09-18 cookie sweep §3.1).
- **These pages were readable with the honest user agent**, where the profile namespace often is
  not (09-18 §1.1). `[UNVERIFIED]` whether a member's posts stay readable while their profile page
  is refused. That is the case Shaye's profile would test, if any public post of theirs were known.

## 4. Post IDs encode their creation time

The 19-digit activity ID's first 41 bits are the creation time in Unix milliseconds
([Ollie-Boyd/Linkedin-post-timestamp-extractor](https://github.com/Ollie-Boyd/Linkedin-post-timestamp-extractor),
GPL-3.0, 150★, pushed 2026-07-12). Checked here: `7487189920416108544 >> 22` →
**2026-07-26T16:59:42.289Z**, matching the page's own `datePublished` to the second.
`7486820978292072449` → 2026-07-25T16:33:39Z, consistent with the "1d" label on a capture taken
2026-07-27 15:10Z. The rule is one shift, so it can be reimplemented without the GPL code. It gives
every post listed on a guest page an absolute date, and it applies to comment IDs the same way
(same README).

## 5. The 999 gate: what to do instead of retrying

Carried over from 09-18 §9, and unchanged by anything found today:

- The 999 stub (1,530 B, SHA-256 `644031a6…3de8`) is served both for a per-profile refusal and
  for an IP-wide block. The block measured on 09-18 lasted **at least three hours** after ~50
  requests in ~3 minutes, and a watcher polling every 15 minutes kept it hot. The watcher's log
  (`.scratch/linkedin-anon-routes/raw/recovery-watch.log`) shows it never recovered before the log
  ends at 16:00:58Z, so §9.6's pending shapes (`m.linkedin.com/in/…`, `/public-profile/in/…`,
  the nonexistent-slug control) were **never probed**.
- Community sources agree: 999 follows client shape and request volume, and the recommended
  remedy is to wait and reduce frequency
  ([http.dev/999](https://http.dev/999);
  [yatish27/linkedin-scraper#105](https://github.com/yatish27/linkedin-scraper/issues/105)).
- A published verdict must not claim a wall on a 999 alone. Before recording `login-required` as
  the profile's limitation, read one **known-good control** slug in the same minute. If the control
  also 999s, record "not served to this client; cause unresolved" and schedule a later attempt
  after a silent window that doubles on each refusal (09-18 §9.4, §9.6).

## 6. Implementation plan for this app

In order of value per effort. Each item lands at an existing seam, test-first at
`readPersonSource` or `PersonResearch.run` as #466 did.

1. **Structured guest-profile parser** (`research-readers.ts`, beside `linkedInProfileText`).
   Parse the top card, `experience-item`, `education__list-item`, `summary` and `posts` with
   `cheerio`, porting the selector set from `aadisriram/nodejs-linkedin-scraper` (MIT; keep its
   notice). Emit labelled lines ahead of the Readability text, such as
   `Experience: <title> | <company> | <date range> | <location>`, so ADR-0099's explicit
   neighbouring fields reach extraction intact. Skip asterisk-redacted titles and record them as a
   limitation, never as content. Port the upstream fixtures as regression tests.
2. **Author-anchored identity for posts and articles** (`research.ts`, `decideIdentity`). Parse
   the page's `Article` / `SocialMediaPosting` JSON-LD; when `author.url` matches a `profileUrls`
   identity via `linkedInProfileIdentity`, decide `matched` with anchor `signal`. Key it on the
   page's own declared author, never on the requested URL (the #466 lesson). The author name also
   gives the Identity Bootstrap a name from a substantive source read, which ADR-0042 and ADR-0097
   already require for a durable name.
3. **Post dates from IDs** (`linkedin-articles.ts` or a sibling). Decode `activity-<id>` and
   `urn:li:activity:<id>` into `publishedAt` when the page's JSON-LD is absent, labelled as
   decoded in the provenance note.
4. **Slug-scoped post seeds** (`research-plan.ts`). Add `site:linkedin.com/posts/<slug>_` beside
   the existing `/in/<slug>` seeds. A hit is attributable from its URL alone, and it is the only
   route for a member whose profile page is refused but whose posts are public.
5. **Follow listed posts and articles, bounded.** Guest pages list up to about ten posts and several
   articles; today articles are recorded as "Article contents were not retrieved". Read a bounded
   few, each through `readSocial`, under the per-host cadence in item 6.
6. **LinkedIn cadence and control read** (`readSocial` wall branch). A per-operation budget of
   LinkedIn-host requests, spaced, and the control read of §5 before a wall verdict is published.
   This is also what protects items 1-5 from tripping the IP-wide block that the 09-18 burst
   caused.
7. **Record why a render was rejected.** Already filed from #423's re-run (final URL, status and
   the check that fired, on `rendering-failed`).

Posture: items 1, 3 and 6 stay within ADR-0100 as written. Items 2, 4 and 5 read LinkedIn pages
reached through discovery, which `readSocial` already does over plain HTTP (ADR-0100 limits only
the **render** to the Profile's own URL). A short ADR should still record the author-anchor rule
in item 2, because it adds a new kind of `signal` anchor to ADR-0097.

## 7. Request ledger and open questions

| Time (UTC) | Request | Result |
| --- | --- | --- |
| 21:14:20 | `/pulse/memories-from-inspiring-trip-rwanda-bill-gates-ojyye` | 200, 237,156 B |
| 21:14:41 | `/posts/williamhgates_…-activity-7487189920416108544-e7fn` | 200, 208,899 B |
| 21:15:45 | `badges.linkedin.com/profile?…&vanityname=williamhgates` (LinkedIn's public profile badge) | **999**, the 1,530 B stub; not retried |

Open, in the order they would change the plan:

1. **Are a member's posts readable while their profile page is refused?** This decides whether
   item 4 reaches Shaye-class profiles. Test with the next walled profile that has a known public
   post.
2. **Nonexistent-slug control.** Does `/in/<random>` return the same 999 stub? If it returns a
   not-found page instead, a persistent 999 means the profile exists but is not public.
3. **The badge endpoint.** It refused a bare request; the embedding script may pass a badge ID or
   expect a browser client. It would return name, headline, current role and education (per
   [Mau-MD/linkedin_github_readme](https://github.com/Mau-MD/linkedin_github_readme)'s use of it),
   but only for members who created a badge, so its reach is narrow. `[UNVERIFIED]`.
4. **The 2026 public-profile toggle list** (§1 rests on a 2019 guide).
