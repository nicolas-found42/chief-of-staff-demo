import { extname } from "node:path";
import JSZip from "jszip";
import type { ConversionStep } from "@chief-of-staff-demo/shared";
import { isProgrammingFailure, normalizeTextLf, SourceError } from "./convert.js";

/**
 * Presentation decks as grounded evidence (issue #248).
 *
 * Slides are a common carrier of a person's own account of their work — a
 * conference talk, a board briefing, a portfolio — and the document reader
 * beside this module could not read one: a deck linked from a read page
 * reached `convertToText` and came back as an unsupported format with no text
 * and no format named. This module answers for the OOXML presentation package
 * the way `convert.ts` answers for DOCX and `scanned-documents.ts` answers for
 * scanned PDFs, and it answers for it the same way: read the deck slide by
 * slide, keep each slide's number, and render the markers the reader's anchor
 * pass already cites.
 *
 * The formats the package cannot be read as are named exactly rather than
 * guessed at. A legacy `.ppt`, an OpenDocument `.odp` or a Keynote `.key` deck
 * fails with its own extension on the diagnostic: a gap that says which format
 * is missing is actionable, and a generic parser failure is not. Nothing here
 * rasterises or OCRs a slide image: an image-only deck reports that it carries
 * no readable text rather than implying it was read.
 */

/** One slide's extracted text and its 1-based position in the deck. */
export interface PresentationSlideSegment {
  /** 1-based slide number, so a claim can cite the slide it rests on. */
  slide: number;
  text: string;
}

export interface PresentationExtraction {
  segments: PresentationSlideSegment[];
}

/**
 * Every presentation extension the person-research reader owns. `.pptx` is
 * read below; the other three are routed here so their gap names the format
 * instead of surfacing as a content-type the reader never learned.
 */
const PRESENTATION_EXTENSIONS: Record<string, true> = {
  pptx: true,
  ppt: true,
  odp: true,
  key: true,
};

/** Whether a file name (or URL path) is a presentation this reader owns. */
export function isPresentationFileName(fileName: string): boolean {
  return PRESENTATION_EXTENSIONS[extname(fileName).slice(1).toLowerCase()] === true;
}

/**
 * The presentation extension a URL's *path* names, lowercased, or null.
 *
 * Used before any request is made: the reader routes a deck address to the
 * byte reader (rather than decoding compressed bytes as text), and the HTML
 * reader recognises a deck link as an attachment candidate, from this alone.
 * The query string is not a path: `page?file=deck.pptx` is not a deck, so the
 * check runs against `url.pathname` wherever the value parses as a URL.
 */
export function presentationExtensionOf(value: string): string | null {
  let path: string;
  try {
    path = new URL(value).pathname;
  } catch {
    path = value.split(/[?#]/)[0] ?? "";
  }
  const extension = /\.([A-Za-z0-9]{1,8})$/.exec(path)?.[1]?.toLowerCase();
  return extension && PRESENTATION_EXTENSIONS[extension] === true ? extension : null;
}

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * Decode the entities an OOXML text run can carry. An entity this reader does
 * not know, or a numeric reference outside Unicode, is kept verbatim rather
 * than dropped: escaping the unknown is how markup would leak into a claim.
 */
function decodeXmlText(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (entity, body: string) => {
    if (body.startsWith("#")) {
      const hexadecimal = body.startsWith("#x") || body.startsWith("#X");
      const code = Number.parseInt(
        hexadecimal ? body.slice(2) : body.slice(1),
        hexadecimal ? 16 : 10,
      );
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : entity;
    }
    return XML_ENTITIES[body] ?? entity;
  });
}

/**
 * One slide part's text. Paragraph ends and explicit line breaks become
 * newlines, runs concatenate in document order, and empty spacer paragraphs
 * contribute nothing — a deck reads as its slides present it, not as its XML
 * nests it. Only DrawingML text runs (`a:t`) are read; shape geometry, notes
 * and image parts are not text and are not invented as any.
 */
function slideText(xml: string): string {
  const lines: string[] = [];
  for (const paragraph of xml.split(/<\/a:p>/)) {
    let text = "";
    for (const match of paragraph.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/?>/g))
      text += match[1] === undefined ? "\n" : decodeXmlText(match[1]);
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) lines.push(trimmed);
    }
  }
  return lines.join("\n");
}

/**
 * The slide parts in deck order.
 *
 * Deck order is not file-name order: `presentation.xml` lists the slides as
 * relationship ids and the package's relationship part maps each id to a
 * part. Reading the files by their names would mis-number a deck whose parts
 * were reordered, and the slide number is exactly what a citation rests on.
 * The name-sorted listing is only the fallback for a package whose
 * relationship parts are missing.
 */
async function slideParts(zip: JSZip): Promise<string[]> {
  const presentation = zip.file("ppt/presentation.xml");
  const relationships = zip.file("ppt/_rels/presentation.xml.rels");
  if (presentation && relationships) {
    const order = [
      ...(await presentation.async("string")).matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g),
    ].map((match) => match[1]!);
    const targets = new Map<string, string>();
    /* Either attribute may come first in the relationship element, so each
       is read from the element as a whole rather than from a positional
       pattern that would depend on the writer's attribute order. */
    for (const element of (await relationships.async("string")).matchAll(
      /<Relationship\b[^>]*>/g,
    )) {
      const id = /\bId="([^"]+)"/.exec(element[0])?.[1];
      const target = /\bTarget="([^"]+)"/.exec(element[0])?.[1];
      if (id && target) targets.set(id, target);
    }
    const ordered = order.flatMap((id) => {
      const target = targets.get(id);
      if (!target) return [];
      const part = target.replace(/^\//, "");
      return [part.startsWith("ppt/") ? part : `ppt/${part}`];
    });
    if (ordered.length > 0) return ordered;
  }
  return Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort(
      (a, b) => Number(/slide(\d+)\.xml$/.exec(a)![1]) - Number(/slide(\d+)\.xml$/.exec(b)![1]),
    );
}

function presentationError(
  message: string,
  classification: "invalid_file" | "converter_failure" | "empty_file",
  bytes: number,
  step: ConversionStep,
): SourceError {
  return new SourceError("SOURCE_INVALID", message, {
    classification,
    format: "pptx",
    bytes,
    step,
  });
}

/**
 * Extract one `.pptx` deck's text as per-slide segments, in deck order.
 *
 * A package that does not carry the presentation parts fails as a broken
 * file, an image-only deck fails as one with no readable text, and a
 * presentation in a format this reader does not implement fails with that
 * format's own name — never as a generic parser failure.
 */
export async function extractPresentationSegments(
  fileName: string,
  bytes: Buffer,
): Promise<PresentationExtraction> {
  if (extname(fileName).toLowerCase() !== ".pptx") {
    const format = extname(fileName).slice(1).toLowerCase() || "unknown";
    throw new SourceError("SOURCE_UNSUPPORTED", `Unsupported file format: ${format}.`, {
      classification: "unsupported_format",
      format,
      bytes: bytes.byteLength,
      step: "detect_format",
    });
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (error) {
    throw presentationError(
      "The presentation file could not be read.",
      isProgrammingFailure(error) ? "converter_failure" : "invalid_file",
      bytes.byteLength,
      "extract_pptx",
    );
  }
  const contentTypes = zip.file("[Content_Types].xml");
  if (!contentTypes || !zip.file("ppt/presentation.xml"))
    throw presentationError(
      "The presentation file could not be read.",
      "invalid_file",
      bytes.byteLength,
      "extract_pptx",
    );
  const declared = await contentTypes.async("string");
  if (!declared.includes("presentationml"))
    throw presentationError(
      "The presentation file could not be read.",
      "invalid_file",
      bytes.byteLength,
      "extract_pptx",
    );
  const parts = await slideParts(zip);
  if (parts.length === 0)
    throw presentationError(
      "The presentation file could not be read.",
      "invalid_file",
      bytes.byteLength,
      "extract_pptx",
    );
  const segments: PresentationSlideSegment[] = [];
  for (const [index, part] of parts.entries()) {
    const file = zip.file(part);
    if (!file)
      /* A slide the package lists but does not carry cannot be read and must
         not silently shift the slides after it onto the wrong numbers. */
      throw presentationError(
        "The presentation file could not be read.",
        "invalid_file",
        bytes.byteLength,
        "extract_pptx",
      );
    segments.push({
      slide: index + 1,
      text: normalizeTextLf(slideText(await file.async("string"))).trim(),
    });
  }
  if (segments.every((segment) => segment.text.length === 0))
    throw presentationError(
      "The file contains no readable text.",
      "empty_file",
      bytes.byteLength,
      "validate_text",
    );
  return { segments };
}

/**
 * Render segments into retained text whose slide markers the document
 * reader's anchor pass recognises, so a claim built on a deck cites the slide
 * it rests on. A slide is the page of a deck, and the anchor pass reads both
 * markers as its own page-kind anchor.
 */
export function renderPresentationSegments(segments: PresentationSlideSegment[]): string {
  return segments.map((segment) => `\n[slide ${segment.slide}]\n${segment.text}`).join("");
}
