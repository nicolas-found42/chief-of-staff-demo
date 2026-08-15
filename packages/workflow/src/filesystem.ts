import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { TRACKING_CSV_HEADER } from "@chief-of-staff/contracts";

/** A local:// URI is a workspace-relative path with forward slashes. */
export function localUri(relativePath: string): string {
  const normalized = normalize(relativePath).split(sep).join("/");
  if (normalized.startsWith("../") || normalized === ".." || isAbsolute(normalized)) {
    throw new Error(`Not a workspace-relative path: ${relativePath}`);
  }
  return `local://${normalized}`;
}

/** Parse a local:// URI back into a workspace-relative path with forward slashes. */
export function parseLocalUri(uri: string): string {
  if (!uri.startsWith("local://")) {
    throw new Error(`Not a local:// URI: ${uri}`);
  }
  const rel = uri.slice("local://".length);
  if (
    rel.length === 0 ||
    isAbsolute(rel) ||
    rel.split("/").some((part) => part === "..") ||
    rel.includes("\\")
  ) {
    throw new Error(`Unsafe local:// URI: ${uri}`);
  }
  return rel;
}

/**
 * Resolve a workspace-relative path against the workspace root and verify
 * containment. For paths whose final component may not exist yet, the nearest
 * existing ancestor is realpathed and checked against the realpath of the root.
 */
export async function resolveWithinRoot(root: string, relativePath: string): Promise<string> {
  if (isAbsolute(relativePath)) {
    throw new Error(`Absolute paths are not allowed: ${relativePath}`);
  }
  const rootReal = await realpath(root);
  const candidate = normalize(join(rootReal, relativePath));
  if (candidate !== rootReal && !candidate.startsWith(rootReal + sep)) {
    throw new Error(`Path escapes the workspace root: ${relativePath}`);
  }
  // Walk up until an existing ancestor is found and verify its realpath stays
  // inside the root. This rejects symlink escapes.
  let existing = candidate;
  for (;;) {
    try {
      const real = await realpath(existing);
      if (real !== rootReal && !real.startsWith(rootReal + sep)) {
        throw new Error(`Symlink escapes the workspace root: ${relativePath}`);
      }
      return candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(existing);
      if (parent === existing) {
        throw new Error(`Unresolvable path: ${relativePath}`);
      }
      existing = parent;
    }
  }
}

/** Sanitize untrusted text into a safe filename fragment. Never use LLM text
 * as a raw path component; derive filenames only through this function. */
export function safeFilenameFragment(text: string, fallback = "item"): string {
  const cleaned = text
    .normalize("NFC")
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  const limited = cleaned.slice(0, 80);
  return limited.length > 0 ? limited : fallback;
}

/** Write a file atomically: temp file in the same directory, then rename. */
export async function atomicWriteFile(absPath: string, data: Uint8Array | string): Promise<void> {
  const dir = dirname(absPath);
  await mkdir(dir, { recursive: true });
  const tmp = join(
    dir,
    `.tmp-${process.pid}-${randomBytes(6).toString("hex")}-${Date.now()}`
  );
  try {
    await writeFile(tmp, data);
    const handle = await open(tmp, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, absPath);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function atomicWriteText(
  absPath: string,
  text: string,
  opts: { executable?: boolean } = {}
): Promise<void> {
  await atomicWriteFile(absPath, Buffer.from(text, "utf8"));
  if (opts.executable) {
    // No-op on Windows; kept for parity with POSIX hosts.
  }
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function sha256OfFile(absPath: string): Promise<string> {
  const data = await readFile(absPath);
  return sha256Hex(data);
}

export async function readTextFile(absPath: string): Promise<string> {
  return readFile(absPath, "utf8");
}

/** Normalize text to UTF-8 with LF line endings. */
export function normalizeTextLf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export interface CsvRow {
  row_id: string;
  run_id: string;
  task_index: number;
  task_name: string;
  task_type: string;
  assigned_to: string;
  deadline: string;
  source_step: string;
  target_uri: string;
  status: string;
  created_at: string;
  source_validation_error: string;
}

function csvEscape(value: string | number): string {
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

function rowToFields(row: CsvRow): string[] {
  return [
    row.row_id,
    row.run_id,
    String(row.task_index),
    row.task_name,
    row.task_type,
    row.assigned_to,
    row.deadline,
    row.source_step,
    row.target_uri,
    row.status,
    row.created_at,
    row.source_validation_error,
  ];
}

function fieldsToRow(fields: string[]): CsvRow {
  return {
    row_id: fields[0] ?? "",
    run_id: fields[1] ?? "",
    task_index: Number(fields[2] ?? "0"),
    task_name: fields[3] ?? "",
    task_type: fields[4] ?? "",
    assigned_to: fields[5] ?? "",
    deadline: fields[6] ?? "",
    source_step: fields[7] ?? "",
    target_uri: fields[8] ?? "",
    status: fields[9] ?? "",
    created_at: fields[10] ?? "",
    source_validation_error: fields[11] ?? "",
  };
}

/** Thread-safe tracker over the actions CSV. All commits are serialized by the
 * engine through a shared mutex; this class also serializes within itself. */
export class TrackingCsv {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly csvPath: string) {}

  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async readRows(): Promise<CsvRow[]> {
    return this.serialize(async () => this.readRowsLocked());
  }

  /** Atomic idempotent upsert by row_id. Rows are stored sorted by row_id so
   * the file content is independent of parallel iteration completion order. */
  async upsert(row: CsvRow): Promise<CsvRow> {
    return this.serialize(async () => {
      const rows = await this.readRowsLocked();
      const index = rows.findIndex((existing) => existing.row_id === row.row_id);
      if (index >= 0) {
        rows[index] = row;
      } else {
        rows.push(row);
      }
      rows.sort((a, b) => a.row_id.localeCompare(b.row_id));
      const header = TRACKING_CSV_HEADER.join(",");
      const body = rows.map((r) => rowToFields(r).map(csvEscape).join(",")).join("\n");
      await atomicWriteText(this.csvPath, `${header}\n${body}${rows.length ? "\n" : ""}`);
      return row;
    });
  }

  private async readRowsLocked(): Promise<CsvRow[]> {
    let text: string;
    try {
      text = await readFile(this.csvPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
      return [];
    }
    if (lines[0] !== TRACKING_CSV_HEADER.join(",")) {
      throw new Error("Tracking CSV header mismatch; refusing to parse");
    }
    return lines.slice(1).map(parseCsvLine).map(fieldsToRow);
  }
}
