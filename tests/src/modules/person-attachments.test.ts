import { fromPartial } from "@total-typescript/shoehorn";
import { expect, test } from "vitest";
import { ResearchAttemptRecorder } from "../../../apps/server/src/person-profile/research-diagnostics.js";
import {
  readPersonSource,
  type ReaderPorts,
} from "../../../apps/server/src/person-profile/research-readers.js";

/**
 * Attachment candidates at the HTML reader seam (issue #248).
 *
 * The seam contract: a read page reports the documents it links, in the order
 * it presents them, with a label a lead can carry — bounded, deduplicated,
 * and never the page itself. Whether a candidate is followed is the
 * operation's decision; the reader only reports what the page offered.
 */

const paragraph =
  "Maya Chen leads the ocean sensor programme at Ocean Lab, publishing field methods that coastal stations reuse. ";

function page(links: string): string {
  return (
    "<html><head><title>Maya Chen</title></head><body><article><h1>Maya Chen</h1>" +
    `<p>${paragraph.repeat(6)}</p>${links}</article></body></html>`
  );
}

function ports(recorder: ResearchAttemptRecorder, html: string): ReaderPorts {
  return fromPartial<ReaderPorts>({
    fetch: async (url: string) => ({
      url,
      status: 200,
      contentType: "text/html",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body: html,
    }),
    fetchBytes: async () => {
      throw new Error("An HTML page is fetched as text, not bytes.");
    },
    recorder,
    timeoutMs: 1000,
  });
}

test("a page reports its document links as candidates, in page order", async () => {
  const recorder = new ResearchAttemptRecorder("operation-attachment-harvest");
  const result = await readPersonSource(
    "https://example.com/maya",
    "",
    ports(
      recorder,
      page(
        '<a href="/deck.pptx">Talk deck</a>' +
          '<a href="/annual-report.pdf">Annual report</a>' +
          '<a href="/other">Another page</a>' +
          '<a href="/maya">Permalink</a>' +
          '<a href="#section">Jump to section</a>' +
          '<a href="/press%20kit.docx"><img src="/icon.png" alt=""></a>',
      ),
    ),
  );

  expect(result.access).toBe("retrieved");
  expect(result.attachments).toEqual([
    { url: "https://example.com/deck.pptx", title: "Talk deck" },
    { url: "https://example.com/annual-report.pdf", title: "Annual report" },
    { url: "https://example.com/press%20kit.docx", title: "press kit.docx" },
  ]);
  /* The outbound harvest keeps its existing shape: every candidate is in it,
     and so is everything the attachment bound does not report. */
  expect(result.outboundUrls).toContain("https://example.com/deck.pptx");
  expect(result.outboundUrls).toContain("https://example.com/other");
});

test("the candidate harvest is bounded and deduplicated", async () => {
  const recorder = new ResearchAttemptRecorder("operation-attachment-bound");
  const links = Array.from(
    { length: 10 },
    (_, index) => `<a href="/doc-${String(index)}.pdf">Document ${String(index)}</a>`,
  ).join("");
  const result = await readPersonSource(
    "https://example.com/maya",
    "",
    ports(recorder, page(`${links}<a href="/doc-0.pdf">Document 0 again</a>`)),
  );

  expect(result.attachments).toHaveLength(8);
  expect(result.attachments?.[0]?.url).toBe("https://example.com/doc-0.pdf");
  expect(result.attachments?.[7]?.url).toBe("https://example.com/doc-7.pdf");
  expect(new Set(result.attachments?.map((attachment) => attachment.url)).size).toBe(8);
  /* The two documents the bound dropped are reported as a coverage fact, not
     silently truncated. */
  const [truncation] = recorder.all();
  expect([truncation.stage, truncation.code, truncation.outcome]).toEqual([
    "selection",
    "selection-deferred",
    "skipped",
  ]);
  expect(truncation.reason).toContain("2 were not reported");
});

test("a page with no document links reports none", async () => {
  const recorder = new ResearchAttemptRecorder("operation-attachment-none");
  const result = await readPersonSource(
    "https://example.com/maya",
    "",
    ports(recorder, page('<a href="https://example.com/profile">Profile</a>')),
  );

  expect(result.attachments).toBeUndefined();
});
