import { fromPartial } from "@total-typescript/shoehorn";
import { expect, test } from "vitest";
import { ResearchAttemptRecorder } from "../../../apps/server/src/person-profile/research-diagnostics.js";
import {
  readPersonSource,
  type ReaderPorts,
} from "../../../apps/server/src/person-profile/research-readers.js";
import { deckBytes } from "./presentation-deck-fixture.js";

/**
 * Presentation decks at the document-reader seam (issue #248).
 *
 * The seam contract: a deck retrieved as bytes reads slide by slide, and the
 * retained text carries the slide markers the anchor pass cites — a deck
 * contributes grounded evidence or its format's own gap, never a generic
 * parser failure that leaves the pipeline unable to say what was missing.
 */

function ports(
  recorder: ResearchAttemptRecorder,
  bytes: Buffer,
  contentType = "application/vnd.openxmlformats-officedocument.presentationml.presentation",
): ReaderPorts {
  return fromPartial<ReaderPorts>({
    fetch: async () => {
      throw new Error("The deck is fetched as bytes, not text.");
    },
    fetchBytes: async (url: string) => ({
      url,
      status: 200,
      contentType,
      retryAfter: null,
      bytes,
    }),
    recorder,
    timeoutMs: 1000,
  });
}

test("a PPTX deck routes through slide segmentation and keeps slide anchors", async () => {
  const recorder = new ResearchAttemptRecorder("operation-presentation-reader");
  const bytes = await deckBytes([
    { part: "slide2", paragraphs: ["Maya Chen: ocean sensor programme"] },
    { part: "slide1", paragraphs: ["Field results, 2024"] },
  ]);
  const result = await readPersonSource(
    "https://example.com/talks/maya-2024.pptx",
    "",
    ports(recorder, bytes),
  );

  expect(result.access).toBe("retrieved");
  expect(result.route).toBe("document-reader");
  expect(result.text).toContain("\n[slide 1]\nMaya Chen: ocean sensor programme");
  expect(result.text).toContain("\n[slide 2]\nField results, 2024");
  expect(result.provenanceNote).toContain("presentation");
  /* Slide numbers become locators a citation can carry, at the exact offsets
     the markers sit at — the same page-kind anchor a PDF page produces. */
  expect(result.anchors.map((anchor) => [anchor.kind, anchor.value])).toEqual([
    ["page", "1"],
    ["page", "2"],
  ]);
  for (const anchor of result.anchors)
    expect(result.text.slice(anchor.offset, anchor.offset + 10)).toContain("[slide ");
});

test("a deck behind an extension-less address is routed by its content type", async () => {
  const recorder = new ResearchAttemptRecorder("operation-presentation-content-type");
  const bytes = await deckBytes([{ part: "slide1", paragraphs: ["Résumé highlights"] }]);
  const result = await readPersonSource(
    "https://example.com/download?id=42",
    "",
    fromPartial<ReaderPorts>({
      fetch: async (url: string) => ({
        url,
        status: 200,
        contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body: "binary body that must not be decoded as text",
      }),
      fetchBytes: async (url: string) => ({
        url,
        status: 200,
        contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        retryAfter: null,
        bytes,
      }),
      recorder,
      timeoutMs: 1000,
    }),
  );

  expect(result.text).toContain("\n[slide 1]\nRésumé highlights");
});

test("an unimplemented presentation format records its exact format gap", async () => {
  const recorder = new ResearchAttemptRecorder("operation-presentation-gap");
  const result = await readPersonSource(
    "https://example.com/talks/maya-keynote.key",
    "",
    ports(recorder, Buffer.from("keynote package bytes")),
  );

  expect(result.access).toBe("unsupported");
  expect(result.failureReason).toContain("Unsupported file format: key");
  const [failure] = recorder.failures();
  expect([failure.collector, failure.code, failure.cause]).toEqual([
    "document-reader",
    "unsupported-format",
    "observed",
  ]);
  expect(failure.reason).toContain("Unsupported file format: key");
  expect(failure.observed?.parserLocation).toBe("source.key");
});

test("a broken deck is a parser failure, not a named format gap", async () => {
  const recorder = new ResearchAttemptRecorder("operation-presentation-broken");
  const result = await readPersonSource(
    "https://example.com/talks/maya.pptx",
    "",
    ports(recorder, Buffer.from("this is not a zip package")),
  );

  expect(result.access).toBe("unsupported");
  const [failure] = recorder.failures();
  expect(failure.code).toBe("parser-failed");
  expect(failure.observed?.parserLocation).toBe("source.pptx");
});
