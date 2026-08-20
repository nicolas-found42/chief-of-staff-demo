import type { AppConfig, DraftItem, ExtractionResult, TaskItem } from "@chief-of-staff-demo/shared";
import { buildGoogleAuth, type GoogleAuth } from "./oauth.js";
import { createGmailDraft, gmailDraftInput } from "./gmail.js";
import { createGoogleTask, findOrCreateTasklist } from "./tasks.js";

/**
 * The only Google surface a Run talks to. Reached through the Google
 * connection, never built directly: whether the connection can hand one out is
 * the connection's decision to make.
 */
export interface GoogleOutputs {
  findOrCreateTasklist(title: string): Promise<string>;
  createTask(
    tasklistId: string,
    item: TaskItem,
    source: Pick<ExtractionResult, "sourceFileName" | "sourceUrl">
  ): Promise<string>;
  createDraft(draft: DraftItem): Promise<string>;
}

export function googleOutputs(config: AppConfig, port: number): GoogleOutputs {
  const auth: GoogleAuth = buildGoogleAuth(config, port);
  return {
    findOrCreateTasklist: (title: string) => findOrCreateTasklist(auth, title),
    createTask: (tasklistId: string, item: TaskItem, source: Pick<ExtractionResult, "sourceFileName" | "sourceUrl">) =>
      createGoogleTask(auth, tasklistId, item, source),
    createDraft: (draft: DraftItem) => createGmailDraft(auth, gmailDraftInput(draft)),
  };
}
