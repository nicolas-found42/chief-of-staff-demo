import type { RunManifest } from "@chief-of-staff/contracts";
import {
  WorkflowError,
  normalizeTextLf,
  sha256Hex,
  Workspace,
  type IdGenerator,
  type RunSourceInfo,
} from "@chief-of-staff/workflow";
import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";

export const SUPPORTED_EXTENSIONS = new Set([".txt", ".md", ".pdf", ".docx"]);

export function mimeTypeFor(filename: string): string {
  switch (extname(filename).toLowerCase()) {
    case ".txt":
      return "text/plain";
    case ".md":
      return "text/markdown";
    case ".pdf":
      return "application/pdf";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    default:
      throw new WorkflowError("SOURCE_UNSUPPORTED", `Unsupported file extension: ${filename}`);
  }
}

export function titleFor(filename: string): string {
  const ext = extname(filename);
  return basename(filename, ext);
}

export function isSupported(filename: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(filename).toLowerCase());
}

/** A file is stable when size and mtime are unchanged for debounceMs and the
 * file can be opened for reading. */
export async function waitForStability(
  filePath: string,
  debounceMs: number,
  signal?: AbortSignal
): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  let last = { size: -1, mtimeMs: -1 };
  for (;;) {
    if (signal?.aborted) {
      return false;
    }
    let current;
    try {
      const info = await stat(filePath);
      current = { size: info.size, mtimeMs: info.mtimeMs };
      await open(filePath, "r").then((handle) => handle.close());
    } catch {
      return false;
    }
    const unchanged =
      current.size === last.size && current.mtimeMs === last.mtimeMs;
    if (unchanged) {
      return true;
    }
    last = current;
    await new Promise((resolve) => setTimeout(resolve, debounceMs));
    if (Date.now() > deadline) {
      return false;
    }
  }
}

export interface ClaimedSource {
  runId: string;
  source: RunSourceInfo;
  claimedPath: string;
}

/** Atomically claim a stable inbox file into source/processing/<run-id>/. */
export async function claimFile(
  workspace: Workspace,
  ids: IdGenerator,
  inboxFilePath: string,
  maxBytes: number
): Promise<ClaimedSource> {
  const filename = basename(inboxFilePath);
  if (!isSupported(filename)) {
    throw new WorkflowError(
      "SOURCE_UNSUPPORTED",
      `Unsupported transcript extension: ${filename}`
    );
  }
  const info = await stat(inboxFilePath);
  if (info.size > maxBytes) {
    throw new WorkflowError(
      "SOURCE_TOO_LARGE",
      `Transcript is ${info.size} bytes; the limit is ${maxBytes}`
    );
  }
  const runId = ids.runId();
  const targetDir = join(workspace.layout.sourceProcessingDir, runId);
  const claimedPath = join(targetDir, filename);
  // Claim by atomic move: only one claimant wins the rename.
  await mkdir(targetDir, { recursive: true });
  try {
    await rename(inboxFilePath, claimedPath);
  } catch (error) {
    throw new WorkflowError(
      "FILESYSTEM_WRITE",
      `Unable to claim ${filename}: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: true, cause: error }
    );
  }
  const bytes = await readFile(claimedPath);
  return {
    runId,
    claimedPath,
    source: {
      filename,
      title: titleFor(filename),
      mimeType: mimeTypeFor(filename),
      byteSize: bytes.byteLength,
      sha256: sha256Hex(new Uint8Array(bytes)),
      stat: { birthtimeMs: info.birthtimeMs, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs },
    },
  };
}

export interface ParsedTranscript {
  text: string;
}

/** Parse a claimed source into normalized UTF-8 text with LF endings. */
export async function parseTranscript(claimedPath: string, mimeType: string): Promise<ParsedTranscript> {
  if (mimeType === "text/plain" || mimeType === "text/markdown") {
    const raw = await readFile(claimedPath, "utf8");
    return { text: normalizeTextLf(raw) };
  }
  if (mimeType === "application/pdf") {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const data = new Uint8Array(await readFile(claimedPath));
    const doc = await getDocument({ data }).promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(
        content.items
          .map((item) => ("str" in item ? (item as { str: string }).str : ""))
          .join(" ")
      );
    }
    return { text: normalizeTextLf(pages.join("\n")) };
  }
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const mammoth = await import("mammoth");
    const buffer = await readFile(claimedPath);
    const result = await mammoth.extractRawText({ buffer });
    return { text: normalizeTextLf(result.value) };
  }
  throw new WorkflowError("SOURCE_UNSUPPORTED", `Unsupported MIME type: ${mimeType}`);
}

export async function moveTo(
  workspace: Workspace,
  runId: string,
  fromRel: string,
  toDir: string
): Promise<void> {
  const from = join(workspace.root, fromRel);
  const to = join(toDir, basename(fromRel));
  try {
    await rename(from, to);
  } catch (error) {
    // The source may already be gone; treat as benign.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function finalizeSource(
  workspace: Workspace,
  runId: string,
  status: RunManifest["status"],
  error?: { code: string; message: string; retryable: boolean } | null
): Promise<void> {
  const rel = `source/processing/${runId}`;
  if (status === "succeeded") {
    await moveTo(workspace, runId, rel, workspace.layout.sourceProcessedDir);
    return;
  }
  await moveTo(workspace, runId, rel, workspace.layout.sourceFailedDir);
  if (error) {
    await workspace.writeText(
      `source/failed/${runId}/failure.json`,
      `${JSON.stringify({ schemaVersion: 1, runId, status, error }, null, 2)}\n`
    );
  }
}
