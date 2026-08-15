import { TRACKING_CSV_HEADER } from "@chief-of-staff/contracts";
import type { Workspace } from "./workspace.js";

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

  constructor(
    private readonly workspace: Workspace,
    private readonly relativePath: string
  ) {}

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
      await this.workspace.writeText(
        this.relativePath,
        `${header}\n${body}${rows.length ? "\n" : ""}`
      );
      return row;
    });
  }

  private async readRowsLocked(): Promise<CsvRow[]> {
    let text: string;
    try {
      text = await this.workspace.readText(this.relativePath);
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
