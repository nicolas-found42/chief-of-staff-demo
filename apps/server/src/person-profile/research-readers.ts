import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import type { PersonSourceFamily } from "@chief-of-staff-demo/shared";
import { convertToText } from "../text/convert.js";
import {
  type PublicHttpBytesFetch,
  type PublicHttpFetch,
  type PublicHttpResponse,
} from "../source-adapters/http.js";
import type { BrowserRenderer } from "../source-adapters/browser.js";
import {
  classifyHttpStatus,
  classifyTransportError,
  detectChallenge,
  type CollectorName,
  type ResearchAttemptRecorder,
} from "./research-diagnostics.js";

/** Text kept per source. Matches the dossier store's own retention ceiling. */
const MAX_TEXT = 500_000;

/**
 * A citation anchor suited to the format: a PDF page, a caption timestamp, or
 * a document section. Stored beside the text so a claim can point at where in
 * a 90-minute talk or a 40-page filing its passage came from.
 */
interface SourceAnchor {
  kind: "page" | "timestamp" | "section";
  value: string;
  /** Character offset into the retained text where this anchor begins. */
  offset: number;
}

export interface SourceReadResult {
  text: string;
  completeness: "full" | "partial" | "snippet" | "unavailable";
  access: "retrieved" | "blocked" | "failed" | "unsupported";
  outboundUrls: string[];
  family: PersonSourceFamily;
  /** Which reader produced the text; part of the source's acquisition record. */
  route: string;
  /**
   * The upstream index or publisher this content ultimately came from. Two
   * wrappers over one index share it, so independence can be counted rather
   * than assumed from distinct hostnames.
   */
  upstreamIndex: string | null;
  publishedAt: string | null;
  author: string | null;
  anchors: SourceAnchor[];
  /**
   * Format provenance a claim must not lose: publisher captions versus
   * automatic speech recognition, a caption timestamp versus a named speaker.
   */
  provenanceNote: string | null;
  finalUrl: string;
}

export interface ReaderPorts {
  fetch: PublicHttpFetch;
  fetchBytes: PublicHttpBytesFetch;
  /** Bounded anonymous rendering. Absent means the route is unavailable. */
  render?: BrowserRenderer;
  recorder: ResearchAttemptRecorder;
  timeoutMs: number;
  profileRevision?: number;
}

interface ReadContext extends ReaderPorts {
  attemptOf: string;
  snippet: string;
}

const unavailable = (
  family: PersonSourceFamily,
  route: string,
  access: SourceReadResult["access"],
  snippet: string,
  finalUrl: string,
): SourceReadResult => ({
  text: snippet,
  completeness: snippet ? "snippet" : "unavailable",
  access,
  outboundUrls: [],
  family,
  route,
  upstreamIndex: null,
  publishedAt: null,
  author: null,
  anchors: [],
  provenanceNote: null,
  finalUrl,
});

/* ------------------------------------------------------------------ */
/* Routing                                                              */
/* ------------------------------------------------------------------ */

/** Which family a URL belongs to, decided before any request is made. */
export function classifySourceFamily(url: string): PersonSourceFamily {
  let host: string;
  let path: string;
  try {
    const parsed = new URL(url);
    host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    path = parsed.pathname.toLowerCase();
  } catch {
    return "general-discovery";
  }
  if (/(^|\.)(youtube\.com|youtu\.be|vimeo\.com|peertube|tube\.|sepiasearch\.org)/.test(host))
    return "spoken-evidence";
  if (/podcast|\.rss$|\/feed|anchor\.fm|libsyn|buzzsprout|megaphone\.fm/.test(host + path))
    return "spoken-evidence";
  if (
    /(^|\.)(bsky\.app|bsky\.social|mastodon\.|fosstodon\.org|hachyderm\.io|linkedin\.com|instagram\.com|threads\.net|x\.com|twitter\.com)/.test(
      host,
    )
  )
    return "public-social";
  if (
    /(^|\.)(crossref\.org|datacite\.org|doi\.org|openalex\.org|europepmc\.org|arxiv\.org|ncbi\.nlm\.nih\.gov)/.test(
      host,
    )
  )
    return "published-work";
  if (
    /(^|\.)(clinicaltrials\.gov|npiregistry\.cms\.hhs\.gov|sec\.gov|projects\.propublica\.org|nppes)/.test(
      host,
    )
  )
    return "professional-records";
  if (/(^|\.)(tvmaze\.com|loc\.gov|artic\.edu|imdb\.com|discogs\.com)/.test(host))
    return "creative-records";
  if (/(^|\.)(wikidata\.org|ror\.org|orcid\.org|isni\.org|viaf\.org)/.test(host))
    return "identity-affiliation";
  if (/(^|\.)(web\.archive\.org|archive\.org|commoncrawl\.org)/.test(host))
    return "historical-evidence";
  return "documents-publishers";
}

/**
 * Read one public source anonymously.
 *
 * The reader is chosen from the URL first and from the response second, so a
 * PDF served from a `.aspx` route is still read as a document, and a video
 * page still reaches the caption route rather than being reduced to its HTML
 * description. Every failure records an attempt with an observed code; nothing
 * here converts "we could not read it" into "the person has no evidence".
 */
export async function readPersonSource(
  url: string,
  snippet: string,
  ports: ReaderPorts,
): Promise<SourceReadResult> {
  const context: ReadContext = { ...ports, attemptOf: ports.recorder.correlate(url), snippet };
  const family = classifySourceFamily(url);
  try {
    if (family === "spoken-evidence" && isVideoPage(url)) return await readSpoken(url, context);
    if (family === "public-social") return await readSocial(url, context);
    const record = recordRoute(url);
    if (record) return await readRecord(url, record, family, context);
    return await readWeb(url, family, context);
  } catch (error) {
    const { code, reason } = classifyTransportError(error);
    ports.recorder.record({
      stage: "transport",
      code,
      outcome: "failed",
      recovery: "stopped",
      cause: code === "transport-failed" ? "unknown" : "observed",
      target: url,
      targetKind: "url",
      collector: "html-reader",
      reason,
      attemptOf: context.attemptOf,
      impact: "No source material was retained from this URL.",
      remediation: `Retry the URL directly: curl -sS -D- -o/dev/null '${url}'`,
      ...(ports.profileRevision !== undefined ? { profileRevision: ports.profileRevision } : {}),
    });
    return unavailable(family, "reader", "failed", snippet, url);
  }
}

/* ------------------------------------------------------------------ */
/* Web: HTML, text, feeds, documents                                    */
/* ------------------------------------------------------------------ */

async function readWeb(
  url: string,
  family: PersonSourceFamily,
  context: ReadContext,
): Promise<SourceReadResult> {
  if (looksLikeBinaryDocument(url)) return readDocument(url, family, context);
  const response = await request(url, context, "html-reader");
  if (!response) return unavailable(family, "html-reader", "failed", context.snippet, url);
  if (response.status >= 400) {
    const classified = classifyHttpStatus(response.status, response.body, response.contentType);
    context.recorder.record({
      stage: "access",
      code: classified.code,
      outcome: "failed",
      recovery: context.render ? "alternative-route" : "stopped",
      cause: "observed",
      target: url,
      targetKind: "url",
      collector: "html-reader",
      reason: classified.reason,
      attemptOf: context.attemptOf,
      observed: {
        status: response.status,
        finalUrl: response.url,
        contentType: response.contentType,
        bytes: response.body.length,
        bodyHash: hash(response.body),
        excerpt: response.body.slice(0, 400),
      },
      impact: "This page contributed no text to the dossier.",
      remediation: `Reproduce with: curl -sS -D- -o/dev/null '${url}'`,
      ...(context.render ? {} : { recoveryStopped: "No anonymous rendering route is configured." }),
      ...(context.profileRevision !== undefined
        ? { profileRevision: context.profileRevision }
        : {}),
    });
    const rendered = await tryRender(url, family, context);
    if (rendered) return rendered;
    return unavailable(
      family,
      "html-reader",
      response.status === 403 || response.status === 401 ? "blocked" : "failed",
      context.snippet,
      response.url,
    );
  }
  const type = response.contentType?.toLowerCase() ?? "";
  if (type.includes("pdf")) return readDocument(url, family, context);
  if (isFeed(type, response.body)) return readFeed(url, response, family, context);
  if (type.includes("json")) return renderJson(url, response, family, context, "documents");
  if (type.includes("html") || type.includes("xml") || type === "")
    return readHtml(url, response, family, context);
  if (type.startsWith("text/"))
    return {
      ...unavailable(family, "text-reader", "retrieved", "", response.url),
      text: response.body.slice(0, MAX_TEXT),
      completeness: response.body.length > MAX_TEXT ? "partial" : "full",
      upstreamIndex: hostOf(response.url),
    };
  context.recorder.record({
    stage: "document-parsing",
    code: "unsupported-format",
    outcome: "failed",
    recovery: "stopped",
    cause: "observed",
    target: url,
    targetKind: "document",
    collector: "document-reader",
    reason: `Content type ${type || "(absent)"} has no supported reader.`,
    attemptOf: context.attemptOf,
    observed: { contentType: response.contentType, bytes: response.body.length },
    impact: "The document's text did not reach extraction.",
    remediation: "Add a reader for this media type, or record it as an eligible gap.",
  });
  return unavailable(family, "document-reader", "unsupported", context.snippet, response.url);
}

async function readHtml(
  url: string,
  response: PublicHttpResponse,
  family: PersonSourceFamily,
  context: ReadContext,
): Promise<SourceReadResult> {
  const challenge = detectChallenge(response.body, response.contentType);
  const dom = new JSDOM(response.body, { url: response.url });
  try {
    const document = dom.window.document;
    const outboundUrls = [
      ...new Set(
        [...document.querySelectorAll("a[href]")].flatMap((link) => {
          try {
            const parsed = new URL(link.getAttribute("href")!, response.url);
            return ["https:", "http:"].includes(parsed.protocol) ? [parsed.toString()] : [];
          } catch {
            return [];
          }
        }),
      ),
    ].slice(0, 200);
    const meta = (name: string) =>
      document
        .querySelector(`meta[property="${name}"], meta[name="${name}"], meta[itemprop="${name}"]`)
        ?.getAttribute("content") ?? null;
    const article = new Readability(document).parse();
    const text = article?.textContent?.trim() ?? "";
    if (!text || challenge) {
      context.recorder.record({
        stage: challenge ? "access" : "rendering",
        code: challenge ?? "document-empty",
        outcome: "failed",
        recovery: context.render ? "alternative-route" : "stopped",
        cause: "observed",
        target: url,
        targetKind: "url",
        collector: "html-reader",
        reason: challenge
          ? `A ${challenge === "login-required" ? "sign-in" : "bot-challenge"} page was served instead of the article.`
          : "The page parsed but carried no article text.",
        attemptOf: context.attemptOf,
        observed: {
          status: response.status,
          finalUrl: response.url,
          contentType: response.contentType,
          bytes: response.body.length,
          bodyHash: hash(response.body),
        },
        impact: "No readable text reached extraction from this page.",
        remediation: challenge
          ? "This route is not anonymously readable; record it as a source gap."
          : "Check whether the article is client-rendered and needs the browser route.",
      });
      const rendered = await tryRender(url, family, context);
      if (rendered) return rendered;
      return unavailable(
        family,
        "html-reader",
        challenge ? "blocked" : "failed",
        context.snippet,
        response.url,
      );
    }
    return {
      text: text.slice(0, MAX_TEXT),
      completeness: text.length > MAX_TEXT ? "partial" : "full",
      access: "retrieved",
      outboundUrls,
      family,
      route: "html-reader",
      upstreamIndex: hostOf(response.url),
      publishedAt:
        meta("article:published_time") ?? meta("datePublished") ?? meta("publish_date") ?? null,
      author: meta("article:author") ?? meta("author") ?? null,
      anchors: [],
      provenanceNote: null,
      finalUrl: response.url,
    };
  } finally {
    dom.window.close();
  }
}

async function tryRender(
  url: string,
  family: PersonSourceFamily,
  context: ReadContext,
): Promise<SourceReadResult | null> {
  if (!context.render) return null;
  try {
    const rendered = await context.render(url);
    const dom = new JSDOM(rendered.body, { url: rendered.url });
    try {
      const article = new Readability(dom.window.document).parse();
      const text = article?.textContent?.trim() ?? "";
      if (!text) return null;
      context.recorder.record({
        stage: "rendering",
        code: "retrieval-recovered",
        outcome: "recovered",
        recovery: "recovered",
        cause: "observed",
        target: url,
        targetKind: "url",
        collector: "browser-renderer",
        reason: "The bounded anonymous browser route returned readable text.",
        attemptOf: context.attemptOf,
        observed: { status: rendered.status, finalUrl: rendered.url, bytes: rendered.body.length },
      });
      return {
        text: text.slice(0, MAX_TEXT),
        completeness: text.length > MAX_TEXT ? "partial" : "full",
        access: "retrieved",
        outboundUrls: [],
        family,
        route: "browser-renderer",
        upstreamIndex: hostOf(rendered.url),
        publishedAt: null,
        author: null,
        anchors: [],
        provenanceNote: "Text came from a bounded anonymous render, not the raw response.",
        finalUrl: rendered.url,
      };
    } finally {
      dom.window.close();
    }
  } catch (error) {
    context.recorder.record({
      stage: "rendering",
      code: "rendering-failed",
      outcome: "failed",
      recovery: "stopped",
      cause: "observed",
      target: url,
      targetKind: "url",
      collector: "browser-renderer",
      reason: `The anonymous browser route failed: ${error instanceof Error ? error.message : "unknown error"}.`,
      attemptOf: context.attemptOf,
      recoveryStopped: "No further retrieval route applies to this URL.",
      impact: "A client-rendered page contributed nothing to the dossier.",
      remediation: "Run the URL through the browser route manually to see what it renders.",
    });
    return null;
  }
}

async function readDocument(
  url: string,
  family: PersonSourceFamily,
  context: ReadContext,
): Promise<SourceReadResult> {
  let response;
  try {
    response = await context.fetchBytes(url, { timeoutMs: context.timeoutMs });
  } catch (error) {
    const { code, reason } = classifyTransportError(error);
    context.recorder.record({
      stage: "transport",
      code,
      outcome: "failed",
      recovery: "stopped",
      cause: code === "transport-failed" ? "unknown" : "observed",
      target: url,
      targetKind: "document",
      collector: "document-reader",
      reason,
      attemptOf: context.attemptOf,
      impact: "The document was never retrieved.",
      remediation: `Reproduce with: curl -sSL -o /tmp/source '${url}'`,
    });
    return unavailable(family, "document-reader", "failed", context.snippet, url);
  }
  if (response.status >= 400) {
    const classified = classifyHttpStatus(response.status, "", response.contentType);
    context.recorder.record({
      stage: "access",
      code: classified.code,
      outcome: "failed",
      recovery: "stopped",
      cause: "observed",
      target: url,
      targetKind: "document",
      collector: "document-reader",
      reason: classified.reason,
      attemptOf: context.attemptOf,
      observed: { status: response.status, finalUrl: response.url, bytes: response.bytes.length },
      impact: "The document contributed no text.",
      remediation: `Reproduce with: curl -sSL -D- -o/dev/null '${url}'`,
    });
    return unavailable(family, "document-reader", "blocked", context.snippet, response.url);
  }
  const name = documentFileName(response.url, response.contentType);
  try {
    const text = await convertToText(name, response.bytes);
    return {
      text: text.slice(0, MAX_TEXT),
      completeness: text.length > MAX_TEXT ? "partial" : "full",
      access: "retrieved",
      outboundUrls: [],
      family,
      route: "document-reader",
      upstreamIndex: hostOf(response.url),
      publishedAt: null,
      author: null,
      anchors: pageAnchors(text),
      provenanceNote: `Text extracted from a ${name.split(".").pop() ?? "document"} document.`,
      finalUrl: response.url,
    };
  } catch (error) {
    context.recorder.record({
      stage: "document-parsing",
      code: "parser-failed",
      outcome: "failed",
      recovery: "stopped",
      cause: "observed",
      target: url,
      targetKind: "document",
      collector: "document-reader",
      reason: `The document parser rejected the file: ${error instanceof Error ? error.message : "unknown error"}.`,
      attemptOf: context.attemptOf,
      observed: {
        contentType: response.contentType,
        bytes: response.bytes.length,
        bodyHash: hash(response.bytes),
        parserLocation: name,
      },
      impact: "A retrieved document contributed no text to the dossier.",
      remediation:
        "Save the bytes and run the converter locally; a scanned page needs OCR rather than a text layer.",
      hypothesis:
        "A PDF with no text layer is the usual cause, but this run did not establish that.",
    });
    return unavailable(family, "document-reader", "unsupported", context.snippet, response.url);
  }
}

async function readFeed(
  url: string,
  response: PublicHttpResponse,
  family: PersonSourceFamily,
  context: ReadContext,
): Promise<SourceReadResult> {
  const dom = new JSDOM(response.body, { contentType: "text/xml" });
  try {
    const document = dom.window.document;
    const items = [...document.querySelectorAll("item, entry")].slice(0, 40);
    const lines: string[] = [];
    const outboundUrls: string[] = [];
    const title = document.querySelector("channel > title, feed > title")?.textContent.trim();
    if (title) lines.push(`Feed: ${title}`);
    for (const item of items) {
      const itemTitle = item.querySelector("title")?.textContent.trim() ?? "";
      const date =
        item.querySelector("pubDate, published, updated")?.textContent.trim() ?? "unknown date";
      const description =
        item.querySelector("description, summary, content")?.textContent.trim() ?? "";
      const link =
        item.querySelector("link")?.getAttribute("href") ??
        item.querySelector("link")?.textContent.trim() ??
        "";
      if (link) outboundUrls.push(link);
      /* Podcast namespaces publish a transcript URL beside the episode; it is
         the difference between a show note and the spoken evidence itself. */
      for (const transcript of item.querySelectorAll("[url]")) {
        const href = transcript.getAttribute("url");
        if (href && /transcript/i.test(transcript.nodeName)) outboundUrls.push(href);
      }
      lines.push(`${date} — ${itemTitle}\n${description}`.trim());
    }
    if (lines.length <= 1) {
      context.recorder.record({
        stage: "document-parsing",
        code: "document-empty",
        outcome: "failed",
        recovery: "stopped",
        cause: "observed",
        target: url,
        targetKind: "document",
        collector: "feed-reader",
        reason: "The feed parsed but carried no entries.",
        attemptOf: context.attemptOf,
        observed: { contentType: response.contentType, bytes: response.body.length },
        impact: "No episode or post text reached extraction.",
        remediation: "Check the feed URL directly; it may be a redirect stub.",
      });
      return unavailable(family, "feed-reader", "failed", context.snippet, response.url);
    }
    const text = lines.join("\n\n");
    return {
      text: text.slice(0, MAX_TEXT),
      completeness: text.length > MAX_TEXT ? "partial" : "full",
      access: "retrieved",
      outboundUrls: [...new Set(outboundUrls)].slice(0, 200),
      family,
      route: "feed-reader",
      upstreamIndex: hostOf(response.url),
      publishedAt: null,
      author: null,
      anchors: [],
      provenanceNote: "Feed entry text is publisher-written description, not a transcript.",
      finalUrl: response.url,
    };
  } finally {
    dom.window.close();
  }
}

/* ------------------------------------------------------------------ */
/* Spoken evidence                                                      */
/* ------------------------------------------------------------------ */

function isVideoPage(url: string): boolean {
  return /youtube\.com\/watch|youtu\.be\/|\/videos\/watch\//.test(url);
}

function youtubeVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith("youtu.be")) return parsed.pathname.slice(1) || null;
    return parsed.searchParams.get("v");
  } catch {
    return null;
  }
}

/**
 * Public captions, read anonymously.
 *
 * The watch page carries the caption track list in its own player response, so
 * the track and then the timed text are two ordinary anonymous GETs — no key,
 * no sign-in, no player emulation. When a video simply has no track, that is
 * `captions-missing`, which is a fact about the video and not a failure of the
 * pipeline; the record says so.
 */
async function readSpoken(url: string, context: ReadContext): Promise<SourceReadResult> {
  const videoId = youtubeVideoId(url);
  if (!videoId) return readWeb(url, "spoken-evidence", context);
  const page = await request(url, context, "caption-reader");
  if (!page || page.status >= 400) {
    if (page)
      context.recorder.record({
        stage: "caption-acquisition",
        code: classifyHttpStatus(page.status, page.body, page.contentType).code,
        outcome: "failed",
        recovery: "stopped",
        cause: "observed",
        target: url,
        targetKind: "media",
        collector: "caption-reader",
        reason: `HTTP ${page.status} for the video page; the caption track list was never seen.`,
        attemptOf: context.attemptOf,
        observed: { status: page.status, finalUrl: page.url },
        impact: "Spoken evidence from this video is missing from the dossier.",
        remediation: `Reproduce with: curl -sS '${url}' | grep -o 'captionTracks'`,
      });
    return unavailable("spoken-evidence", "caption-reader", "failed", context.snippet, url);
  }
  const tracks = parseCaptionTracks(page.body);
  if (!tracks.length) {
    context.recorder.record({
      stage: "caption-acquisition",
      code: "captions-missing",
      outcome: "failed",
      recovery: "stopped",
      cause: "observed",
      target: url,
      targetKind: "media",
      collector: "caption-reader",
      reason: "The video page lists no caption tracks.",
      attemptOf: context.attemptOf,
      observed: { status: page.status, finalUrl: page.url, bytes: page.body.length },
      impact: "This video contributed no spoken evidence.",
      remediation:
        "Local transcription would be the next route; it is not wired into person research.",
      recoveryStopped: "No local transcription runtime is available to person research.",
    });
    return readVideoDescription(url, page, context);
  }
  /* Publisher captions before automatic speech recognition: an ASR track is
     usable evidence but a different kind of it, and the note travels with the
     text so a claim cannot silently upgrade a machine guess to a quotation. */
  const track = tracks.find((entry) => !entry.asr) ?? tracks[0]!;
  const captions = await request(track.baseUrl, context, "caption-reader");
  const emptyBody = !!captions && captions.status < 400 && captions.body.trim() === "";
  if (!captions || captions.status >= 400 || emptyBody) {
    context.recorder.record({
      stage: "caption-acquisition",
      /* An empty 200 is not an HTTP error and not a missing track: the video
         has captions and the anonymous route would not hand them over. The
         record says exactly that and keeps the guess separate. */
      code: emptyBody ? "captions-missing" : captions ? "http-error" : "transport-failed",
      outcome: "failed",
      recovery: "stopped",
      cause: captions ? "observed" : "unknown",
      target: track.baseUrl,
      targetKind: "media",
      collector: "caption-reader",
      reason: emptyBody
        ? "The video lists a caption track, and the anonymous timed-text route returned HTTP 200 with an empty body."
        : captions
          ? `HTTP ${captions.status} fetching the caption track.`
          : "The caption track request did not complete.",
      attemptOf: context.attemptOf,
      ...(captions
        ? {
            observed: {
              status: captions.status,
              finalUrl: captions.url,
              bytes: captions.body.length,
            },
          }
        : {}),
      impact: "A listed caption track did not become text; the description was used instead.",
      remediation: emptyBody
        ? "Install a local transcription runtime, or keep this as a recorded spoken-evidence gap."
        : "Fetch the track URL directly to see what the source returns.",
      ...(emptyBody
        ? {
            hypothesis:
              "The platform appears to require a proof-of-origin token for timed text; this run did not establish that.",
            recoveryStopped:
              "No keyless caption route remains, and no local transcription runtime is available to person research.",
          }
        : {}),
    });
    return readVideoDescription(url, page, context);
  }
  const { text, anchors } = parseTimedText(captions.body);
  if (!text.trim()) return readVideoDescription(url, page, context);
  return {
    text: text.slice(0, MAX_TEXT),
    completeness: text.length > MAX_TEXT ? "partial" : "full",
    access: "retrieved",
    outboundUrls: [],
    family: "spoken-evidence",
    route: "caption-reader",
    upstreamIndex: "youtube.com",
    publishedAt: null,
    author: null,
    anchors,
    provenanceNote: track.asr
      ? "Automatic speech recognition captions. Timestamps locate speech; they do not identify the speaker."
      : "Publisher-provided captions. Timestamps locate speech; they do not identify the speaker.",
    finalUrl: page.url,
  };
}

async function readVideoDescription(
  url: string,
  page: PublicHttpResponse,
  context: ReadContext,
): Promise<SourceReadResult> {
  const description = /"shortDescription":"((?:[^"\\]|\\.)*)"/.exec(page.body)?.[1];
  const title = /"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/.exec(page.body)?.[1];
  const text = [title, description]
    .filter(Boolean)
    .map((value) => unescapeJson(value!))
    .join("\n\n")
    .trim();
  if (!text)
    return unavailable("spoken-evidence", "caption-reader", "failed", context.snippet, url);
  return {
    text: text.slice(0, MAX_TEXT),
    completeness: "partial",
    access: "retrieved",
    outboundUrls: [],
    family: "spoken-evidence",
    route: "caption-reader",
    upstreamIndex: "youtube.com",
    publishedAt: null,
    author: null,
    anchors: [],
    provenanceNote:
      "Publisher-written video description only; no caption track was available for this video.",
    finalUrl: page.url,
  };
}

function parseCaptionTracks(body: string): { baseUrl: string; asr: boolean }[] {
  const section = /"captionTracks":(\[.*?\])/s.exec(body)?.[1];
  if (!section) return [];
  const tracks: { baseUrl: string; asr: boolean }[] = [];
  for (const match of section.matchAll(/"baseUrl":"((?:[^"\\]|\\.)*)"/g)) {
    const raw = unescapeJson(match[1]!);
    const before = section.slice(0, match.index);
    const kind = /"kind":"asr"/.test(section.slice(match.index, match.index + 400));
    tracks.push({ baseUrl: raw, asr: kind || /"kind":"asr"/.test(before.slice(-400)) });
  }
  return tracks;
}

function parseTimedText(body: string): { text: string; anchors: SourceAnchor[] } {
  const anchors: SourceAnchor[] = [];
  const parts: string[] = [];
  let offset = 0;
  for (const match of body.matchAll(/<text[^>]*start="([\d.]+)"[^>]*>(.*?)<\/text>/gs)) {
    const seconds = Number(match[1]);
    const line = decodeXml(match[2] ?? "").trim();
    if (!line) continue;
    if (parts.length % 12 === 0) anchors.push({ kind: "timestamp", value: clock(seconds), offset });
    parts.push(line);
    offset += line.length + 1;
  }
  return { text: parts.join(" "), anchors };
}

function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours ? `${pad(hours)}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
}

/* ------------------------------------------------------------------ */
/* Public social evidence                                              */
/* ------------------------------------------------------------------ */

/**
 * Anonymous reads of public social evidence.
 *
 * Bluesky and Mastodon both publish public timelines over unauthenticated
 * endpoints, so they are read directly. LinkedIn, Instagram, X and Threads do
 * not: the anonymous route is an authentication wall, and this records that as
 * an observed `login-required` gap rather than pretending the person has no
 * public presence there. No session is imported and no wall is bypassed.
 */
async function readSocial(url: string, context: ReadContext): Promise<SourceReadResult> {
  const host = hostOf(url) ?? "";
  if (/bsky\.app|bsky\.social/.test(host)) return readBluesky(url, context);
  if (/x\.com|twitter\.com|linkedin\.com|instagram\.com|threads\.net/.test(host)) {
    const response = await request(url, context, "social-reader");
    const challenge = response ? detectChallenge(response.body, response.contentType) : null;
    /* A public post page that actually renders anonymously is still worth
       reading; only a wall is recorded as a wall. */
    if (response && response.status < 400 && !challenge)
      return readHtml(url, response, "public-social", context);
    context.recorder.record({
      stage: "access",
      code:
        challenge ??
        (response
          ? classifyHttpStatus(response.status, response.body, response.contentType).code
          : "transport-failed"),
      outcome: "failed",
      recovery: "stopped",
      cause: response ? "observed" : "unknown",
      target: url,
      targetKind: "url",
      collector: "social-reader",
      reason: challenge
        ? `${host} served a ${challenge === "login-required" ? "sign-in" : "challenge"} page to an anonymous reader.`
        : `${host} did not return a readable anonymous response.`,
      attemptOf: context.attemptOf,
      ...(response
        ? {
            observed: {
              status: response.status,
              finalUrl: response.url,
              contentType: response.contentType,
              bytes: response.body.length,
            },
          }
        : {}),
      impact: `Public posts on ${host} did not contribute evidence.`,
      remediation:
        "No keyless anonymous route exists for this network; keep it as a recorded source gap.",
      recoveryStopped:
        "Signing in, importing a session or using a paid proxy is out of scope for data acquisition.",
    });
    return unavailable("public-social", "social-reader", "blocked", context.snippet, url);
  }
  return readMastodon(url, context);
}

async function readBluesky(url: string, context: ReadContext): Promise<SourceReadResult> {
  const handle = /\/profile\/([^/?#]+)/.exec(url)?.[1];
  if (!handle) return readWeb(url, "public-social", context);
  const feedUrl = `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(handle)}&limit=40`;
  const response = await request(feedUrl, context, "social-reader");
  if (!response || response.status >= 400) {
    context.recorder.record({
      stage: "access",
      code: response
        ? classifyHttpStatus(response.status, response.body, response.contentType).code
        : "transport-failed",
      outcome: "failed",
      recovery: "stopped",
      cause: response ? "observed" : "unknown",
      target: feedUrl,
      targetKind: "record",
      collector: "social-reader",
      reason: response
        ? `HTTP ${response.status} from the public Bluesky endpoint.`
        : "The public Bluesky endpoint did not answer.",
      attemptOf: context.attemptOf,
      ...(response ? { observed: { status: response.status, finalUrl: response.url } } : {}),
      impact: "Public posts by this account did not contribute evidence.",
      remediation: `Reproduce with: curl -sS '${feedUrl}'`,
    });
    return unavailable("public-social", "social-reader", "failed", context.snippet, url);
  }
  const parsed = safeJson(response.body) as {
    feed?: {
      reason?: { $type?: string };
      post?: {
        uri?: string;
        author?: { handle?: string; did?: string };
        record?: { text?: string; createdAt?: string };
      };
    }[];
  } | null;
  const lines = (parsed?.feed ?? [])
    .map((entry) =>
      entry.post?.record?.text
        ? `${entry.post.record.createdAt ?? "unknown date"} — author: ${entry.post.author?.handle ?? entry.post.author?.did ?? "unknown (do not attribute to feed owner)"}; post: ${entry.post.uri ?? "unknown"}; ${entry.reason?.$type?.endsWith("#reasonRepost") ? "repost" : "feed entry"} — ${entry.post.record.text}`
        : "",
    )
    .filter(Boolean);
  if (!lines.length)
    return unavailable("public-social", "social-reader", "retrieved", context.snippet, url);
  const text = `Public Bluesky feed for ${handle}; entries retain their own authors\n\n${lines.join("\n\n")}`;
  return {
    text: text.slice(0, MAX_TEXT),
    completeness: "partial",
    access: "retrieved",
    outboundUrls: [],
    family: "public-social",
    route: "bluesky",
    upstreamIndex: "bsky.app",
    publishedAt: null,
    author: null,
    anchors: [],
    provenanceNote:
      "The account's own posts. Self-report: a post is not independent verification of itself.",
    finalUrl: url,
  };
}

async function readMastodon(url: string, context: ReadContext): Promise<SourceReadResult> {
  const match = /^https?:\/\/([^/]+)\/@([^/?#]+)\/?$/.exec(url);
  if (!match) return readWeb(url, "public-social", context);
  const [, instance, handle] = match as unknown as [string, string, string];
  const lookup = `https://${instance}/api/v1/accounts/lookup?acct=${encodeURIComponent(handle)}`;
  const account = await request(lookup, context, "social-reader");
  if (!account || account.status >= 400) {
    context.recorder.record({
      stage: "access",
      code: account
        ? classifyHttpStatus(account.status, account.body, account.contentType).code
        : "transport-failed",
      outcome: "failed",
      recovery: "alternative-route",
      cause: account ? "observed" : "unknown",
      target: lookup,
      targetKind: "record",
      collector: "social-reader",
      reason: account
        ? `HTTP ${account.status} from this instance's public account lookup.`
        : "The instance's public account lookup did not answer.",
      attemptOf: context.attemptOf,
      impact: "Falling back to the public profile page for this account.",
      remediation: `Reproduce with: curl -sS '${lookup}'`,
    });
    return readWeb(url, "public-social", context);
  }
  const id = (safeJson(account.body) as { id?: string } | null)?.id;
  if (!id) return readWeb(url, "public-social", context);
  const statuses = await request(
    `https://${instance}/api/v1/accounts/${encodeURIComponent(id)}/statuses?limit=40&exclude_replies=true`,
    context,
    "social-reader",
  );
  const posts =
    (safeJson(statuses?.body ?? "null") as { created_at?: string; content?: string }[] | null) ??
    [];
  const lines = posts
    .map((post) => `${post.created_at ?? "unknown date"} — ${stripTags(post.content ?? "")}`)
    .filter((line) => line.length > 20);
  if (!lines.length) return readWeb(url, "public-social", context);
  const text = `Public Mastodon posts by @${handle}@${instance}\n\n${lines.join("\n\n")}`;
  return {
    text: text.slice(0, MAX_TEXT),
    completeness: "partial",
    access: "retrieved",
    outboundUrls: [],
    family: "public-social",
    route: "mastodon",
    upstreamIndex: instance,
    publishedAt: null,
    author: `@${handle}@${instance}`,
    anchors: [],
    provenanceNote:
      "The account's own posts. Self-report: a post is not independent verification of itself.",
    finalUrl: url,
  };
}

/* ------------------------------------------------------------------ */
/* Structured records                                                   */
/* ------------------------------------------------------------------ */

/**
 * Public record routes read as data rather than as pages.
 *
 * Each entry is one anonymous, keyless endpoint verified against its own
 * current documentation. A URL that matches gets its JSON rendered into
 * readable, quotable lines so a claim can cite a record the same way it cites
 * an article.
 */
const RECORD_ROUTES: { match: RegExp; build: (url: URL) => string | null; index: string }[] = [
  {
    match: /(^|\.)wikidata\.org$/,
    index: "wikidata.org",
    build: (url) => {
      const id = /(Q\d+)/.exec(url.pathname)?.[1];
      return id ? `https://www.wikidata.org/wiki/Special:EntityData/${id}.json` : null;
    },
  },
  {
    match: /(^|\.)doi\.org$/,
    index: "crossref.org",
    build: (url) => `https://api.crossref.org/works/${encodeURIComponent(url.pathname.slice(1))}`,
  },
  {
    match: /(^|\.)crossref\.org$/,
    index: "crossref.org",
    build: (url) => url.toString(),
  },
  {
    match: /(^|\.)datacite\.org$/,
    index: "datacite.org",
    build: (url) => url.toString(),
  },
  {
    match: /(^|\.)openalex\.org$/,
    index: "openalex.org",
    build: (url) =>
      url.hostname.startsWith("api.") ? url.toString() : `https://api.openalex.org${url.pathname}`,
  },
  {
    match: /(^|\.)orcid\.org$/,
    index: "orcid.org",
    build: (url) => {
      const id = /(\d{4}-\d{4}-\d{4}-[\dX]{4})/.exec(url.pathname)?.[1];
      return id ? `https://pub.orcid.org/v3.0/${id}/record` : null;
    },
  },
  {
    match: /(^|\.)ror\.org$/,
    index: "ror.org",
    build: (url) => {
      const id = /([0-9a-z]{9})/.exec(url.pathname)?.[1];
      return id ? `https://api.ror.org/organizations/${id}` : null;
    },
  },
  {
    match: /(^|\.)clinicaltrials\.gov$/,
    index: "clinicaltrials.gov",
    build: (url) => {
      const id = /(NCT\d{8})/.exec(url.pathname + url.search)?.[1];
      return id ? `https://clinicaltrials.gov/api/v2/studies/${id}` : null;
    },
  },
  {
    match: /(^|\.)npiregistry\.cms\.hhs\.gov$/,
    index: "npiregistry.cms.hhs.gov",
    build: (url) => {
      const npi = url.searchParams.get("number") ?? /(\d{10})/.exec(url.pathname)?.[1];
      return npi
        ? `https://npiregistry.cms.hhs.gov/api/?version=2.1&number=${encodeURIComponent(npi)}`
        : null;
    },
  },
  {
    match: /(^|\.)tvmaze\.com$/,
    index: "tvmaze.com",
    build: (url) =>
      url.hostname.startsWith("api.") ? url.toString() : `https://api.tvmaze.com${url.pathname}`,
  },
  {
    match: /(^|\.)artic\.edu$/,
    index: "artic.edu",
    build: (url) =>
      url.hostname.startsWith("api.")
        ? url.toString()
        : `https://api.artic.edu/api/v1${url.pathname.replace(/^\/artworks/, "/artworks")}`,
  },
  {
    match: /(^|\.)loc\.gov$/,
    index: "loc.gov",
    build: (url) => {
      const next = new URL(url.toString());
      next.searchParams.set("fo", "json");
      return next.toString();
    },
  },
];

function recordRoute(url: string): { endpoint: string; index: string } | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    for (const route of RECORD_ROUTES)
      if (route.match.test(host)) {
        const endpoint = route.build(parsed);
        if (endpoint) return { endpoint, index: route.index };
      }
    return null;
  } catch {
    return null;
  }
}

async function readRecord(
  url: string,
  route: { endpoint: string; index: string },
  family: PersonSourceFamily,
  context: ReadContext,
): Promise<SourceReadResult> {
  /* Record endpoints answer data, not pages: several of them serve XML or a
     406 to the shared transport's HTML-first accept list. */
  const response = await request(route.endpoint, context, "record-reader", "application/json");
  if (!response || response.status >= 400) {
    context.recorder.record({
      stage: "access",
      code: response
        ? classifyHttpStatus(response.status, response.body, response.contentType).code
        : "transport-failed",
      outcome: "failed",
      recovery: "alternative-route",
      cause: response ? "observed" : "unknown",
      target: route.endpoint,
      targetKind: "record",
      collector: "record-reader",
      reason: response
        ? `HTTP ${response.status} from the ${route.index} public record endpoint.`
        : `The ${route.index} public record endpoint did not answer.`,
      attemptOf: context.attemptOf,
      ...(response ? { observed: { status: response.status, finalUrl: response.url } } : {}),
      impact: "Falling back to reading the record's human-facing page.",
      remediation: `Reproduce with: curl -sS '${route.endpoint}'`,
    });
    return readWeb(url, family, context);
  }
  return renderJson(url, response, family, context, route.index);
}

function renderJson(
  url: string,
  response: PublicHttpResponse,
  family: PersonSourceFamily,
  context: ReadContext,
  index: string,
): SourceReadResult {
  const parsed = safeJson(response.body);
  if (parsed === null) {
    context.recorder.record({
      stage: "document-parsing",
      code: "parser-failed",
      outcome: "failed",
      recovery: "stopped",
      cause: "observed",
      target: url,
      targetKind: "record",
      collector: "record-reader",
      reason: "The record endpoint answered with a body that is not JSON.",
      attemptOf: context.attemptOf,
      observed: {
        contentType: response.contentType,
        bytes: response.body.length,
        excerpt: response.body.slice(0, 400),
      },
      impact: "The record contributed no text.",
      remediation: "Inspect the endpoint's response shape; it may have changed.",
    });
    return unavailable(family, "record-reader", "failed", context.snippet, response.url);
  }
  const text = flattenJson(parsed);
  return {
    text: text.slice(0, MAX_TEXT),
    completeness: text.length > MAX_TEXT ? "partial" : "full",
    access: "retrieved",
    outboundUrls: [...new Set(collectUrls(parsed))].slice(0, 200),
    family,
    route: "record-reader",
    upstreamIndex: index,
    publishedAt: null,
    author: null,
    anchors: [],
    provenanceNote: `Structured public record from ${index}, rendered as field lines.`,
    finalUrl: response.url,
  };
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * One anonymous request with its own retry.
 *
 * Retries happen here, per request, rather than in the operation loop: waiting
 * out a `Retry-After` inside a serial reading loop stalls every other source
 * for that person, which is exactly what the parallel batches above exist to
 * avoid. The caller reads one settled response.
 */
async function request(
  url: string,
  context: ReadContext,
  collector: CollectorName,
  accept?: string,
): Promise<PublicHttpResponse | null> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const startedAt = Date.now();
    try {
      const response = await context.fetch(url, {
        timeoutMs: context.timeoutMs,
        ...(accept ? { accept } : {}),
      });
      if (response.status < 400) {
        if (attempt > 1)
          context.recorder.record({
            stage: "transport",
            code: "retrieval-recovered",
            outcome: "recovered",
            recovery: "recovered",
            cause: "observed",
            target: url,
            targetKind: "url",
            collector,
            reason: "Retrieval succeeded after a temporary failure.",
            attemptOf: context.attemptOf,
            attempt,
            observed: {
              status: response.status,
              finalUrl: response.url,
              elapsedMilliseconds: Date.now() - startedAt,
            },
          });
        return response;
      }
      const temporary = response.status === 429 || [500, 502, 503, 504].includes(response.status);
      if (!temporary || attempt === 3) return response;
      const delay = Math.min(
        60_000,
        retryDelay(response.retryAfter) ?? Math.min(8_000, 500 * 2 ** attempt),
      );
      context.recorder.record({
        stage: "transport",
        code: response.status === 429 ? "rate-limited" : "http-error",
        outcome: "failed",
        recovery: "retry",
        cause: "observed",
        target: url,
        targetKind: "url",
        collector,
        reason: `HTTP ${response.status}; waiting ${delay} ms before retrying.`,
        attemptOf: context.attemptOf,
        attempt,
        observed: {
          status: response.status,
          finalUrl: response.url,
          contentType: response.contentType,
          bytes: response.body.length,
          bodyHash: hash(response.body),
          retryAfterMilliseconds: delay,
          elapsedMilliseconds: Date.now() - startedAt,
        },
      });
      await sleep(delay);
    } catch (error) {
      lastError = error;
      const { code, reason } = classifyTransportError(error);
      const retrying = attempt < 3;
      context.recorder.record({
        stage: "transport",
        code,
        outcome: "failed",
        recovery: retrying ? "retry" : "stopped",
        cause: code === "transport-failed" ? "unknown" : "observed",
        target: url,
        targetKind: "url",
        collector,
        reason: `${reason}${retrying ? " Retrying." : ""}`,
        attemptOf: context.attemptOf,
        attempt,
        observed: { elapsedMilliseconds: Date.now() - startedAt },
        ...(retrying ? {} : { recoveryStopped: "The retry budget for this request is spent." }),
      });
      if (!retrying) return null;
      await sleep(Math.min(4_000, 500 * 2 ** attempt));
    }
  }
  return lastError ? null : null;
}

function retryDelay(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function looksLikeBinaryDocument(url: string): boolean {
  return /\.(pdf|docx)(\?|#|$)/i.test(url);
}

function documentFileName(url: string, contentType: string | null): string {
  if (/\.pdf(\?|#|$)/i.test(url) || contentType?.includes("pdf")) return "source.pdf";
  if (/\.docx(\?|#|$)/i.test(url) || contentType?.includes("wordprocessingml"))
    return "source.docx";
  return "source.txt";
}

function isFeed(contentType: string, body: string): boolean {
  if (/(rss|atom)\+xml/.test(contentType)) return true;
  return /^\s*<\?xml/.test(body) && /<(rss|feed)[\s>]/i.test(body.slice(0, 4000));
}

function pageAnchors(text: string): SourceAnchor[] {
  const anchors: SourceAnchor[] = [];
  for (const match of text.matchAll(/\n\[page (\d+)\]\n/g))
    anchors.push({ kind: "page", value: match[1]!, offset: match.index });
  return anchors.slice(0, 500);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

function stripTags(html: string): string {
  return decodeXml(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

function unescapeJson(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
}

/** Render a record into quotable lines. Bounded in depth, breadth and size. */
function flattenJson(value: unknown, prefix = "", depth = 0): string {
  if (depth > 6) return "";
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") {
    const text =
      typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? String(value).trim()
        : "";
    return text && text.length < 4000 ? `${prefix}: ${text}\n` : "";
  }
  if (Array.isArray(value))
    return value
      .slice(0, 40)
      .map((entry, index) => flattenJson(entry, `${prefix}[${index}]`, depth + 1))
      .join("");
  return Object.entries(value as Record<string, unknown>)
    .slice(0, 80)
    .map(([key, entry]) => flattenJson(entry, prefix ? `${prefix}.${key}` : key, depth + 1))
    .join("");
}

function collectUrls(value: unknown, depth = 0): string[] {
  if (depth > 6 || value === null || typeof value !== "object") {
    return typeof value === "string" && /^https?:\/\//.test(value) ? [value] : [];
  }
  const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return entries.slice(0, 80).flatMap((entry) => collectUrls(entry, depth + 1));
}
