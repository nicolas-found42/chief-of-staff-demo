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

/* A Profile's own walled LinkedIn URL earns one bounded render (ADR-0100). */
const authRedirect =
  '<script>window.onload = function() { window.location.href = "https://" + domain + "/authwall?trk=" + trk; };</script>';
const ownUrl = "https://www.linkedin.com/in/maya-okafor";

function readWalled(
  url: string,
  body: string,
  status: number,
  render: (target: string) => { url: string; body: string; status?: number },
) {
  const recorder = new ResearchAttemptRecorder(
    "social-walls",
    () => new Date("2026-09-22T12:00:00.000Z"),
  );
  const renders: string[] = [];
  const result = readPersonSource(
    url,
    "search snippet",
    fromPartial<ReaderPorts>({
      recorder,
      timeoutMs: 1000,
      profileUrls: [ownUrl],
      fetch: async (target: string) => ({
        url: target,
        status,
        contentType: "text/html",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body,
      }),
      render: async (target: string) => {
        renders.push(target);
        return { status: 200, contentType: "text/html", ...render(target) };
      },
    }),
  );
  return { recorder, renders, result };
}

test("a walled read of the Profile's own LinkedIn URL is recovered by one bounded render of that profile", async () => {
  const { recorder, renders, result } = readWalled(ownUrl, authRedirect, 999, (target) => ({
    url: target,
    body: publicProfilePage,
  }));
  const outcome = await result;
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
    const research = new PersonResearch({
      people,
      dossiers: new PersonDossierStore(root),
      search: async () => [],
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
