import { createHash } from "node:crypto";
import { fromPartial } from "@total-typescript/shoehorn";
import { expect, test, vi } from "vitest";
import { JSDOM } from "jsdom";
import type * as jsdomModule from "jsdom";
import { ResearchAttemptRecorder } from "../../../apps/server/src/person-profile/research-diagnostics.js";
import {
  readPersonSource,
  type ReaderPorts,
} from "../../../apps/server/src/person-profile/research-readers.js";

/**
 * HTML parse gating (person-research speed levers).
 *
 * The gate runs Readability's own `isProbablyReaderable` over a cheerio
 * document so gate-negative pages skip JSDOM construction, anchor harvest,
 * and Readability entirely (the shim's agreement with a real-DOM gate was
 * verified fixture by fixture during development; every skipped page records
 * its body hash so the A/B arm can replay and measure the false-negative
 * rate). The gate runs with zeroed thresholds so it can only skip pages
 * with no text-bearing p, pre, or article at all.
 */
vi.mock("jsdom", async (importOriginal) => {
  const actual = await importOriginal<typeof jsdomModule>();
  class CountingJSDOM extends actual.JSDOM {
    static constructions = 0;
    static querySelectorAllCalls = 0;
    constructor(...args: ConstructorParameters<typeof actual.JSDOM>) {
      super(...args);
      CountingJSDOM.constructions += 1;
      const document = this.window.document;
      const original = document.querySelectorAll.bind(document);
      document.querySelectorAll = (...rest: Parameters<typeof original>) => {
        CountingJSDOM.querySelectorAllCalls += 1;
        return original(...rest);
      };
    }
    static reset() {
      CountingJSDOM.constructions = 0;
      CountingJSDOM.querySelectorAllCalls = 0;
    }
  }
  return { ...actual, JSDOM: CountingJSDOM };
});

const jsdomCounters = () =>
  JSDOM as unknown as { constructions: number; querySelectorAllCalls: number; reset(): void };

const ports = (recorder: ResearchAttemptRecorder, fetch: ReaderPorts["fetch"]): ReaderPorts =>
  fromPartial({ fetch, recorder, timeoutMs: 1000 });

const paragraph =
  "Dr. Amara Okafor has spent two decades studying tropical disease transmission across West Africa, " +
  "publishing field studies that reshaped how public health agencies model seasonal outbreaks in the region. ";

/* No paragraphs, no article, no text: Readability finds nothing here. */
const photoHtml =
  `<html><head><title>Photo gallery</title></head><body>` +
  `<div class="gallery"><img src="https://example.com/x.jpg" alt="x">` +
  `<form action="/search"><input name="q" type="text"></form></div></body></html>`;

const articleHtml =
  `<!doctype html><html><head><title>Okafor's field studies reshape outbreak modelling</title>` +
  `<meta property="article:published_time" content="2024-03-01"></head>` +
  `<body><nav><a href="https://example.com/nav">Nav</a></nav><article><h1>Okafor's field studies</h1>` +
  `<p>${paragraph.repeat(6)}</p><p>${paragraph.repeat(5)} <a href="https://example.com/study">the study</a>.</p>` +
  `<p>${paragraph.repeat(5)}</p><p>${paragraph.repeat(5)}</p>` +
  `</article><footer><a href="https://example.com/footer">Footer</a></footer></body></html>`;

/* Enough article text to pass the gate, wrapped in a bot challenge. */
const challengeHtml = articleHtml.replace(
  "<article>",
  `<article><p>Just a moment: checking your browser before you can continue reading this story. ` +
    `Please enable JavaScript and cookies to continue. ${paragraph.repeat(4)}</p>`,
);

test("a gate-negative page skips JSDOM construction and anchor harvest and keeps the document-empty classification", async () => {
  jsdomCounters().reset();
  const recorder = new ResearchAttemptRecorder("operation-parse-gate-negative");
  const result = await readPersonSource(
    "https://example.com/photo",
    "",
    ports(recorder, async (url) => ({
      url,
      status: 200,
      contentType: "text/html",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body: photoHtml,
    })),
  );

  /* No document, so neither the harvest nor Readability could have run. */
  expect(jsdomCounters().constructions).toBe(0);
  expect(jsdomCounters().querySelectorAllCalls).toBe(0);
  expect(result).toMatchObject({
    text: "",
    access: "failed",
    completeness: "unavailable",
    route: "html-reader",
    outboundUrls: [],
    anchors: [],
    upstreamIndex: null,
    finalUrl: "https://example.com/photo",
  });
  const attempts = recorder.all();
  expect(attempts).toHaveLength(1);
  expect(attempts[0]).toMatchObject({
    code: "document-empty",
    outcome: "failed",
    collector: "html-reader",
  });
  expect(attempts[0].reason).toContain("readable=false");
  expect(attempts[0].reason).toContain(`${photoHtml.length} bytes`);
  expect(attempts[0].reason).toMatch(/parseMs=\d+/);
});

test("a gate-positive article extracts byte-identical text and citations", async () => {
  jsdomCounters().reset();
  const recorder = new ResearchAttemptRecorder("operation-parse-gate-positive");
  const result = await readPersonSource(
    "https://example.com/article",
    "",
    ports(recorder, async (url) => ({
      url,
      status: 200,
      contentType: "text/html",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body: articleHtml,
    })),
  );

  /* The gate-positive path still parses: the text hash below is the pre-lever
     oracle (captured from the unmodified reader), so any gate or reorder
     change to extraction bytes fails here. */
  expect(jsdomCounters().constructions).toBeGreaterThan(0);
  expect(createHash("sha256").update(result.text).digest("hex")).toBe(
    "8f7cd3d63b3f19784b70b51dd8b10abb727eaf2481d92c1cb1f2b5b229b3b209",
  );
  expect(result.text).toHaveLength(4294);
  expect(result).toMatchObject({
    access: "retrieved",
    completeness: "full",
    route: "html-reader",
    anchors: [],
    author: null,
    publishedAt: "2024-03-01",
    upstreamIndex: "example.com",
  });
  /* Harvest runs before Readability.parse() on the pristine document, so the
     outbound URLs are exactly the pre-lever oracle — including the in-article
     link parse() would detach. */
  expect(result.outboundUrls).toEqual([
    "https://example.com/nav",
    "https://example.com/study",
    "https://example.com/footer",
  ]);
  expect(recorder.all()).toHaveLength(0);
});

test("a gate-positive challenge page records the DOM-parse timing probe", async () => {
  jsdomCounters().reset();
  const recorder = new ResearchAttemptRecorder("operation-parse-probe");
  const result = await readPersonSource(
    "https://example.com/challenge",
    "",
    ports(recorder, async (url) => ({
      url,
      status: 200,
      contentType: "text/html",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body: challengeHtml,
    })),
  );

  expect(jsdomCounters().constructions).toBeGreaterThan(0);
  expect(result.access).toBe("blocked");
  const attempts = recorder.all();
  expect(attempts).toHaveLength(1);
  expect(attempts[0]).toMatchObject({ code: "challenge-page", outcome: "failed" });
  expect(attempts[0].reason).toContain("readable=true");
  expect(attempts[0].reason).toMatch(/parseMs=\d+ DOM parse/);
});
