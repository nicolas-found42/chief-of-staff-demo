import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import { expect, test } from "vitest";
import { PersonDossierStore } from "../../../apps/server/src/person-profile/dossier-store.js";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles.js";
import {
  PersonResearch,
  researchAllowance,
} from "../../../apps/server/src/person-profile/research.js";
import { ResearchAttemptRecorder } from "../../../apps/server/src/person-profile/research-diagnostics.js";
import {
  LinkedInRequestBudget,
  readPersonSource,
  type ReaderPorts,
} from "../../../apps/server/src/person-profile/research-readers.js";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store.js";

/**
 * Anonymous reads of LinkedIn, Instagram, X and Threads pages (issue #256).
 *
 * Availability is established per request from the response, never from the
 * hostname: a 200 whose body is a login or challenge shell is recorded as the
 * wall it is, while a page that actually renders public content anonymously
 * is retained. The failure these guard is specific: retaining a sign-in
 * prompt as evidence would let a claim cite a wall as if it were the
 * person's own words.
 */

const ports = (recorder: ResearchAttemptRecorder, fetch: ReaderPorts["fetch"]): ReaderPorts =>
  fromPartial({ fetch, recorder, timeoutMs: 1000 });

function read(url: string, body: string, status = 200) {
  const recorder = new ResearchAttemptRecorder(
    "social-walls",
    () => new Date("2026-09-09T12:00:00.000Z"),
  );
  const result = readPersonSource(
    url,
    "search snippet",
    ports(recorder, async (target) => ({
      url: target,
      status,
      contentType: "text/html",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body,
    })),
  );
  return { recorder, result };
}

test("a LinkedIn 999 authentication redirect is a login restriction, not a generic HTTP failure", async () => {
  const body =
    '<script>window.onload = function() { window.location.href = "https://" + domain + "/authwall?trk=" + trk; };</script>';
  const { recorder, result } = read("https://www.linkedin.com/in/maya-okafor", body, 999);
  expect((await result).access).toBe("blocked");
  expect(recorder.failures()).toContainEqual(
    expect.objectContaining({
      code: "login-required",
      observed: expect.objectContaining({ status: 999 }),
    }),
  );
});

const paragraph =
  "Maya Okafor has spent a decade leading coastal sensor deployments across West Africa, " +
  "publishing measurement methods that independent teams reuse in seasonal outbreak studies. ";
const ownUrl = "https://www.linkedin.com/in/maya-okafor";

/* A public profile page that renders anonymously: substantive profile content
   beside the usual sign-in chrome, mirroring the live LinkedIn probe. */
const publicProfilePage =
  `<!doctype html><html><head><title>Maya Okafor - Sensor Lead | LinkedIn</title></head>` +
  `<body><nav><a href="https://linkedin.com/">LinkedIn</a> ` +
  `<a href="https://linkedin.com/login">Sign in</a> <a href="https://linkedin.com/join">Join now</a></nav>` +
  `<main><p>Join to view profile</p>` +
  `<article><h1>Maya Okafor</h1><p>Sensor Lead at Coastal Observatory; Freetown, Sierra Leone</p>` +
  `<h2>About</h2><p>${paragraph.repeat(4)}</p><p>${paragraph.repeat(4)}</p></article></main>` +
  `<footer><a href="https://linkedin.com/footer">Footer</a></footer></body></html>`;

test("an anonymously readable public profile page yields retained text with its access route recorded", async () => {
  const { recorder, result } = read("https://www.linkedin.com/in/maya-okafor", publicProfilePage);
  const outcome = await result;
  expect(outcome.access).toBe("retrieved");
  expect(outcome.family).toBe("public-social");
  expect(outcome.route).toBe("html-reader");
  expect(outcome.upstreamIndex).toBe("linkedin.com");
  expect(outcome.text).toContain("Sensor Lead at Coastal Observatory");
  expect(outcome.text).toContain("seasonal outbreak studies");
  expect(recorder.all().some((attempt) => attempt.code === "login-required")).toBe(false);
  expect(recorder.all().some((attempt) => attempt.code === "challenge-page")).toBe(false);
});

test("a guest profile retains labelled experience, education, summary and listed posts without redacted titles", async () => {
  const body = `<!doctype html><html><head><title>Maya Okafor | LinkedIn</title></head><body>
    <main><article><h1 class="top-card-layout__title">Maya Okafor</h1>
    <div class="top-card-layout__headline">Coastal sensor lead</div>
    <div class="profile-info-subheader"><span>Freetown, Sierra Leone</span></div>
    <section data-section="summary"><div class="core-section-container__content"><p>${paragraph.repeat(4)}</p></div></section>
    <section data-section="experience"><ul>
      <li class="experience-item"><h3 class="experience-item__title">Sensor Lead</h3>
      <h4 class="experience-item__subtitle">Coastal Observatory</h4>
      <span class="date-range">2020 - Present</span><span class="location">Freetown</span></li>
      <li class="experience-item"><h3 class="experience-item__title blur">********</h3>
      <h4 class="experience-item__subtitle">Hidden Institute</h4><span class="date-range">2018 - 2020</span></li>
    </ul></section>
    <section data-section="educationsDetails" class="education"><ul class="education__list">
      <li class="education__list-item"><a href="/school/freetown-university"><img alt="School logo"></a>
      <h3>Freetown University</h3><h4>MSc, Oceanography</h4>
      <span class="date-range">2016 - 2018</span></li>
    </ul></section>
    <section data-section="posts"><div class="profile-activity-card"><div class="base-card">
      <a class="base-card__full-link" href="/posts/maya-okafor_coastal-sensors-activity-7487189920416108544-x"><span class="sr-only">Maya shared this</span></a>
      <div class="see-more-text">How coastal sensors help local teams.</div>
      <a href="/posts/maya-okafor_coastal-sensors-activity-7487189920416108544-x">public_profile__posts</a>
    </div></div></section>
    </article></main></body></html>`;
  const { result } = read(ownUrl, body);
  const outcome = await result;
  expect(outcome.access).toBe("retrieved");
  expect(outcome.text).toContain("Headline: Coastal sensor lead");
  expect(outcome.text).toContain(
    "Experience: Sensor Lead | Coastal Observatory | 2020 - Present | Freetown",
  );
  expect(outcome.text).toContain(
    "Education: Freetown University | MSc, Oceanography | 2016 - 2018",
  );
  expect(outcome.text).toContain("Summary: Maya Okafor has spent a decade");
  expect(outcome.text).toContain("Post listed by Maya Okafor");
  expect(outcome.text).toContain("Text: How coastal sensors help local teams.");
  expect(outcome.text.match(/Post listed by Maya Okafor/g)).toHaveLength(1);
  expect(outcome.text).toContain(
    "https://www.linkedin.com/posts/maya-okafor_coastal-sensors-activity-7487189920416108544-x",
  );
  expect(outcome.provenanceNote).toContain("redacted");
  expect(outcome.text).not.toContain("********");
});

test("a sparse guest profile retains structured fields when Readability finds no article", async () => {
  const body = `<html><body><h1 class="top-card-layout__title">Maya Okafor</h1>
    <section data-section="experience"><li class="experience-item">
      <span class="experience-item__title">Sensor Lead</span>
      <span class="experience-item__subtitle">Coastal Observatory</span>
      <span class="date-range">2020 - Present</span>
    </li></section></body></html>`;
  const { result } = read(ownUrl, body);
  const outcome = await result;
  expect(outcome.access).toBe("retrieved");
  expect(outcome.text).toContain("Experience: Sensor Lead | Coastal Observatory | 2020 - Present");
});

test.each([
  "https://www.linkedin.com/posts/maya-okafor_sensor-data-activity-7487189920416108544-x",
  "https://www.linkedin.com/feed/update/urn:li:activity:7487189920416108544",
])(
  "an anonymous LinkedIn post without JSON-LD dates its source from its activity ID: %s",
  async (url) => {
    const body = `<html><body><article><h1>Sensor data</h1><p>${paragraph.repeat(4)}</p></article></body></html>`;
    const { result } = read(url, body);
    const outcome = await result;
    expect(outcome.access).toBe("retrieved");
    expect(outcome.publishedAt).toBe("2026-07-26T16:59:42.289Z");
    expect(outcome.provenanceNote).toContain("decoded from the LinkedIn activity ID");
  },
);

test("a 200 carrying a login shell produces a login-required failure with the observed response evidence", async () => {
  const body =
    `<html><head><title>Sign in</title></head>` +
    `<body><p>Please sign in to continue</p></body></html>`;
  const { recorder, result } = read("https://www.linkedin.com/in/maya-okafor", body);
  const outcome = await result;
  expect(outcome.access).toBe("blocked");
  expect(outcome.route).toBe("social-reader");
  expect(outcome.family).toBe("public-social");
  expect(outcome.text).toBe("search snippet");
  const failure = recorder.failures().find((attempt) => attempt.stage === "access");
  expect(failure).toMatchObject({ code: "login-required", cause: "observed" });
  expect(failure?.observed).toMatchObject({
    status: 200,
    finalUrl: "https://www.linkedin.com/in/maya-okafor",
    contentType: "text/html",
    bytes: body.length,
  });
  expect(failure?.observed?.bodyHash).toMatch(/^[0-9a-f]{64}$/);
});

test("an invalid-length LinkedIn activity ID supplies no decoded date", async () => {
  const url =
    "https://www.linkedin.com/posts/maya-okafor_sensor-data-activity-748718992041610854-x";
  const body = `<html><body><article><h1>Sensor data</h1><p>${paragraph.repeat(4)}</p></article></body></html>`;
  const { result } = read(url, body);
  const outcome = await result;
  expect(outcome.access).toBe("retrieved");
  expect(outcome.publishedAt).toBeNull();
  expect(outcome.provenanceNote).toBeNull();
});

const authoredPostUrl =
  "https://www.linkedin.com/posts/maya-okafor_sensor-data-activity-7487189920416108544-x";
const authoredPost = (profileUrl: string) => `<html><head><title>Sensor data</title>
  <script type="application/ld+json">${JSON.stringify({
    "@type": "SocialMediaPosting",
    author: { name: "Maya Okafor", url: profileUrl },
    datePublished: "2026-07-26T16:59:42.270Z",
  })}</script></head><body><article><h1>Sensor data</h1><p>${paragraph.repeat(4)}</p></article></body></html>`;

test("a logged-out post read retains its own JSON-LD author and declared date", async () => {
  const { result } = read(authoredPostUrl, authoredPost(ownUrl));
  const outcome = await result;
  expect(outcome.access).toBe("retrieved");
  expect(outcome.linkedInAuthor).toEqual({ name: "Maya Okafor", profileUrl: ownUrl });
  expect(outcome.author).toBe("Maya Okafor");
  expect(outcome.publishedAt).toBe("2026-07-26T16:59:42.270Z");
});

test("a logged-out LinkedIn article retains its declared author URL", async () => {
  const articleUrl = "https://www.linkedin.com/pulse/coastal-data-maya-okafor";
  const body = `<html><head><script type="application/ld+json">${JSON.stringify({
    "@type": "Article",
    author: { name: "Maya Okafor", url: ownUrl },
    datePublished: "2026-07-25T12:00:00Z",
  })}</script></head><body><article><h1>Coastal data</h1><p>${paragraph.repeat(4)}</p></article></body></html>`;
  const { result } = read(articleUrl, body);
  const outcome = await result;
  expect(outcome.linkedInAuthor).toEqual({ name: "Maya Okafor", profileUrl: ownUrl });
  expect(outcome.publishedAt).toBe("2026-07-25T12:00:00Z");
});

test.each([
  { authorUrl: ownUrl, accepted: true },
  { authorUrl: "https://www.linkedin.com/in/another-person", accepted: false },
])(
  "a post is anchored by its declared author URL, not its requested URL: $authorUrl",
  async ({ authorUrl, accepted }) => {
    const root = mkdtempSync(join(tmpdir(), "linkedin-author-anchor-"));
    try {
      const people = new WorkspacePersonProfiles({
        store: new PersonProfileStore(root),
        lifecycle: [],
      });
      const profile = people.create({ profileUrls: [ownUrl] });
      const dossiers = new PersonDossierStore(root);
      let extractions = 0;
      const research = new PersonResearch({
        people,
        dossiers,
        linkedInBudget: new LinkedInRequestBudget({ spacingMs: 0 }),
        search: async () => [{ url: authoredPostUrl, title: "Sensor data", snippet: "" }],
        fetch: async (url) => ({
          url,
          status: url === authoredPostUrl || url === controlUrl ? 200 : 999,
          contentType: "text/html",
          etag: null,
          lastModified: null,
          retryAfter: null,
          body:
            url === authoredPostUrl
              ? authoredPost(authorUrl)
              : url === controlUrl
                ? controlPage
                : authRedirect,
        }),
        complete: async () => {
          extractions++;
          return {
            fullName: null,
            employer: null,
            sourceClass: "self-report" as const,
            author: null,
            publishedAt: null,
            claims: [],
            works: [],
            expertise: [],
            connections: [],
            sections: [],
          };
        },
      });
      const outcome = await research.run(
        profile,
        researchAllowance({ maxModelCalls: 2, maxMilliseconds: 10_000, quietRounds: 1 }),
      );
      expect(extractions > 0).toBe(accepted);
      expect(
        outcome.operation.attempts.some(
          (attempt) => attempt.code === "identity-unmatched" && attempt.target === authoredPostUrl,
        ),
      ).toBe(!accepted);
      if (accepted) expect(people.get(profile.id)?.fullName).toBe("Maya Okafor");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("a matched guest profile follows two listed posts and one article through anonymous reads", async () => {
  const root = mkdtempSync(join(tmpdir(), "linkedin-listed-works-"));
  try {
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(root),
      lifecycle: [],
    });
    const profile = people.create({ profileUrls: [ownUrl] });
    const dossiers = new PersonDossierStore(root);
    const posts = [1, 2, 3].map(
      (number) =>
        `https://www.linkedin.com/posts/maya-okafor_sensor-${number}-activity-7487189920416108544-x`,
    );
    const articles = [1, 2].map(
      (number) => `https://www.linkedin.com/pulse/coastal-sensors-${number}-maya-okafor`,
    );
    const profilePage = `<html><body><article><h1>Maya Okafor</h1><p>${paragraph.repeat(4)}</p>
      <section data-section="posts">${posts
        .map(
          (url, index) =>
            `<div class="base-card"><div class="see-more-text">Sensor finding ${index + 1}</div><a href="${url}?trk=public_profile">Post</a></div>`,
        )
        .join("")}</section>
      <section data-section="articles"><h2>Articles by Maya Okafor</h2>${articles
        .map(
          (url, index) =>
            `<div class="main-article-card"><h3>Coastal sensors ${index + 1}</h3><a href="${url}?trk=public_profile">Article</a><span class="base-main-card__metadata-item">Jul 26, 2026</span></div>`,
        )
        .join("")}</section></article></body></html>`;
    const fetched: string[] = [];
    const research = new PersonResearch({
      people,
      dossiers,
      linkedInBudget: new LinkedInRequestBudget({ maxRequests: 4, spacingMs: 0 }),
      seeds: () => [],
      search: async () => [],
      fetch: async (url) => {
        fetched.push(url);
        return {
          url,
          status: 200,
          contentType: "text/html",
          etag: null,
          lastModified: null,
          retryAfter: null,
          body:
            url === ownUrl
              ? profilePage
              : `<html><head><script type="application/ld+json">${JSON.stringify({
                  "@type": url.includes("/pulse/") ? "Article" : "SocialMediaPosting",
                  author: { name: "Maya Okafor", url: ownUrl },
                })}</script></head><body><article><h1>Sensor finding</h1><p>${paragraph.repeat(4)}</p></article></body></html>`,
        };
      },
      complete: async () => ({
        fullName: null,
        employer: null,
        sourceClass: "self-report" as const,
        author: null,
        publishedAt: null,
        claims: [],
        works: [],
        expertise: [],
        connections: [],
        sections: [],
      }),
    });
    await research.run(
      profile,
      researchAllowance({ maxModelCalls: 10, maxMilliseconds: 10_000, quietRounds: 1 }),
    );
    expect(fetched).toEqual([ownUrl, posts[0], posts[1], articles[0]]);
    const sources = dossiers
      .get(profile.id)!
      .sourceIds.map((sourceId) => dossiers.source(profile.id, sourceId)!.url);
    expect(sources).toEqual(expect.arrayContaining([ownUrl, posts[0], posts[1], articles[0]]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a listed post redirected to another author is not attributed through its requested URL", async () => {
  const root = mkdtempSync(join(tmpdir(), "linkedin-listed-redirect-"));
  try {
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(root),
      lifecycle: [],
    });
    const profile = people.create({ profileUrls: [ownUrl] });
    const dossiers = new PersonDossierStore(root);
    const post = authoredPostUrl;
    const otherPost =
      "https://www.linkedin.com/posts/other-person_unrelated-work-activity-7487189920416108544-x";
    const research = new PersonResearch({
      people,
      dossiers,
      linkedInBudget: new LinkedInRequestBudget({ spacingMs: 0 }),
      seeds: () => [],
      search: async () => [],
      fetch: async (target) => ({
        url: target === post ? otherPost : target,
        status: 200,
        contentType: "text/html",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body:
          target === ownUrl
            ? `<html><body><article><h1>Maya Okafor</h1><p>${paragraph.repeat(4)}</p><section data-section="posts"><div class="base-card"><div class="see-more-text">Sensor finding</div><a href="${post}">Post</a></div></section></article></body></html>`
            : `<html><body><article><h1>Someone Else</h1><p>${"Someone Else wrote about unrelated work. ".repeat(12)}</p></article></body></html>`,
      }),
      complete: async () => ({
        fullName: null,
        employer: null,
        sourceClass: "self-report" as const,
        author: null,
        publishedAt: null,
        claims: [],
        works: [],
        expertise: [],
        connections: [],
        sections: [],
      }),
    });
    const outcome = await research.run(
      profile,
      researchAllowance({ maxModelCalls: 4, maxMilliseconds: 10_000, quietRounds: 1 }),
    );
    expect(outcome.operation.attempts).toContainEqual(
      expect.objectContaining({ code: "identity-unmatched", target: post }),
    );
    const sources = dossiers
      .get(profile.id)!
      .sourceIds.map((sourceId) => dossiers.source(profile.id, sourceId)!.url);
    expect(sources).not.toContain(otherPost);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  {
    network: "x",
    url: "https://x.com/mayaokafor",
    marker: "join the conversation",
    body:
      `<html><head><title>Maya (@mayaokafor) / X</title></head><body>` +
      `<div><p>See what\u2019s happening and join the conversation</p>` +
      `<p>Continue with phone or log in with username or email</p></div></body></html>`,
  },
  {
    network: "instagram",
    url: "https://www.instagram.com/maya.okafor/",
    marker: "show more posts from",
    body:
      `<html><head><title>Maya Okafor (@maya.okafor) \u2022 photos</title></head><body>` +
      `<div><p>Maya Okafor</p><p>1.2M followers</p>` +
      `<button>Show more posts from maya.okafor</button></div></body></html>`,
  },
  {
    network: "threads",
    url: "https://www.threads.com/@maya.okafor",
    marker: "log in to see more",
    body:
      `<html><head><title>Maya Okafor (@maya.okafor) \u2022 Threads</title></head><body>` +
      `<div><p>Maya Okafor</p><p>38K followers</p>` +
      `<p>Log in to see more from maya.okafor</p></div></body></html>`,
  },
])(
  "a login-gated 200 on $network records the observed gating marker",
  async ({ url, marker, body }) => {
    const { recorder, result } = read(url, body);
    const outcome = await result;
    expect(outcome.access).toBe("blocked");
    expect(outcome.route).toBe("social-reader");
    const failure = recorder.failures().find((attempt) => attempt.stage === "access");
    expect(failure).toMatchObject({ code: "login-required", cause: "observed" });
    expect(failure?.reason).toContain(marker);
    expect(failure?.observed?.status).toBe(200);
  },
);

test("a 200 carrying a bot-challenge shell is recorded as a challenge, never retained", async () => {
  const body =
    `<!doctype html><html><head><title>Just a moment...</title></head><body>` +
    `<article><p>Just a moment: checking your browser before you can continue. ` +
    `Please enable JavaScript and cookies to continue. ${paragraph.repeat(4)}</p></article></body></html>`;
  const { recorder, result } = read("https://x.com/mayaokafor", body);
  const outcome = await result;
  expect(outcome.access).toBe("blocked");
  expect(outcome.route).toBe("social-reader");
  const failure = recorder.failures().find((attempt) => attempt.stage === "access");
  expect(failure).toMatchObject({ code: "challenge-page", cause: "observed" });
  expect(failure?.observed).toMatchObject({ status: 200 });
  expect(failure?.observed?.bodyHash).toMatch(/^[0-9a-f]{64}$/);
});

/* A Profile's own walled LinkedIn URL earns one bounded render (ADR-0100). */
const authRedirect =
  '<script>window.onload = function() { window.location.href = "https://" + domain + "/authwall?trk=" + trk; };</script>';
const controlUrl = "https://www.linkedin.com/in/williamhgates";
const controlPage = `<html><body><article><h1>William Gates</h1><section data-section="summary"><div class="core-section-container__content"><p>Microsoft co-founder and Gates Foundation chair, working on global health, education, and climate initiatives.</p></div></section></article></body></html>`;

function readWalled(
  url: string,
  body: string,
  status: number,
  render: (target: string) => { url: string; body: string; status?: number },
  controlStatus = 200,
  linkedInBudget = new LinkedInRequestBudget({ spacingMs: 0 }),
  controlBody = controlPage,
) {
  const recorder = new ResearchAttemptRecorder(
    "social-walls",
    () => new Date("2026-09-22T12:00:00.000Z"),
  );
  const renders: string[] = [];
  const fetches: string[] = [];
  const result = readPersonSource(
    url,
    "search snippet",
    fromPartial<ReaderPorts>({
      recorder,
      timeoutMs: 1000,
      profileUrls: [ownUrl],
      linkedInBudget,
      fetch: async (target: string) => {
        fetches.push(target);
        return {
          url: target,
          status: target === controlUrl ? controlStatus : status,
          contentType: "text/html",
          etag: null,
          lastModified: null,
          retryAfter: null,
          body: target === controlUrl && controlStatus === 200 ? controlBody : body,
        };
      },
      render: async (target: string) => {
        renders.push(target);
        return { status: 200, contentType: "text/html", ...render(target) };
      },
    }),
  );
  return { recorder, renders, fetches, result };
}

test("a walled read of the Profile's own LinkedIn URL is recovered by one bounded render of that profile", async () => {
  const { recorder, renders, fetches, result } = readWalled(
    ownUrl,
    authRedirect,
    999,
    (target) => ({
      url: target,
      body: publicProfilePage,
    }),
  );
  const outcome = await result;
  expect(fetches).toEqual([ownUrl, controlUrl]);
  expect(renders).toEqual([ownUrl]);
  expect(outcome.access).toBe("retrieved");
  expect(outcome.route).toBe("browser-renderer");
  expect(outcome.text).toContain("Sensor Lead at Coastal Observatory");
  expect(recorder.all()).toContainEqual(
    expect.objectContaining({ code: "login-required", recovery: "alternative-route" }),
  );
  expect(recorder.all()).toContainEqual(
    expect.objectContaining({ code: "retrieval-recovered", collector: "browser-renderer" }),
  );
});

test("a 999 on both the Profile and known-good control leaves the cause unresolved and never renders", async () => {
  const { recorder, renders, fetches, result } = readWalled(
    ownUrl,
    authRedirect,
    999,
    (target) => ({ url: target, body: publicProfilePage }),
    999,
  );
  const outcome = await result;
  expect(fetches).toEqual([ownUrl, controlUrl]);
  expect(renders).toEqual([]);
  expect(outcome.access).toBe("blocked");
  expect(recorder.failures()).toContainEqual(
    expect.objectContaining({
      reason: expect.stringContaining("cause unresolved"),
    }),
  );
  expect(recorder.failures().some((attempt) => attempt.code === "login-required")).toBe(false);
});

test("a 999 that contains a login marker still requires the control before a wall verdict", async () => {
  const { recorder, fetches, result } = readWalled(
    ownUrl,
    "<html><body><h1>Sign in to continue</h1></body></html>",
    999,
    (target) => ({ url: target, body: publicProfilePage }),
    999,
  );
  await result;
  expect(fetches).toEqual([ownUrl, controlUrl]);
  expect(recorder.failures().some((attempt) => attempt.code === "login-required")).toBe(false);
});

test("a generic 200 shell at the control URL does not validate a 999 wall", async () => {
  const { recorder, renders, result } = readWalled(
    ownUrl,
    authRedirect,
    999,
    (target) => ({ url: target, body: publicProfilePage }),
    200,
    new LinkedInRequestBudget({ spacingMs: 0 }),
    "<html><body><h1>Service is temporarily unavailable</h1></body></html>",
  );
  await result;
  expect(renders).toEqual([]);
  expect(recorder.failures()).toContainEqual(
    expect.objectContaining({ reason: expect.stringContaining("cause unresolved") }),
  );
});

test("a control delayed beyond the 999's minute does not authorize a wall verdict", async () => {
  let clock = 0;
  const budget = new LinkedInRequestBudget({
    spacingMs: 60_000,
    now: () => clock,
    wait: async (milliseconds) => {
      clock += milliseconds;
    },
  });
  const { fetches, renders, recorder, result } = readWalled(
    ownUrl,
    authRedirect,
    999,
    (target) => ({ url: target, body: publicProfilePage }),
    200,
    budget,
  );
  await result;
  expect(fetches).toEqual([ownUrl]);
  expect(renders).toEqual([]);
  expect(recorder.failures()).toContainEqual(
    expect.objectContaining({ reason: expect.stringContaining("cause unresolved") }),
  );
});

test("the control and render share the LinkedIn request budget", async () => {
  const budget = new LinkedInRequestBudget({ maxRequests: 2, spacingMs: 0 });
  const { fetches, renders, recorder, result } = readWalled(
    ownUrl,
    authRedirect,
    999,
    (target) => ({ url: target, body: publicProfilePage }),
    200,
    budget,
  );
  expect((await result).access).toBe("blocked");
  expect(fetches).toEqual([ownUrl, controlUrl]);
  expect(renders).toEqual([]);
  expect(recorder.all()).toContainEqual(expect.objectContaining({ code: "selection-deferred" }));
});

test("a failed control enforces a silent window that doubles after the next refusal", async () => {
  let clock = 0;
  const cooldown = { until: 0, refusals: 0 };
  const budget = () => new LinkedInRequestBudget({ spacingMs: 0, now: () => clock, cooldown });
  const render = (target: string) => ({ url: target, body: publicProfilePage });
  const first = readWalled(ownUrl, authRedirect, 999, render, 999, budget());
  await first.result;
  expect(cooldown.refusals).toBe(1);
  expect(cooldown.until).toBe(15 * 60_000);
  const deferred = readWalled(ownUrl, authRedirect, 999, render, 999, budget());
  expect((await deferred.result).access).toBe("blocked");
  expect(deferred.fetches).toEqual([]);
  clock = cooldown.until;
  const second = readWalled(ownUrl, authRedirect, 999, render, 999, budget());
  await second.result;
  expect(second.fetches).toEqual([ownUrl, controlUrl]);
  expect(cooldown.refusals).toBe(2);
  expect(cooldown.until).toBe(clock + 30 * 60_000);
});

test("LinkedIn reads share a spaced two-request budget with no automatic retry", async () => {
  let clock = 0;
  const waits: number[] = [];
  const fetches: string[] = [];
  const budget = new LinkedInRequestBudget({
    maxRequests: 2,
    spacingMs: 20_000,
    now: () => clock,
    wait: async (milliseconds) => {
      waits.push(milliseconds);
      clock += milliseconds;
    },
  });
  const recorder = new ResearchAttemptRecorder(
    "linkedin-budget",
    () => new Date("2026-09-22T12:00:00Z"),
  );
  const url = authoredPostUrl;
  const readOne = () =>
    readPersonSource(
      url,
      "",
      fromPartial<ReaderPorts>({
        recorder,
        timeoutMs: 1000,
        linkedInBudget: budget,
        fetch: async (target: string) => {
          fetches.push(target);
          return {
            url: target,
            status: 429,
            contentType: "text/html",
            etag: null,
            lastModified: null,
            retryAfter: null,
            body: "rate limited",
          };
        },
      }),
    );
  await readOne();
  await readOne();
  const deferred = await readOne();
  expect(fetches).toEqual([url, url]);
  expect(waits).toEqual([20_000]);
  expect(deferred.access).toBe("blocked");
  expect(recorder.all()).toContainEqual(
    expect.objectContaining({
      code: "selection-deferred",
      reason: expect.stringContaining("LinkedIn request budget"),
    }),
  );
});

test("separate LinkedIn operations still space their requests to the same host", async () => {
  let clock = 0;
  const started: number[] = [];
  const waits: number[] = [];
  let releaseWait!: () => void;
  const waiting = new Promise<void>((resolve) => {
    releaseWait = resolve;
  });
  const cooldown = { until: 0, refusals: 0 };
  const budget = () =>
    new LinkedInRequestBudget({
      maxRequests: 1,
      spacingMs: 20_000,
      cooldown,
      now: () => clock,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        await waiting;
        clock += milliseconds;
      },
    });
  const readOne = (linkedInBudget: LinkedInRequestBudget) =>
    readPersonSource(
      authoredPostUrl,
      "",
      fromPartial<ReaderPorts>({
        recorder: new ResearchAttemptRecorder(
          "shared-host",
          () => new Date("2026-09-22T12:00:00Z"),
        ),
        timeoutMs: 1000,
        linkedInBudget,
        fetch: async (url: string) => {
          started.push(clock);
          return {
            url,
            status: 429,
            contentType: "text/html",
            etag: null,
            lastModified: null,
            retryAfter: null,
            body: "rate limited",
          };
        },
      }),
    );
  const first = readOne(budget());
  const second = readOne(budget());
  await first;
  expect(started).toEqual([0]);
  releaseWait();
  await second;
  expect(started).toEqual([0, 20_000]);
  expect(waits).toEqual([20_000]);
});

test("a slow LinkedIn fetch finishes before another operation starts its request", async () => {
  let clock = 0;
  let finishFirst!: () => void;
  const firstPending = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  const started: string[] = [];
  const cooldown = { until: 0, refusals: 0 };
  const readOne = (url: string) =>
    readPersonSource(
      url,
      "",
      fromPartial<ReaderPorts>({
        recorder: new ResearchAttemptRecorder("single-flight", () => new Date()),
        timeoutMs: 1000,
        linkedInBudget: new LinkedInRequestBudget({
          maxRequests: 1,
          spacingMs: 20_000,
          cooldown,
          now: () => clock,
          wait: async (milliseconds) => {
            clock += milliseconds;
          },
        }),
        fetch: async (target: string) => {
          started.push(target);
          if (target === ownUrl) await firstPending;
          return {
            url: target,
            status: 429,
            contentType: "text/html",
            etag: null,
            lastModified: null,
            retryAfter: null,
            body: "rate limited",
          };
        },
      }),
    );
  const first = readOne(ownUrl);
  const second = readOne(authoredPostUrl);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(started).toEqual([ownUrl]);
  finishFirst();
  await Promise.all([first, second]);
  expect(started).toEqual([ownUrl, authoredPostUrl]);
  expect(clock).toBe(20_000);
});

test("a render that lands on the LinkedIn authwall is a wall, never a retained source", async () => {
  const joinForm =
    `<!doctype html><html><head><title>LinkedIn</title></head><body><main>` +
    `<h1>Join LinkedIn</h1><form><label>Email</label><input type="email">` +
    `<label>Password (6+ characters)</label><input type="password">` +
    `<p>${paragraph.repeat(4)}</p></form></main></body></html>`;
  const authwall =
    "https://www.linkedin.com/authwall?trk=bf&sessionRedirect=https%3A%2F%2Fwww.linkedin.com%2Fin%2Fmaya-okafor";
  const { recorder, renders, result } = readWalled(ownUrl, authRedirect, 999, () => ({
    url: authwall,
    body: joinForm,
  }));
  const outcome = await result;
  expect(renders).toEqual([ownUrl]);
  expect(outcome.access).toBe("blocked");
  expect(outcome.text).toBe("search snippet");
  expect(recorder.failures()).toContainEqual(
    expect.objectContaining({ code: "login-required", stage: "access" }),
  );
  const failure = recorder.failures().find((attempt) => attempt.code === "rendering-failed");
  expect(failure).toMatchObject({ collector: "browser-renderer" });
  expect(failure?.reason).toMatch(/sign-in surface/);
  expect(failure?.observed).toEqual({ status: 200, finalUrl: authwall, bytes: joinForm.length });
});

/* Each check that rejects a render names itself and records where the
   browser landed, so the ledger says why a render contributed nothing. */
test.each([
  {
    check: "HTTP status",
    rendered: { url: ownUrl, body: publicProfilePage, status: 403 },
    reason: /HTTP 403/,
  },
  {
    check: "challenge",
    rendered: {
      url: ownUrl,
      body:
        `<!doctype html><html><head><title>Just a moment...</title></head><body>` +
        `<p>Just a moment: checking your browser before you can continue.</p></body></html>`,
    },
    reason: /challenge-page/,
  },
  {
    check: "social wall marker",
    rendered: {
      url: ownUrl,
      body: publicProfilePage.replace("</body>", "<p>Log in to see more</p></body>"),
    },
    reason: /social wall marker "log in to see more"/,
  },
])("a render rejected by the $check check records its reason and landing", async (row) => {
  const { recorder, result } = readWalled(ownUrl, authRedirect, 999, () => row.rendered);
  expect((await result).access).toBe("blocked");
  const failure = recorder.failures().find((attempt) => attempt.code === "rendering-failed");
  expect(failure?.reason).toMatch(row.reason);
  expect(failure?.observed).toEqual({
    status: row.rendered.status ?? 200,
    finalUrl: ownUrl,
    bytes: row.rendered.body.length,
  });
});

test("a render that lands on a different LinkedIn profile is not retained as the Profile's own", async () => {
  const { recorder, renders, result } = readWalled(ownUrl, authRedirect, 999, () => ({
    url: "https://www.linkedin.com/in/someone-else",
    body: publicProfilePage,
  }));
  const outcome = await result;
  expect(renders).toEqual([ownUrl]);
  expect(outcome.access).toBe("blocked");
  expect(outcome.text).toBe("search snippet");
  expect(recorder.failures()).toContainEqual(
    expect.objectContaining({ code: "identity-unmatched", collector: "browser-renderer" }),
  );
});

test("a walled LinkedIn URL that is not one of the Profile's own earns no render", async () => {
  const { renders, result } = readWalled(
    "https://www.linkedin.com/in/someone-else",
    authRedirect,
    999,
    (target) => ({ url: target, body: publicProfilePage }),
  );
  expect((await result).access).toBe("blocked");
  expect(renders).toEqual([]);
});

test("a bot challenge on the Profile's own LinkedIn URL is never retried in a browser", async () => {
  const challenge =
    `<!doctype html><html><head><title>Just a moment...</title></head><body>` +
    `<p>Just a moment: checking your browser before you can continue.</p></body></html>`;
  const { recorder, renders, result } = readWalled(ownUrl, challenge, 200, (target) => ({
    url: target,
    body: publicProfilePage,
  }));
  expect((await result).access).toBe("blocked");
  expect(renders).toEqual([]);
  expect(recorder.failures()).toContainEqual(expect.objectContaining({ code: "challenge-page" }));
});

test("a research operation hands the reader the Profile's own URLs", async () => {
  const root = mkdtempSync(join(tmpdir(), "social-walls-"));
  try {
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(root),
      lifecycle: [],
    });
    const profile = people.create({ profileUrls: [ownUrl] });
    const seen: (readonly string[] | undefined)[] = [];
    const queries: string[] = [];
    const research = new PersonResearch({
      people,
      dossiers: new PersonDossierStore(root),
      linkedInBudget: new LinkedInRequestBudget({ spacingMs: 0 }),
      search: async (query) => {
        queries.push(query);
        return [];
      },
      readSource: async (url, snippet, readerPorts) => {
        seen.push(readerPorts.profileUrls);
        return readPersonSource(url, snippet, {
          ...readerPorts,
          fetch: async (target) => ({
            url: target,
            status: 999,
            contentType: "text/html",
            etag: null,
            lastModified: null,
            retryAfter: null,
            body: authRedirect,
          }),
        });
      },
      complete: async () => {
        throw new Error("No document reaches extraction.");
      },
    });
    await research.run(
      profile,
      researchAllowance({ maxModelCalls: 1, maxMilliseconds: 5_000, quietRounds: 1 }),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toEqual([ownUrl]);
    expect(queries).toContain("site:linkedin.com/posts/maya-okafor_");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
