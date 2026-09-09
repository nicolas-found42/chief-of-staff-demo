import { fromPartial } from "@total-typescript/shoehorn";
import { expect, test } from "vitest";
import { ResearchAttemptRecorder } from "../../../apps/server/src/person-profile/research-diagnostics.js";
import {
  readPersonSource,
  type ReaderPorts,
} from "../../../apps/server/src/person-profile/research-readers.js";
import {
  describeFamilyShortfall,
  LeadRegistry,
} from "../../../apps/server/src/person-profile/research-plan.js";
import { SOURCE_ELIGIBILITY } from "../../../apps/server/src/source-adapters/eligibility.js";

/**
 * The unavailable transcription runtime (issue #246, outcome B).
 *
 * No transcription is reachable from person research: its readers are bounded
 * anonymous GETs, and no usable transcription runtime is provisioned (this
 * host carries yt-dlp and ffmpeg but no whisper-cli and no model weights; the
 * runtime image ships whisper-cli v1.7.6 with no model file provisioned).
 * These controls pin the contract for that absence: every caption-failure
 * path records a transcription-stage failure naming what supplying it would
 * take, an unreadable spoken page carries that reason on the result for the
 * lead record and the coverage plan, and the spoken-evidence family gap names
 * its blocked reads instead of going quiet.
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

const youtubeWatchPageWithoutDescription = (tracks: string) =>
  `<html><head><title>Untitled</title></head><body>{"captionTracks":[${tracks}]}</body></html>`;

const PEERTUBE_WATCH = "https://diler.tube/videos/watch/5b40975c-a305-4a74-bb16-e344b62dff49";

const peertubeListing = (data: unknown) =>
  JSON.stringify({ total: Array.isArray(data) ? data.length : 0, data });

const transcriptionFailures = (recorder: ResearchAttemptRecorder) =>
  recorder.all().filter((attempt) => attempt.code === "transcription-failed");

test("a YouTube video with no tracks records the unavailable transcription runtime", async () => {
  const recorder = new ResearchAttemptRecorder("operation-spoken-transcription-youtube");
  const result = await readPersonSource(
    YOUTUBE_WATCH,
    "",
    ports(recorder, async (url) => response(url, 200, "text/html", youtubeWatchPage(""))),
  );

  /* The publisher's description is the retained evidence, labelled as only
     that — never as a transcript. */
  expect(result).toMatchObject({
    access: "retrieved",
    family: "spoken-evidence",
    provenanceNote:
      "Publisher-written video description only; no caption track was available for this video.",
  });
  expect(result.text).toContain("A talk about relationships.");
  expect(result.failureReason).toBeUndefined();

  const captions = recorder.all().filter((attempt) => attempt.code === "captions-missing");
  expect(captions).toHaveLength(1);
  expect(captions[0]?.reason).toContain("lists no caption tracks");

  /* The transcript-generation gap is its own failure: what is missing is a
     runtime, and the record says what supplying it would take. */
  const transcription = transcriptionFailures(recorder);
  expect(transcription).toHaveLength(1);
  expect(transcription[0]).toMatchObject({
    stage: "transcription",
    collector: "caption-reader",
    target: YOUTUBE_WATCH,
  });
  expect(transcription[0]?.reason).toContain("no local transcription runtime");
  expect(transcription[0]?.remediation).toContain("whisper-cli");
  expect(transcription[0]?.remediation).toContain("/usr/local/share/whisper-cpp-model.bin");
  expect(transcription[0]?.remediation).toContain("yt-dlp");
  expect(transcription[0]?.recoveryStopped).toContain(
    "No local transcription runtime is available to person research.",
  );
});

test("a YouTube video with no tracks and no description names the runtime on the result", async () => {
  const recorder = new ResearchAttemptRecorder("operation-spoken-transcription-youtube-bare");
  const result = await readPersonSource(
    YOUTUBE_WATCH,
    "",
    ports(recorder, async (url) =>
      response(url, 200, "text/html", youtubeWatchPageWithoutDescription("")),
    ),
  );

  expect(result).toMatchObject({ access: "failed", family: "spoken-evidence" });
  /* The lead record and the coverage plan read this reason; it must name the
     missing capability and what it requires, not merely the access value. */
  expect(result.failureReason).toContain("lists no caption tracks");
  expect(result.failureReason).toContain("whisper-cli");
  expect(result.failureReason).toContain("/usr/local/share/whisper-cpp-model.bin");
  expect(transcriptionFailures(recorder)).toHaveLength(1);
});

test("a listed YouTube track answering an empty body records the runtime against the track", async () => {
  const recorder = new ResearchAttemptRecorder("operation-spoken-transcription-youtube-empty");
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
          : youtubeWatchPage(`{"baseUrl":"${YOUTUBE_TRACK}","languageCode":"en"}`),
      ),
    ),
  );

  expect(result).toMatchObject({
    access: "retrieved",
    provenanceNote:
      "Publisher-written video description only; no caption track was available for this video.",
  });
  const transcription = transcriptionFailures(recorder);
  expect(transcription).toHaveLength(1);
  expect(transcription[0]).toMatchObject({ stage: "transcription", target: YOUTUBE_TRACK });
  expect(transcription[0]?.reason).toContain("HTTP 200 with an empty body");
  expect(transcription[0]?.remediation).toContain("whisper-cli");
});

test("a PeerTube video with no caption files records the runtime and keeps the reason", async () => {
  const recorder = new ResearchAttemptRecorder("operation-spoken-transcription-peertube");
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
  const captions = recorder.all().filter((attempt) => attempt.code === "captions-missing");
  expect(captions).toHaveLength(1);
  expect(captions[0]?.reason).toContain("lists no caption files");

  const transcription = transcriptionFailures(recorder);
  expect(transcription).toHaveLength(1);
  expect(transcription[0]).toMatchObject({ stage: "transcription" });
  expect(transcription[0]?.remediation).toContain("whisper-cli");

  /* The watch-page fallback produced no usable text either, so the result
     carries the specific reason for the lead record and coverage plan. */
  expect(result.failureReason).toContain("lists no caption files");
  expect(result.failureReason).toContain("whisper-cli");
});

test("an investigated spoken-evidence family reports no evidence without alarm", () => {
  const gaps = describeFamilyShortfall("spoken-evidence", "investigated", new LeadRegistry());
  expect(gaps).toEqual(["No source in this family contributed evidence in this operation."]);
});

test("an inaccessible spoken-evidence family with no blocked reads stays generic", () => {
  const gaps = describeFamilyShortfall("spoken-evidence", "inaccessible", new LeadRegistry());
  expect(gaps).toEqual(["No query or source in this operation could be aimed at this family."]);
});

test("an inaccessible spoken-evidence family names its blocked reads", () => {
  const leads = new LeadRegistry();
  const added = leads.add({ kind: "url", target: YOUTUBE_WATCH, origin: "discovery" });
  expect(added).not.toBeNull();
  leads.resolve(
    added!.id,
    "inaccessible",
    "The video page lists no caption tracks and no local transcription runtime is available to person research.",
  );

  const gaps = describeFamilyShortfall("spoken-evidence", "inaccessible", leads);
  expect(gaps).toHaveLength(1);
  expect(gaps[0]).toContain(`Could not read ${YOUTUBE_WATCH}:`);
  expect(gaps[0]).toContain("no local transcription runtime");
});

test("blocked reads aimed at other families do not leak into the spoken gap", () => {
  const leads = new LeadRegistry();
  const added = leads.add({
    kind: "url",
    target: "https://example.com/paper.pdf",
    origin: "discovery",
  });
  expect(added).not.toBeNull();
  leads.resolve(added!.id, "inaccessible", "Reading produced no usable text (failed).");

  const gaps = describeFamilyShortfall("spoken-evidence", "inaccessible", leads);
  expect(gaps).toEqual(["No query or source in this operation could be aimed at this family."]);
});

test("the local-transcription route is declared unavailable with its requirements", () => {
  const entry = SOURCE_ELIGIBILITY.find((candidate) => candidate.route === "local-transcription");
  expect(entry).toMatchObject({
    family: "spoken-evidence",
    cost: "anonymous",
    status: "unavailable",
  });
  expect(entry?.exclusion).toContain("whisper-cli");
  expect(entry?.exclusion).toContain("/usr/local/share/whisper-cpp-model.bin");
});
