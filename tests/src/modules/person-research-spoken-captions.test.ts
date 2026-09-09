import { fromPartial } from "@total-typescript/shoehorn";
import { expect, test } from "vitest";
import { ResearchAttemptRecorder } from "../../../apps/server/src/person-profile/research-diagnostics.js";
import {
  readPersonSource,
  type ReaderPorts,
} from "../../../apps/server/src/person-profile/research-readers.js";

/**
 * Caption and timed-text evidence (issue #244).
 *
 * Live observations behind these controls, all anonymous, 2026-09-09:
 * - YouTube watch pages still list caption tracks, and the listed timed-text
 *   route still answers HTTP 200 with a zero-byte body (srv3 and default
 *   formats, Gangnam Style asr track) — so production records the empty-body
 *   gap and only a format-faithful control exercises the retention path.
 * - diler.tube (a public PeerTube instance) answers the captions listing and
 *   serves the WebVTT file anonymously. The VTT below is a verbatim excerpt
 *   of Hilary Cottam's TED talk captions captured live; the retained
 *   73-services passage is the spoken statement behind the authored
 *   `agency-fragmentation` reference fact's "more than 70 different
 *   agencies" framing in benchmark/person-research/people/hilary-cottam.json
 *   (73 > 70, same talk, same fragmented-support claim).
 */

const ports = (recorder: ResearchAttemptRecorder, fetch: ReaderPorts["fetch"]): ReaderPorts =>
  fromPartial({ fetch, recorder, timeoutMs: 1000 });

const response = (url: string, status: number, contentType: string, body: string) => ({
  url,
  status,
  contentType,
  etag: null,
  lastModified: null,
  retryAfter: null,
  body,
});

const YOUTUBE_WATCH = "https://www.youtube.com/watch?v=talk1";
const YOUTUBE_TRACK = "https://www.youtube.com/api/timedtext?v=talk1";

const youtubeWatchPage = (tracks: string) =>
  `<html><head><title>Three stories</title></head><body>` +
  `{"captionTracks":[${tracks}]}` +
  ` "shortDescription":"A talk about relationships."` +
  ` "title":{"runs":[{"text":"Three stories"}]}</body></html>`;

/* YouTube's srv timed-text shape carrying the talk's real opening lines. */
const timedTextXml =
  `<?xml version="1.0" encoding="utf-8" ?><transcript>` +
  `<text start="12.5" dur="1.96">I want to tell you three stories</text>` +
  `<text start="15.06" dur="2.18">about the power of relationships</text>` +
  `<text start="17.24" dur="3.8">to solve the deep and complex social problems of this century.</text>` +
  `</transcript>`;

const PEERTUBE_WATCH = "https://diler.tube/videos/watch/5b40975c-a305-4a74-bb16-e344b62dff49";
const PEERTUBE_AUTO_FILE =
  "https://diler.tube/lazy-static/video-captions/9d796ae7-9258-48b1-9fd9-bffa37fed6f8-en.vtt";
const PEERTUBE_MANUAL_FILE = "https://diler.tube/lazy-static/video-captions/manual-en.vtt";

/* Verbatim excerpt of the live-captured WebVTT (diler.tube, 2026-09-09):
   header, the opening cues, the 73-services passage, then the
   cost-of-the-system passage. */
const cottamVtt = `WEBVTT

00:12.500 --> 00:14.460
I want to tell you three stories

00:15.060 --> 00:17.240
about the power of relationships

00:17.240 --> 00:21.040
to solve the deep and complex social problems of this century.

00:22.020 --> 00:25.860
You know, sometimes it seems like all these problems of poverty, inequality,

00:26.520 --> 00:29.240
ill health, unemployment, violence, addiction,

00:29.560 --> 00:31.780
they're right there in one person's life.

00:32.560 --> 00:35.500
So I want to tell you about someone like this that I know.

00:36.340 --> 00:37.280
I'm going to call her Ella.

00:38.320 --> 00:41.540
Ella lives in a British city on a rundown estate.

00:42.160 --> 00:44.140
The shops are closed, the pub's gone,

00:44.340 --> 00:46.260
the playground's pretty desolate and never used.

00:46.740 --> 00:49.640
And inside Ella's house, the tension is palpable

01:29.460 --> 01:30.620
But when I met Ella,

01:31.000 --> 01:34.460
there were 73 different services on offer for her and her family

01:34.460 --> 01:35.620
in the city where she lives.

01:36.160 --> 01:39.900
73 different services run out of 24 departments in one city.

01:40.420 --> 01:43.120
And Ella and her partners and her children were known to most of them.

02:59.260 --> 03:03.040
Well, the first thing I learned is that cost is a really slippery concept,

03:03.380 --> 03:05.880
because when the government says that a family like Ella's

03:05.880 --> 03:08.280
cost a quarter of a million pounds a year to manage,

03:08.700 --> 03:12.340
what it really means is that this system cost a quarter of a million pounds a year,

03:12.520 --> 03:15.860
because not one penny of this money actually touches Ella's family

03:15.860 --> 03:17.020
in a way that makes a difference.
`;

const peertubeListing = (data: unknown) =>
  JSON.stringify({ total: Array.isArray(data) ? data.length : 0, data });

const autoTrack = {
  language: { id: "en", label: "English" },
  automaticallyGenerated: true,
  captionPath: "/lazy-static/video-captions/9d796ae7-9258-48b1-9fd9-bffa37fed6f8-en.vtt",
  fileUrl: PEERTUBE_AUTO_FILE,
};

test("a listed YouTube caption track retains timed text with timestamp anchors", async () => {
  const recorder = new ResearchAttemptRecorder("operation-spoken-youtube-success");
  const result = await readPersonSource(
    YOUTUBE_WATCH,
    "",
    ports(recorder, async (url) =>
      response(
        url,
        200,
        url.includes("timedtext") ? "text/xml" : "text/html",
        url.includes("timedtext")
          ? timedTextXml
          : youtubeWatchPage(`{"baseUrl":"${YOUTUBE_TRACK}","languageCode":"en"}`),
      ),
    ),
  );

  expect(result).toMatchObject({
    access: "retrieved",
    completeness: "full",
    family: "spoken-evidence",
    route: "caption-reader",
    upstreamIndex: "youtube.com",
    author: null,
    text: "I want to tell you three stories about the power of relationships to solve the deep and complex social problems of this century.",
    anchors: [{ kind: "timestamp", value: "00:12", offset: 0 }],
    provenanceNote:
      "Publisher-provided captions. Timestamps locate speech; they do not identify the speaker.",
  });
  expect(result.anchors.every((anchor) => anchor.kind === "timestamp")).toBe(true);
  expect(recorder.all()).toHaveLength(0);
});

test("a YouTube video with no caption tracks falls back to its labelled description", async () => {
  const recorder = new ResearchAttemptRecorder("operation-spoken-youtube-absent");
  const result = await readPersonSource(
    YOUTUBE_WATCH,
    "",
    ports(recorder, async (url) => response(url, 200, "text/html", youtubeWatchPage(""))),
  );

  expect(result).toMatchObject({
    access: "retrieved",
    family: "spoken-evidence",
    route: "caption-reader",
    anchors: [],
    provenanceNote:
      "Publisher-written video description only; no caption track was available for this video.",
  });
  expect(result.text).toContain("A talk about relationships.");
  const gaps = recorder.all().filter((attempt) => attempt.code === "captions-missing");
  expect(gaps).toHaveLength(1);
  expect(gaps[0]).toMatchObject({
    stage: "caption-acquisition",
    collector: "caption-reader",
  });
  expect(gaps[0]?.reason).toContain("lists no caption tracks");
});

test("a listed YouTube track answering an empty body records the empty-200 gap", async () => {
  const recorder = new ResearchAttemptRecorder("operation-spoken-youtube-empty");
  const result = await readPersonSource(
    YOUTUBE_WATCH,
    "",
    ports(recorder, async (url) =>
      response(
        url,
        200,
        url.includes("timedtext") ? "text/xml" : "text/html",
        url.includes("timedtext")
          ? ""
          : youtubeWatchPage(`{"baseUrl":"${YOUTUBE_TRACK}","languageCode":"en","kind":"asr"}`),
      ),
    ),
  );

  /* The live route behaves exactly this way today, so the description is the
     retained evidence and the gap names what was observed. */
  expect(result).toMatchObject({
    access: "retrieved",
    provenanceNote:
      "Publisher-written video description only; no caption track was available for this video.",
  });
  const gaps = recorder.all().filter((attempt) => attempt.code === "captions-missing");
  expect(gaps).toHaveLength(1);
  expect(gaps[0]?.reason).toContain("HTTP 200 with an empty body");
});

test("a PeerTube caption file retains real speech supporting the authored talk claim", async () => {
  const recorder = new ResearchAttemptRecorder("operation-spoken-peertube-success");
  const result = await readPersonSource(
    PEERTUBE_WATCH,
    "",
    ports(recorder, async (url) => {
      if (url.includes("/api/v1/videos/"))
        return response(url, 200, "application/json", peertubeListing([autoTrack]));
      if (url.includes("lazy-static/video-captions"))
        return response(url, 200, "text/vtt", cottamVtt);
      throw new Error(`unexpected fetch ${url}`);
    }),
  );

  /* Verbatim speech from Cottam's talk stating the claim behind the authored
     `agency-fragmentation` reference fact: 73 different services run out of
     24 departments for one family is the spoken form of the description's
     "more than 70 different agencies" framing. */
  expect(result).toMatchObject({
    access: "retrieved",
    completeness: "full",
    family: "spoken-evidence",
    route: "caption-reader",
    upstreamIndex: "diler.tube",
    author: null,
    provenanceNote:
      "Automatic speech recognition captions from the hosting PeerTube instance. Timestamps locate speech; they do not identify the speaker.",
  });
  expect(result.text).toContain(
    "not one penny of this money actually touches Ella's family in a way that makes a difference",
  );
  expect(result.text).toContain(
    "there were 73 different services on offer for her and her family in the city where she lives",
  );
  expect(result.text).toContain("73 different services run out of 24 departments in one city");
  /* Timestamp anchors survive into the retained evidence; nothing presents a
     timestamp — or a voice label — as speaker identification. */
  expect(result.anchors).toHaveLength(2);
  expect(result.anchors[0]).toEqual({ kind: "timestamp", value: "00:12", offset: 0 });
  expect(result.anchors[1]?.value).toBe("01:29");
  expect(result.text.slice(result.anchors[1]?.offset ?? 0)).toMatch(
    /^But when I met Ella, there were 73 different services/,
  );
  expect(result.anchors.every((anchor) => anchor.kind === "timestamp")).toBe(true);
  expect(recorder.all()).toHaveLength(0);
});

test("a PeerTube listing prefers publisher captions over automatic ones", async () => {
  const recorder = new ResearchAttemptRecorder("operation-spoken-peertube-preference");
  const requested: string[] = [];
  const result = await readPersonSource(
    PEERTUBE_WATCH,
    "",
    ports(recorder, async (url) => {
      requested.push(url);
      if (url.includes("/api/v1/videos/"))
        return response(
          url,
          200,
          "application/json",
          peertubeListing([
            autoTrack,
            {
              language: { id: "en", label: "English" },
              automaticallyGenerated: false,
              fileUrl: PEERTUBE_MANUAL_FILE,
            },
          ]),
        );
      if (url === PEERTUBE_MANUAL_FILE) return response(url, 200, "text/vtt", cottamVtt);
      throw new Error(`unexpected fetch ${url}`);
    }),
  );

  expect(requested).toContain(PEERTUBE_MANUAL_FILE);
  expect(requested).not.toContain(PEERTUBE_AUTO_FILE);
  expect(result.provenanceNote).toContain("Publisher-provided captions");
  expect(result.access).toBe("retrieved");
});

test("a PeerTube video with no caption files records the gap and reads the page", async () => {
  const recorder = new ResearchAttemptRecorder("operation-spoken-peertube-absent");
  const result = await readPersonSource(
    PEERTUBE_WATCH,
    "",
    ports(recorder, async (url) => {
      if (url.includes("/api/v1/videos/"))
        return response(url, 200, "application/json", peertubeListing([]));
      return response(url, 404, "text/plain", "Not found");
    }),
  );

  expect(result).toMatchObject({ access: "failed", family: "spoken-evidence" });
  const gaps = recorder.all().filter((attempt) => attempt.code === "captions-missing");
  expect(gaps).toHaveLength(1);
  expect(gaps[0]).toMatchObject({
    stage: "caption-acquisition",
    collector: "caption-reader",
  });
  expect(gaps[0]?.reason).toContain("lists no caption files");
});

test("a PeerTube caption file answering an empty body records the gap and falls back", async () => {
  const recorder = new ResearchAttemptRecorder("operation-spoken-peertube-empty");
  const result = await readPersonSource(
    PEERTUBE_WATCH,
    "",
    ports(recorder, async (url) => {
      if (url.includes("/api/v1/videos/"))
        return response(url, 200, "application/json", peertubeListing([autoTrack]));
      if (url.includes("lazy-static/video-captions")) return response(url, 200, "text/vtt", "");
      /* Watch-page stand-in: the fallback retains page text, never a transcript. */
      return response(url, 200, "text/plain", "A talk about relationships.");
    }),
  );

  expect(result).toMatchObject({
    access: "retrieved",
    route: "text-reader",
    text: "A talk about relationships.",
  });
  const gaps = recorder.all().filter((attempt) => attempt.code === "captions-missing");
  expect(gaps).toHaveLength(1);
  expect(gaps[0]?.reason).toContain("HTTP 200 with an empty body");
});

test("a PeerTube listing entry without a file URL records what was observed", async () => {
  const recorder = new ResearchAttemptRecorder("operation-spoken-peertube-no-url");
  const result = await readPersonSource(
    PEERTUBE_WATCH,
    "",
    ports(recorder, async (url) => {
      if (url.includes("/api/v1/videos/"))
        return response(
          url,
          200,
          "application/json",
          peertubeListing([{ language: { id: "en", label: "English" } }]),
        );
      return response(url, 404, "text/plain", "Not found");
    }),
  );

  expect(result).toMatchObject({ access: "failed", family: "spoken-evidence" });
  const gaps = recorder.all().filter((attempt) => attempt.code === "captions-missing");
  expect(gaps).toHaveLength(1);
  expect(gaps[0]?.reason).toContain("no downloadable URL");
});
