import { google } from "googleapis";
import type { ExtractionResult, TaskItem } from "@chief-of-staff-demo/shared";
import type { GoogleAuth } from "./oauth.js";

/**
 * Compose Google Task notes in the exact order of `createTask_` in the
 * routine's Code.gs (parity requirement):
 * Owner / item notes / Quote / Source / source URL, one per line,
 * each line present only when its value is.
 */
export function composeTaskNotes(
  item: TaskItem,
  source: Pick<ExtractionResult, "sourceFileName" | "sourceUrl">,
): string {
  const lines: string[] = [];
  if (item.owner) {
    lines.push(`Owner: ${item.owner}`);
  }
  if (item.notes) {
    lines.push(item.notes);
  }
  if (item.sourceQuote) {
    lines.push(`Quote: "${item.sourceQuote}"`);
  }
  if (source.sourceFileName) {
    lines.push(`Source: ${source.sourceFileName}`);
  }
  if (source.sourceUrl) {
    lines.push(source.sourceUrl);
  }
  return lines.join("\n");
}

/**
 * The Tasks API wants RFC 3339 but stores the DATE only. The extraction
 * contract is YYYY-MM-DD; normalize to midnight UTC (parity with createTask_).
 */
export function normalizeDue(due: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(due) ? `${due}T00:00:00Z` : due;
}

/** Find the tasklist by title or create it (parity with findOrCreateTasklist_). */
export async function findOrCreateTasklist(auth: GoogleAuth, title: string): Promise<string> {
  const tasks = google.tasks({ version: "v1", auth });
  const res = await tasks.tasklists.list();
  const items = res.data.items ?? [];
  const existing = items.find((item) => item.title === title && item.id);
  if (existing?.id) {
    return existing.id;
  }
  const created = await tasks.tasklists.insert({ requestBody: { title } });
  if (!created.data.id) {
    throw new Error(`tasklist insert returned no id for "${title}"`);
  }
  return created.data.id;
}

export interface CreatedTask {
  googleId: string;
  /** Absolute link to the task in Google's Tasks Web UI, as Google returned it. */
  webViewLink: string | null;
}

export async function createGoogleTask(
  auth: GoogleAuth,
  tasklistId: string,
  item: TaskItem,
  source: Pick<ExtractionResult, "sourceFileName" | "sourceUrl">,
): Promise<CreatedTask> {
  const tasks = google.tasks({ version: "v1", auth });
  const requestBody: Record<string, string> = {
    title: item.title,
    notes: composeTaskNotes(item, source),
  };
  if (item.due) {
    requestBody.due = normalizeDue(item.due);
  }

  const res = await tasks.tasks.insert({ tasklist: tasklistId, requestBody });
  if (!res.data.id) {
    throw new Error(`task insert returned no id for "${item.title}"`);
  }
  return { googleId: res.data.id, webViewLink: res.data.webViewLink ?? null };
}
