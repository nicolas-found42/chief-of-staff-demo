import { extname } from "node:path";
import mammoth from "mammoth";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const SUPPORTED_EXTENSIONS: Record<string, true> = {
  ".txt": true,
  ".md": true,
  ".json": true,
  ".jsonc": true,
  ".pdf": true,
  ".docx": true,
};
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export type SourceErrorCode = "SOURCE_INVALID" | "SOURCE_UNSUPPORTED";

export class SourceError extends Error {
  constructor(
    public readonly code: SourceErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SourceError";
  }
}

export function isSupportedFileName(fileName: string): boolean {
  return SUPPORTED_EXTENSIONS[extname(fileName).toLowerCase()] === true;
}

export function normalizeTextLf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

interface SentenceLike {
  speaker_name: string;
  text: string;
  index?: number;
  start_time?: number;
}

function invalidSentence(position: number): SourceError {
  return new SourceError(
    "SOURCE_INVALID",
    `JSON entry ${position} is not a sentence object: expected { speaker_name, text, start_time } (Fireflies sentences export)`
  );
}

/**
 * Convert a Fireflies-style sentences array into transcript text:
 * one `Speaker: text` line per sentence, ordered by `index`
 * (falling back to `start_time` when indexes are absent).
 */
export function sentencesToText(data: unknown): string {
  if (!Array.isArray(data) || data.length === 0) {
    throw new SourceError(
      "SOURCE_INVALID",
      "JSON transcript must be a non-empty array of sentence objects"
    );
  }
  const sentences: SentenceLike[] = data.map((entry, position) => {
    if (typeof entry !== "object" || entry === null) {
      throw invalidSentence(position);
    }
    const obj = entry as Record<string, unknown>;
    const speaker = obj.speaker_name;
    const text = obj.text ?? obj.sentence;
    if (typeof speaker !== "string" || typeof text !== "string") {
      throw invalidSentence(position);
    }
    return {
      speaker_name: speaker,
      text,
      index: typeof obj.index === "number" ? obj.index : undefined,
      start_time:
        typeof obj.start_time === "number"
          ? obj.start_time
          : typeof obj.startTime === "number"
            ? obj.startTime
            : undefined,
    };
  });
  if (sentences.every((s) => typeof s.index === "number")) {
    sentences.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  } else {
    sentences.sort((a, b) => (a.start_time ?? 0) - (b.start_time ?? 0));
  }
  return sentences.map((s) => `${s.speaker_name}: ${s.text}`).join("\n");
}

/** Parse a Drive file into normalized UTF-8 text with LF endings. */
export async function convertToText(fileName: string, bytes: Buffer): Promise<string> {
  const ext = extname(fileName).toLowerCase();
  if (!SUPPORTED_EXTENSIONS[ext]) {
    throw new SourceError("SOURCE_UNSUPPORTED", `Unsupported file type: ${ext || "(no extension)"}`);
  }
  if (ext === ".txt" || ext === ".md") {
    return normalizeTextLf(bytes.toString("utf8"));
  }
  if (ext === ".json" || ext === ".jsonc") {
    let raw = bytes.toString("utf8");
    if (ext === ".jsonc") {
      raw = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new SourceError(
        "SOURCE_INVALID",
        `File is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return sentencesToText(parsed);
  }
  if (ext === ".pdf") {
    const data = new Uint8Array(bytes);
    const doc = await getDocument({ data }).promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(
        content.items
          .map((item) => {
            if (typeof item === "object" && "str" in item && typeof item.str === "string") {
              return item.str;
            }
            return "";
          })
          .join(" ")
      );
    }
    return normalizeTextLf(pages.join("\n"));
  }
  // .docx
  const result = await mammoth.extractRawText({ buffer: bytes });
  return normalizeTextLf(result.value);
}
