import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";
import { ResearchAttemptRecorder } from "../../../apps/server/src/person-profile/research-diagnostics.js";
import {
  readPersonSource,
  type ReaderPorts,
} from "../../../apps/server/src/person-profile/research-readers.js";

/**
 * Bluesky + Mastodon attribution (issue #255).
 *
 * A repost is not the reposter's statement: retained evidence carries the
 * original author and post reference. A person's own post is a self-statement
 * — marked by the reader's per-entry authorship and provenance note so
 * extraction files it as self-report rather than independent verification —
 * and an instance that withdraws public access produces an observed failure,
 * never an assumed absence of posts.
 */

const ports = (recorder: ResearchAttemptRecorder, fetch: ReaderPorts["fetch"]): ReaderPorts =>
  fromPartial({ fetch, recorder, timeoutMs: 1000 });

const jsonResponse = (url: string, body: unknown) => ({
  url,
  status: 200,
  contentType: "application/json",
  etag: null,
  lastModified: null,
  retryAfter: null,
  body: JSON.stringify(body),
});

describe("bluesky reader attribution", () => {
  const feedFetch =
    (feed: unknown): ReaderPorts["fetch"] =>
    async (url) =>
      jsonResponse(url, feed);

  it("attributes a repost to its original author, never the reposter", async () => {
    const recorder = new ResearchAttemptRecorder("operation-bsky-repost");
    const result = await readPersonSource(
      "https://bsky.app/profile/maya.example",
      "",
      ports(
        recorder,
        feedFetch({
          feed: [
            {
              post: {
                uri: "at://did:plc:maya/app.bsky.feed.post/own1",
                author: { handle: "maya.example" },
                record: { text: "We launched the sensor.", createdAt: "2026-09-01T00:00:00Z" },
              },
            },
            {
              reason: {
                $type: "app.bsky.feed.defs#reasonRepost",
                by: { handle: "maya.example" },
              },
              post: {
                uri: "at://did:plc:other/app.bsky.feed.post/abc",
                author: { handle: "other.example" },
                record: {
                  text: "I built the ocean sensor.",
                  createdAt: "2026-09-02T00:00:00Z",
                },
              },
            },
          ],
        }),
      ),
    );
    expect(result.route).toBe("bluesky");
    expect(result.author).toBeNull();
    expect(result.text).toContain("author: other.example (original)");
    expect(result.text).toContain("reposted by maya.example");
    expect(result.text).toContain("at://did:plc:other/app.bsky.feed.post/abc");
    expect(result.text).toContain("https://bsky.app/profile/other.example/post/abc");
    expect(result.text).toContain("repost — I built the ocean sensor.");
    expect(result.text).toContain("author: maya.example");
    expect(result.provenanceNote).toMatch(/self-report/);
    expect(result.provenanceNote).toMatch(/not the reposter's/);
  });

  it("keeps a quoted post's author and reference distinct from the quoter's words", async () => {
    const recorder = new ResearchAttemptRecorder("operation-bsky-quote");
    const result = await readPersonSource(
      "https://bsky.app/profile/quoter.example",
      "",
      ports(
        recorder,
        feedFetch({
          feed: [
            {
              post: {
                uri: "at://did:plc:quoter/app.bsky.feed.post/q1",
                author: { handle: "quoter.example" },
                record: { text: "#Racism #AntiBlackness", createdAt: "2026-09-05T06:16:36Z" },
                embed: {
                  record: {
                    uri: "at://did:plc:quoted/app.bsky.feed.post/orig1",
                    author: { handle: "quoted.example" },
                    value: { text: "Our paper was reviewed by apartheid itself." },
                  },
                },
              },
            },
          ],
        }),
      ),
    );
    expect(result.text).toContain("#Racism #AntiBlackness");
    expect(result.text).toContain(
      "quotes quoted.example at://did:plc:quoted/app.bsky.feed.post/orig1: Our paper was reviewed by apartheid itself.",
    );
  });

  it("retains an authored post's verbatim passage with author and post reference", async () => {
    /* What recovery of benchmark fact `spatial-apartheid-review`
       (timnit-gebru.json) looks like at the reader seam: the support quote
       surfaces with its original author and a stable post reference. */
    const recorder = new ResearchAttemptRecorder("operation-bsky-recovery");
    const result = await readPersonSource(
      "https://bsky.app/profile/timnitgebru.blacksky.app",
      "",
      ports(
        recorder,
        feedFetch({
          feed: [
            {
              post: {
                uri: "at://did:plc:gebru/app.bsky.feed.post/spatial1",
                author: { handle: "timnitgebru.blacksky.app" },
                record: {
                  text: 'Literally, the (extremely famous) journal sent it to white South African reviewers who pointed out all these "papers" written by white South Africans DURING apartheid, that we failed to cite.',
                  createdAt: "2026-09-05T01:43:02.434Z",
                },
              },
            },
          ],
        }),
      ),
    );
    expect(result.access).toBe("retrieved");
    expect(result.text).toContain("author: timnitgebru.blacksky.app");
    expect(result.text).toContain("at://did:plc:gebru/app.bsky.feed.post/spatial1");
    expect(result.text).toContain(
      "https://bsky.app/profile/timnitgebru.blacksky.app/post/spatial1",
    );
    expect(result.text).toContain(
      "Literally, the (extremely famous) journal sent it to white South African reviewers",
    );
  });
});

describe("mastodon reader attribution", () => {
  const timelineFetch =
    (statuses: unknown): ReaderPorts["fetch"] =>
    async (url) => {
      if (url.includes("/lookup?")) return jsonResponse(url, { id: "123" });
      if (url.includes("/statuses")) return jsonResponse(url, statuses);
      throw new Error(`unexpected fetch of ${url}`);
    };

  it("attributes a reblog to its original author, never the reblogger", async () => {
    const recorder = new ResearchAttemptRecorder("operation-masto-reblog");
    const result = await readPersonSource(
      "https://mastodon.social/@maya",
      "",
      ports(
        recorder,
        timelineFetch([
          {
            created_at: "2026-09-01T00:00:00Z",
            content: "<p>Maya Chen released the coastal sensor report.</p>",
            url: "https://mastodon.social/@maya/1",
            account: { acct: "maya", url: "https://mastodon.social/@maya" },
            reblog: null,
          },
          {
            created_at: "2026-09-02T00:00:00Z",
            content: "",
            url: "https://mastodon.social/@maya/2",
            account: { acct: "maya", url: "https://mastodon.social/@maya" },
            reblog: {
              created_at: "2026-09-01T12:00:00Z",
              content: "<p>The estuary readings are public.</p>",
              url: "https://ocean.example/@sam/99",
              account: { acct: "sam@ocean.example", url: "https://ocean.example/@sam" },
            },
          },
        ]),
      ),
    );
    expect(result.route).toBe("mastodon");
    expect(result.upstreamIndex).toBe("mastodon.social");
    /* Mixed own + reblogged timeline: no single feed-owner author claim. */
    expect(result.author).toBeNull();
    expect(result.text).toContain(
      "author: maya; status: https://mastodon.social/@maya/1; post — Maya Chen released the coastal sensor report.",
    );
    expect(result.text).toContain("author: sam@ocean.example (original)");
    expect(result.text).toContain("reblogged by @maya@mastodon.social");
    expect(result.text).toContain("status: https://ocean.example/@sam/99");
    expect(result.text).toContain("reblog — The estuary readings are public.");
    expect(result.provenanceNote).toMatch(/self-report/);
    expect(result.provenanceNote).toMatch(/not the reblogger's/);
  });

  it("records a precise failure when the instance disables public statuses", async () => {
    /* The stub simulates an instance that answers lookup but refuses
       statuses; the mastodon.social hostname is only what routes the URL to
       the Mastodon reader — no request leaves the stub. */
    const recorder = new ResearchAttemptRecorder("operation-masto-closed");
    const fetch: ReaderPorts["fetch"] = async (url) => {
      if (url.includes("/lookup?")) return jsonResponse(url, { id: "123" });
      return {
        url,
        status: 401,
        contentType: "application/json",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body: '{"error":"This instance does not allow public access."}',
      };
    };
    const result = await readPersonSource(
      "https://mastodon.social/@maya",
      "profile snippet",
      ports(recorder, fetch),
    );
    /* Never retrieved, and never an assumed absence: the refusal is observed. */
    expect(result.access).not.toBe("retrieved");
    const refusal = recorder.failures().find((attempt) => attempt.target.includes("/statuses"));
    expect(refusal).toMatchObject({ code: "login-required", cause: "observed" });
    expect(refusal?.observed?.status).toBe(401);
  });
});
