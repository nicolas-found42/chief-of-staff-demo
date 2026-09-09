import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCE_ELIGIBILITY } from "../../../apps/server/src/source-adapters/eligibility.js";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, expect, test } from "vitest";
import { loadCorpus } from "../../../apps/server/src/person-benchmark/corpus.js";
import { PersonDossierStore } from "../../../apps/server/src/person-profile/dossier-store.js";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles.js";
import { ResearchAttemptRecorder } from "../../../apps/server/src/person-profile/research-diagnostics.js";
import {
  readPersonSource,
  type ReaderPorts,
} from "../../../apps/server/src/person-profile/research-readers.js";
import {
  PersonResearch,
  researchAllowance,
} from "../../../apps/server/src/person-profile/research.js";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store.js";

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
  /* The retained source is keyed by the feed URL, so the note carries the
     followed file: the precise pointer a citation grounds on. */
  expect(result.provenanceNote).toContain(TRANSCRIPT_URL);
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

const PLAIN_TRANSCRIPT_URL = "https://podcast.example/episodes/3.txt";

const feedWithPlainTranscript = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0">
  <channel>
    <title>Soil Stories</title>
    <item>
      <title>Episode three: cover crops</title>
      <pubDate>Mon, 15 Sep 2026 10:00:00 GMT</pubDate>
      <description>Show notes about cover crops.</description>
      <link>https://podcast.example/episodes/3</link>
      <podcast:transcript url="${PLAIN_TRANSCRIPT_URL}" type="text/plain" />
    </item>
  </channel>
</rss>`;

test("a one-line error string served as plain text is never retained as a transcript", async () => {
  const recorder = new ResearchAttemptRecorder("operation-feed-error-string");
  const result = await readPersonSource(
    FEED_URL,
    "",
    ports(recorder, async (target) => {
      if (target === PLAIN_TRANSCRIPT_URL)
        return answer(target, 200, "text/plain", "upstream error");
      return answer(target, 200, "application/rss+xml", feedWithPlainTranscript);
    }),
  );

  /* HTTP 200 with a lone error string is the same gap as a failed fetch. */
  expect(result.access).toBe("retrieved");
  expect(result.finalUrl).toBe(FEED_URL);
  expect(result.text).toContain("Show notes about cover crops");
  expect(result.text).not.toContain("upstream error");
  const transcriptFailures = recorder.failures().filter((entry) => entry.stage === "transcription");
  expect(transcriptFailures).toHaveLength(1);
  expect(transcriptFailures[0]).toMatchObject({
    code: "transcription-failed",
    collector: "feed-reader",
    target: PLAIN_TRANSCRIPT_URL,
  });
});

test("sustained plain-text speech is retained without anchors", async () => {
  const recorder = new ResearchAttemptRecorder("operation-feed-plain-transcript");
  const speech = [
    "Devi Shetty: The cost of heart surgery can come down dramatically.",
    "Devi Shetty: We tried hard to bring down the cost for every family.",
    "Devi Shetty: Simpler care means more children live past their first year.",
    "Devi Shetty: That is the whole premise of the Narayana Health model.",
  ].join("\n");
  const result = await readPersonSource(
    FEED_URL,
    "",
    ports(recorder, async (target) => {
      if (target === PLAIN_TRANSCRIPT_URL) return answer(target, 200, "text/plain", speech);
      return answer(target, 200, "application/rss+xml", feedWithPlainTranscript);
    }),
  );

  expect(result.access).toBe("retrieved");
  expect(result.finalUrl).toBe(PLAIN_TRANSCRIPT_URL);
  expect(result.text).toContain("The cost of heart surgery can come down dramatically.");
  expect(result.text).not.toContain("Show notes");
  /* No container, no timestamps: prose carries no anchors. */
  expect(result.anchors).toEqual([]);
  expect(result.provenanceNote).toContain(PLAIN_TRANSCRIPT_URL);
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

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The authored spoken-evidence reference fact this transcript has to ground (#240). */
function spokenReference() {
  const corpus = loadCorpus(
    fileURLToPath(new URL("../../../benchmark/person-research/people", import.meta.url)),
  );
  const person = corpus.people.find((entry) => entry.slug === "devi-shetty")!;
  const fact = person.facts.find((entry) => entry.id === "price-tag-on-life")!;
  const support = fact.support[0];
  return { fact, quote: support.quote, second: fact.support[1].quote };
}

const SHETTY_FEED_URL = "https://fixinghealthcare.example/feed.xml";
const SHETTY_TRANSCRIPT_URL = "https://fixinghealthcare.example/episodes/7.json";

test("a publisher transcript grounds an authored spoken-evidence reference fact", async () => {
  const { fact, quote, second } = spokenReference();
  /* The transcript file carries the authored quotes verbatim in its own
     segments; the feed only points at the file. */
  const transcript = JSON.stringify({
    version: "1.0.0",
    segments: [
      { speaker: "Devi Shetty", startTime: 61.2, endTime: 75.8, body: quote },
      { speaker: "Devi Shetty", startTime: 76.0, endTime: 88.4, body: second },
    ],
  });
  const feed =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0">` +
    `<channel><title>Fixing Healthcare</title>` +
    `<item><title>Episode 7: Interview with Dr. Devi Shetty</title>` +
    `<pubDate>Mon, 11 Feb 2019 10:00:00 GMT</pubDate>` +
    `<description>Dr. Devi Shetty on the cost of care.</description>` +
    `<link>https://fixinghealthcare.example/episodes/7</link>` +
    `<podcast:transcript url="${SHETTY_TRANSCRIPT_URL}" type="application/json" />` +
    `</item></channel></rss>`;
  const root = mkdtempSync(join(tmpdir(), "research-feed-transcript-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({ fullName: "Devi Shetty" });
  const dossiers = new PersonDossierStore(root);
  const research = new PersonResearch({
    people,
    dossiers,
    search: async () => [{ url: SHETTY_FEED_URL, title: "Fixing Healthcare", snippet: "" }],
    fetch: async (url) => ({
      url,
      status: 200,
      contentType: url === SHETTY_TRANSCRIPT_URL ? "application/json" : "application/rss+xml",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body: url === SHETTY_TRANSCRIPT_URL ? transcript : feed,
    }),
    complete: async () => ({
      fullName: null,
      employer: null,
      sourceClass: "self-report",
      author: null,
      publishedAt: null,
      claims: [
        {
          id: "price-tag-on-life",
          section: "work",
          statement: fact.statement,
          status: "supported",
          nature: "statement",
          matchConfidence: "high",
          effectiveFrom: fact.effectiveFrom,
          effectiveTo: null,
          citations: [{ sourceId: "source", quote }],
          supports: [],
          supersedes: [],
          changeReason: null,
        },
      ],
      works: [],
      expertise: [],
      connections: [],
      sections: [],
    }),
  });

  await research.run(person, researchAllowance({ maxModelCalls: 4, maxMilliseconds: 20_000 }));

  const dossier = dossiers.get(person.id)!;
  const claim = dossier.claims.find((entry) => entry.statement === fact.statement)!;
  expect(claim.citations[0].quote).toBe(quote);
  const source = dossiers.source(person.id, claim.citations[0].sourceId)!;
  /* Retained spoken text, not a show note: the cited words are what the claim
     is grounded in, and the note names the followed transcript file. */
  expect(source.text).toContain(quote);
  expect(source.evidenceFamily).toBe("spoken-evidence");
  expect(source.provenanceNote).toContain("transcript");
  expect(source.provenanceNote).toContain(SHETTY_TRANSCRIPT_URL);
});
