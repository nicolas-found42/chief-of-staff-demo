import { SOURCE_ELIGIBILITY } from "../../../apps/server/src/source-adapters/eligibility.js";
import { fromPartial } from "@total-typescript/shoehorn";
import { expect, test } from "vitest";
import { ResearchAttemptRecorder } from "../../../apps/server/src/person-profile/research-diagnostics.js";
import {
  readPersonSource,
  type ReaderPorts,
} from "../../../apps/server/src/person-profile/research-readers.js";

/**
 * Podcast feed transcripts as retained spoken evidence (issue #245).
 *
 * A feed's `<podcast:transcript>` link is followed and its text retained with
 * timestamp anchors; episode descriptions are never retained as transcripts.
 * The three controlled cases: a feed with a transcript link, a feed without
 * one, and a transcript link that fails to retrieve.
 */

const FEED_URL = "https://podcast.example/feed.xml";
const TRANSCRIPT_URL = "https://podcast.example/episodes/1.srt";

const stamp = (totalSeconds: number): string => {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},000`;
};

/* Thirteen cues, ten seconds apart: anchors land on the opening cue and every
   twelfth after it, so the second anchor reads 02:00. */
const srt = Array.from(
  { length: 13 },
  (_, index) =>
    `${String(index + 1)}\n${stamp(index * 10)} --> ${stamp(index * 10 + 8)}\nSpoken line ${String(index + 1)}.`,
).join("\n\n");

const feedWithTranscript = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0">
  <channel>
    <title>Soil Stories</title>
    <item>
      <title>Episode one: soil health</title>
      <pubDate>Mon, 01 Sep 2026 10:00:00 GMT</pubDate>
      <description>Show notes describing soil health, not the spoken words.</description>
      <link>https://podcast.example/episodes/1</link>
      <podcast:transcript url="${TRANSCRIPT_URL}" />
    </item>
    <item>
      <title>Episode two: compost</title>
      <pubDate>Mon, 08 Sep 2026 10:00:00 GMT</pubDate>
      <description>Show notes about compost.</description>
      <link>https://podcast.example/episodes/2</link>
    </item>
  </channel>
</rss>`;

const feedWithoutTranscript = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0">
  <channel>
    <title>Soil Stories</title>
    <item>
      <title>Episode one: soil health</title>
      <pubDate>Mon, 01 Sep 2026 10:00:00 GMT</pubDate>
      <description>Show notes describing soil health, not the spoken words.</description>
      <link>https://podcast.example/episodes/1</link>
    </item>
  </channel>
</rss>`;

const ports = (recorder: ResearchAttemptRecorder, fetch: ReaderPorts["fetch"]): ReaderPorts =>
  fromPartial({
    fetch,
    fetchBytes: async (url: string) => {
      throw new Error(`fetchBytes unexpected on ${url}`);
    },
    recorder,
    timeoutMs: 1000,
  });

const answer = (url: string, status: number, contentType: string, body: string) => ({
  url,
  status,
  contentType,
  etag: null,
  lastModified: null,
  retryAfter: null,
  body,
});

test("a feed transcript link is followed and its text retained with anchors", async () => {
  const recorder = new ResearchAttemptRecorder("operation-feed-transcript");
  const requested: string[] = [];
  const result = await readPersonSource(
    FEED_URL,
    "",
    ports(recorder, async (target) => {
      requested.push(target);
      if (target === TRANSCRIPT_URL)
        /* The observed publisher serves SRT as application/octet-stream with
           no tag type to trust, so the cue container must be sniffed. */
        return answer(target, 200, "application/octet-stream", srt);
      return answer(target, 200, "application/rss+xml", feedWithTranscript);
    }),
  );

  expect(requested).toContain(TRANSCRIPT_URL);
  expect(result.route).toBe("feed-reader");
  expect(result.family).toBe("spoken-evidence");
  expect(result.access).toBe("retrieved");
  expect(result.finalUrl).toBe(TRANSCRIPT_URL);
  expect(result.upstreamIndex).toBe("podcast.example");
  expect(result.rights).toBeNull();
  /* Spoken text is retained; show notes are not mixed in. */
  expect(result.text).toContain("Spoken line 1.");
  expect(result.text).not.toContain("Show notes");
  expect(result.text).not.toContain("Feed: Soil Stories");
  expect(result.provenanceNote).toContain("transcript");
  expect(result.provenanceNote).toContain("discovery only");
  expect(result.provenanceNote).not.toBe(
    "Feed entry text is publisher-written description, not a transcript.",
  );
  /* Timestamp anchors locate speech; the cadence marks the opening cue and
     the twelfth after it. */
  expect(result.anchors).toHaveLength(2);
  expect(result.anchors[0]).toEqual({ kind: "timestamp", value: "00:00", offset: 0 });
  expect(result.anchors[1]?.kind).toBe("timestamp");
  expect(result.anchors[1]?.value).toBe("02:00");
  expect(result.anchors[1]?.offset).toBeGreaterThan(0);
  /* Episode links and the unfollowed second item stay leads; the feed itself
     is the investigated URL rather than another lead, and the retained
     transcript is the final URL rather than one. */
  expect(result.outboundUrls).toContain("https://podcast.example/episodes/1");
  expect(result.outboundUrls).toContain("https://podcast.example/episodes/2");
  expect(result.outboundUrls).not.toContain(FEED_URL);
  expect(result.outboundUrls).not.toContain(TRANSCRIPT_URL);
});

test("a feed without a transcript link retains descriptions as descriptions", async () => {
  const recorder = new ResearchAttemptRecorder("operation-feed-no-transcript");
  let fetches = 0;
  const result = await readPersonSource(
    FEED_URL,
    "",
    ports(recorder, async (target) => {
      fetches += 1;
      return answer(target, 200, "application/rss+xml", feedWithoutTranscript);
    }),
  );

  /* No second request: there is no transcript URL to follow. */
  expect(fetches).toBe(1);
  expect(result.route).toBe("feed-reader");
  expect(result.access).toBe("retrieved");
  expect(result.text).toContain("Show notes describing soil health");
  expect(result.provenanceNote).toBe(
    "Feed entry text is publisher-written description, not a transcript.",
  );
  expect(result.anchors).toEqual([]);
  expect(recorder.failures()).toEqual([]);
});

test("a transcript link that fails to retrieve falls back to descriptions", async () => {
  const recorder = new ResearchAttemptRecorder("operation-feed-broken-transcript");
  const result = await readPersonSource(
    FEED_URL,
    "",
    ports(recorder, async (target) => {
      if (target === TRANSCRIPT_URL) return answer(target, 500, "text/plain", "upstream error");
      return answer(target, 200, "application/rss+xml", feedWithTranscript);
    }),
  );

  /* The feed itself was retrieved, so its descriptions still contribute. */
  expect(result.access).toBe("retrieved");
  expect(result.finalUrl).toBe(FEED_URL);
  expect(result.text).toContain("Show notes describing soil health");
  expect(result.provenanceNote).toBe(
    "Feed entry text is publisher-written description, not a transcript.",
  );
  /* The failure is a precise unavailable-transcript diagnostic with the
     observed cause, not a silent drop. */
  const transcriptFailures = recorder.failures().filter((entry) => entry.stage === "transcription");
  expect(transcriptFailures).toHaveLength(1);
  expect(transcriptFailures[0]).toMatchObject({
    code: "http-error",
    collector: "feed-reader",
    target: TRANSCRIPT_URL,
  });
});

const JSON_TRANSCRIPT_URL = "https://podcast.example/episodes/9.json";

const jsonTranscript = JSON.stringify({
  version: "1.0.0",
  segments: [
    { speaker: "Ada", startTime: 0.4, endTime: 4.2, body: "Welcome to the show." },
    { startTime: 65.5, endTime: 70.0, body: "Today we discuss soil." },
  ],
});

const feedWithJsonTranscript = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0">
  <channel>
    <title>Soil Stories</title>
    <item>
      <title>Episode nine: nitrogen</title>
      <pubDate>Mon, 08 Sep 2026 10:00:00 GMT</pubDate>
      <description>Show notes about nitrogen.</description>
      <link>https://podcast.example/episodes/9</link>
      <podcast:transcript url="${JSON_TRANSCRIPT_URL}" type="application/json" />
    </item>
  </channel>
</rss>`;

test("a JSON transcript keeps speakers with their lines and segment anchors", async () => {
  const recorder = new ResearchAttemptRecorder("operation-feed-json-transcript");
  const result = await readPersonSource(
    FEED_URL,
    "",
    ports(recorder, async (target) => {
      if (target === JSON_TRANSCRIPT_URL)
        return answer(target, 200, "application/json", jsonTranscript);
      return answer(target, 200, "application/rss+xml", feedWithJsonTranscript);
    }),
  );

  expect(result.access).toBe("retrieved");
  expect(result.finalUrl).toBe(JSON_TRANSCRIPT_URL);
  /* A quotation without its speaker misattributes speech. */
  expect(result.text).toContain("Ada: Welcome to the show.");
  expect(result.text).not.toContain("Show notes");
  expect(result.anchors[0]).toEqual({ kind: "timestamp", value: "00:00", offset: 0 });
});

test("the feed-reader route declares anonymous terms with its own probe", () => {
  const entry = SOURCE_ELIGIBILITY.find((candidate) => candidate.route === "feed-reader");
  expect(entry).toMatchObject({
    family: "spoken-evidence",
    cost: "anonymous",
    status: "in-production",
  });
  expect(entry?.terms).toContain("no key");
  expect(entry?.probe).toContain("https://");
  expect(entry?.expect?.("00:00:00,400 --> 00:00:06,679")).toBe(true);
  /* The keyed directory stays excluded even with its free tier, and the
     Apple directory entry it is verified against stays anonymous. */
  expect(SOURCE_ELIGIBILITY.find((candidate) => candidate.route === "podcastindex")?.status).toBe(
    "excluded",
  );
  expect(
    SOURCE_ELIGIBILITY.find((candidate) => candidate.route === "podcast-directory")?.cost,
  ).toBe("anonymous");
});
