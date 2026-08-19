import type { AppConfig, DraftItem, ExtractionResult, TaskItem } from "@chief-of-staff-demo/shared";
import { googleConnected as isConnected } from "../config.js";
import { buildGoogleAuth, type GoogleAuth } from "./oauth.js";
import { createGmailDraft, gmailDraftInput } from "./gmail.js";
import { createGoogleTask, findOrCreateTasklist } from "./tasks.js";

/**
 * The only Google surface the pipeline talks to. `null` when Google is not
 * connected (missing client credentials or refresh token).
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

export function googleConnected(config: AppConfig): boolean {
  return isConnected(config);
}

export function googleOutputsFor(config: AppConfig, port: number): GoogleOutputs | null {
  if (!googleConnected(config)) {
    return null;
  }
  const auth: GoogleAuth = buildGoogleAuth(config, port);
  return {
    findOrCreateTasklist: (title: string) => findOrCreateTasklist(auth, title),
    createTask: (tasklistId: string, item: TaskItem, source: Pick<ExtractionResult, "sourceFileName" | "sourceUrl">) =>
      createGoogleTask(auth, tasklistId, item, source),
    createDraft: (draft: DraftItem) => createGmailDraft(auth, gmailDraftInput(draft)),
  };
}
