import { fromPartial } from "@total-typescript/shoehorn";
import { expect, test } from "vitest";
import { ResearchAttemptRecorder } from "../../../apps/server/src/person-profile/research-diagnostics.js";
import {
  readPersonSource,
  type ReaderPorts,
} from "../../../apps/server/src/person-profile/research-readers.js";

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

function read(url: string, body: string) {
  const recorder = new ResearchAttemptRecorder(
    "social-walls",
    () => new Date("2026-09-09T12:00:00.000Z"),
  );
  const result = readPersonSource(
    url,
    "search snippet",
    ports(recorder, async (target) => ({
      url: target,
      status: 200,
      contentType: "text/html",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body,
    })),
  );
  return { recorder, result };
}

const paragraph =
  "Maya Okafor has spent a decade leading coastal sensor deployments across West Africa, " +
  "publishing measurement methods that independent teams reuse in seasonal outbreak studies. ";

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
