import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { normalizeTextLf, SourceError } from "./convert.js";

/**
 * Scanned PDFs as grounded evidence (issue #247).
 *
 * The text-layer extractor in convert.ts reads a scanned (image-only) PDF as
 * empty: there are no text operators to extract, so the document either fails
 * as an empty file or never reaches a claim at all. This module sits beside
 * that extractor and answers the two questions it cannot: which pages carry a
 * text layer and which need OCR, and — when no OCR engine is available — what
 * exactly is missing. Without the per-page shape below, a claim built on an
 * OCR'd document could not cite the page it rests on, which is the same as
 * having no citation a reader can check.
 */

/** One PDF page's extracted text and where that text came from. */
export interface PdfPageSegment {
  /** 1-based page number, so a claim can cite the page it rests on. */
  page: number;
  text: string;
  /** Whether this page was read from the PDF text layer or via OCR. */
  origin: "text-layer" | "ocr";
}

export interface ScannedPdfExtraction {
  segments: PdfPageSegment[];
  /** True when any segment came from the OCR engine rather than the text layer. */
  ocrApplied: boolean;
}

/**
 * The OCR port. Production shells out to a system `tesseract` binary (see
 * detectSystemTesseract); tests inject a fake, so CI stays deterministic and
 * needs no binary. The engine reads whole-PDF bytes and answers one string
 * per page, in page order — per-page rasterisation would need a rendering
 * stack the server must not carry.
 */
export interface OcrEngine {
  readonly name: string;
  recognizePdf(pdfBytes: Buffer): Promise<string[]>;
}

/* convert.ts keeps this private; the scanned path needs the same
   file-versus-converter distinction so an unparseable document keeps its
   parser location instead of reading as a programming failure (#247). */
function isProgrammingFailure(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    error instanceof ReferenceError ||
    error instanceof RangeError ||
    (error instanceof Error && error.name === "AssertionError")
  );
}

function pdfTextItems(content: { items: unknown[] }): string {
  return content.items
    .map((item) => {
      if (
        typeof item === "object" &&
        item !== null &&
        "str" in item &&
        typeof item.str === "string"
      ) {
        return item.str;
      }
      return "";
    })
    .join(" ");
}

/**
 * The honest gap for a scanned PDF no available engine can read: it names the
 * unsupported format and carries a reproduction pointer, reusing the
 * ConversionDiagnostic conventions, so the failure is never
 * indistinguishable-from-nothing. Thrown when no engine was passed and when
 * a passed engine fails — a failed OCR run leaves the document unread either
 * way, and the gap says so rather than masking the failure.
 */
export function scannedPdfGapError(fileName: string, bytes: Buffer): SourceError {
  return new SourceError(
    "SOURCE_UNSUPPORTED",
    `The PDF '${fileName}' is a scanned (image-only) document with no text layer ` +
      `(format pdf) and no OCR engine is available. ` +
      `Reproduce with: save the document bytes to /tmp/scanned.pdf and run ` +
      `extractPdfSegments with a system tesseract OCR engine.`,
    {
      classification: "unsupported_format",
      format: "pdf",
      bytes: bytes.byteLength,
      step: "extract_pdf",
    },
  );
}

/**
 * Extract one PDF's text as per-page segments. Pages with a text layer keep
 * it; pages without one are read through the OCR engine when given. A fully
 * scanned PDF with no engine fails with scannedPdfGapError rather than with
 * an empty-file diagnostic that never names what is missing.
 */
export async function extractPdfSegments(
  fileName: string,
  bytes: Buffer,
  ocr?: OcrEngine | null,
): Promise<ScannedPdfExtraction> {
  if (extname(fileName).toLowerCase() !== ".pdf") {
    const format = extname(fileName).slice(1).toLowerCase() || "unknown";
    throw new SourceError("SOURCE_UNSUPPORTED", `Unsupported file format: ${format}.`, {
      classification: "unsupported_format",
      format,
      bytes: bytes.byteLength,
      step: "detect_format",
    });
  }
  let layer: string[];
  try {
    const doc = await getDocument({ data: new Uint8Array(bytes) }).promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(normalizeTextLf(pdfTextItems(content)).trim());
    }
    layer = pages;
  } catch (error) {
    if (error instanceof SourceError) throw error;
    const fileCaused = !isProgrammingFailure(error);
    throw new SourceError(
      "SOURCE_INVALID",
      fileCaused ? "The PDF could not be read." : "The PDF converter failed.",
      {
        classification: fileCaused ? "invalid_file" : "converter_failure",
        format: "pdf",
        bytes: bytes.byteLength,
        step: "extract_pdf",
      },
    );
  }
  const blank = layer.map((text) => text.length === 0);
  if (blank.every(Boolean)) {
    if (!ocr) throw scannedPdfGapError(fileName, bytes);
    const segments = ocrSegments(layer.length, await recognizePdf(ocr, fileName, bytes));
    requireOcrText(segments, bytes);
    return { segments, ocrApplied: true };
  }
  if (blank.some(Boolean) && ocr) {
    const recognized = await recognizePdf(ocr, fileName, bytes);
    return {
      segments: layer.map((text, index) => ({
        page: index + 1,
        text: text.length > 0 ? text : normalizeTextLf(recognized[index] ?? "").trim(),
        origin: text.length > 0 ? ("text-layer" as const) : ("ocr" as const),
      })),
      ocrApplied: true,
    };
  }
  return {
    segments: layer.map((text, index) => ({
      page: index + 1,
      text,
      origin: "text-layer" as const,
    })),
    ocrApplied: false,
  };
}

async function recognizePdf(ocr: OcrEngine, fileName: string, bytes: Buffer): Promise<string[]> {
  try {
    return await ocr.recognizePdf(bytes);
  } catch {
    throw scannedPdfGapError(fileName, bytes);
  }
}

function ocrSegments(pageCount: number, recognized: string[]): PdfPageSegment[] {
  return Array.from({ length: pageCount }, (_, index) => ({
    page: index + 1,
    text: normalizeTextLf(recognized[index] ?? "").trim(),
    origin: "ocr" as const,
  }));
}

function requireOcrText(segments: PdfPageSegment[], bytes: Buffer): void {
  if (segments.every((segment) => segment.text.length === 0)) {
    throw new SourceError("SOURCE_INVALID", "The file contains no readable text.", {
      classification: "empty_file",
      format: "pdf",
      bytes: bytes.byteLength,
      step: "validate_text",
    });
  }
}

/**
 * Render segments into retained text whose page markers the document reader's
 * existing pageAnchors pass (`\n[page N]\n`) already recognises, so a claim
 * built on OCR text cites the page it rests on. The integration owner wires
 * this into readDocument (see the PR body): render here, keep anchors there.
 */
export function renderPdfSegments(segments: PdfPageSegment[]): string {
  return segments.map((segment) => `\n[page ${segment.page}]\n${segment.text}`).join("");
}

const runFile = promisify(execFile);

/* Tesseract separates the pages it reads from one PDF with form feeds (and
   usually ends the output with one); interior blanks are kept so the
   surviving entries stay aligned with their page numbers. */
function splitTesseractPages(stdout: string): string[] {
  const pages = stdout.split("\f").map((page) => normalizeTextLf(page).trim());
  while (pages.length > 1 && pages[pages.length - 1] === "") pages.pop();
  return pages;
}

/**
 * Detect the production OCR adapter at runtime: a system `tesseract` binary
 * on PATH, used only when present. Resolves to null where the binary is
 * absent (notably CI) or unreadable — callers treat null as "no engine" and
 * take the scannedPdfGapError path, so detection never throws and never
 * needs an install. No cloud OCR, no new dependency: one stdio call.
 */
export async function detectSystemTesseract(): Promise<OcrEngine | null> {
  try {
    await runFile("tesseract", ["--version"], { timeout: 10_000 });
  } catch {
    return null;
  }
  return {
    name: "tesseract",
    async recognizePdf(pdfBytes: Buffer): Promise<string[]> {
      const dir = mkdtempSync(join(tmpdir(), "scanned-pdf-ocr-"));
      try {
        const input = join(dir, "source.pdf");
        writeFileSync(input, pdfBytes);
        const { stdout } = await runFile("tesseract", [input, "stdout", "-l", "eng"], {
          timeout: 120_000,
          maxBuffer: 64 * 1024 * 1024,
        });
        return splitTesseractPages(String(stdout));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
