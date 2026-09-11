import { expect, test } from "vitest";
import { SourceError } from "../../../apps/server/src/text/convert.js";
import {
  extractPresentationSegments,
  presentationExtensionOf,
  renderPresentationSegments,
} from "../../../apps/server/src/text/presentations.js";
import { deckBytes } from "./presentation-deck-fixture.js";

/**
 * Presentation decks at the extractor seam (issue #248).
 *
 * The contract: a `.pptx` reads slide by slide in *deck* order — the order
 * `presentation.xml` lists, not the order the parts happen to be named — so
 * the slide number a claim cites is the slide a reader would open. Formats
 * the extractor does not implement fail naming their own extension, and a
 * package with no readable text says so instead of producing an empty deck.
 */

test("a deck reads in deck order, not file-name order", async () => {
  const bytes = await deckBytes([
    { part: "slide2", paragraphs: ["Opening slide"] },
    { part: "slide1", paragraphs: ["Second slide"] },
  ]);

  const { segments } = await extractPresentationSegments("talk.pptx", bytes);

  expect(segments).toEqual([
    { slide: 1, text: "Opening slide" },
    { slide: 2, text: "Second slide" },
  ]);
});

test("falls back to numeric part order when the deck lists no relationships", async () => {
  const bytes = await deckBytes(
    [
      { part: "slide2", paragraphs: ["Second slide"] },
      { part: "slide1", paragraphs: ["Opening slide"] },
    ],
    { relationships: false },
  );

  const { segments } = await extractPresentationSegments("talk.pptx", bytes);

  expect(segments.map((segment) => segment.text)).toEqual(["Opening slide", "Second slide"]);
});

test("a slide's text keeps paragraph and line breaks and decodes entities", async () => {
  const bytes = await deckBytes([
    {
      part: "slide1",
      paragraphs: ["Trials &amp; errors", "Cut <b>cost</b> by 40%", "Line one\nLine two"],
    },
  ]);

  const { segments } = await extractPresentationSegments("talk.pptx", bytes);

  expect(segments[0]?.text).toBe("Trials & errors\nCut <b>cost</b> by 40%\nLine one\nLine two");
});

test("renders slide markers the citation anchor pass recognises", () => {
  const text = renderPresentationSegments([
    { slide: 1, text: "Opening" },
    { slide: 2, text: "Closing" },
  ]);

  expect(text).toBe("\n[slide 1]\nOpening\n[slide 2]\nClosing");
});

test("names an unimplemented presentation format by its own extension", async () => {
  const bytes = await deckBytes([{ part: "slide1", paragraphs: ["unused"] }]);

  try {
    await extractPresentationSegments("keynote.key", bytes);
    throw new Error("expected the extraction to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).code).toBe("SOURCE_UNSUPPORTED");
    expect((error as SourceError).diagnostic).toMatchObject({
      classification: "unsupported_format",
      format: "key",
      step: "detect_format",
    });
  }
});

test("a package that is not a presentation fails as a broken file, not as text", async () => {
  try {
    await extractPresentationSegments("talk.pptx", Buffer.from("not a zip at all"));
    throw new Error("expected the extraction to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).code).toBe("SOURCE_INVALID");
    expect((error as SourceError).diagnostic).toMatchObject({
      classification: "invalid_file",
      format: "pptx",
      step: "extract_pptx",
    });
  }
});

test("a deck whose slides carry no text reports an empty file", async () => {
  const bytes = await deckBytes([{ part: "slide1", paragraphs: [] }]);

  try {
    await extractPresentationSegments("talk.pptx", bytes);
    throw new Error("expected the extraction to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).diagnostic).toMatchObject({
      classification: "empty_file",
      format: "pptx",
      step: "validate_text",
    });
  }
});

test("recognises a deck address from its path, not its query string", () => {
  expect(presentationExtensionOf("https://example.com/talk.pptx")).toBe("pptx");
  expect(presentationExtensionOf("https://example.com/deck.key?download=1")).toBe("key");
  expect(presentationExtensionOf("https://example.com/page?file=deck.pptx")).toBeNull();
  expect(presentationExtensionOf("https://example.com/report.pdf")).toBeNull();
});
