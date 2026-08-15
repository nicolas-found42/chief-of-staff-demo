import {
  LOCAL_SCOPE_SUPPLIED_WARNING,
  TRACKING_SCOPE_VALIDATION_ERROR,
  type ExtractedTask,
  type LocalTaskResource,
  type TaskListId,
} from "@chief-of-staff/contracts";
import type { WorkflowStepDef } from "./definition.js";
import type { StepAdapter, StepAdapterContext } from "./interpreter.js";
import { localUri } from "./text.js";
import type { CsvRow } from "./tracking.js";
import { stringify as yamlStringify } from "yaml";

const TASK_LIST_BY_STEP: Record<string, TaskListId> = {
  x1gstq: "email-drafts",
  "4a71s7": "business-plans",
  "8w9czb": "my-tasks",
};

const TABLE_TARGET_STEP: Record<string, string> = {
  "7b5596": "axgv0j",
  "1730yy": "kjlw70",
  pthrsh: "8w9czb",
};

/** The Drive file-added trigger: exposes the claimed source as the trigger
 * object with the stable local URI and the injected clock's timestamp. */
export const triggerAdapter: StepAdapter = {
  stepType: "drive.fileAddedToFolder",
  async execute(_step, ctx) {
    return {
      output: {
        Title: ctx.source.title,
        "File URL": localUri(`source/processing/${ctx.runId}/${ctx.source.filename}`),
        "Creation time": ctx.nowIso,
      },
      warnings: [],
    };
  },
};

/** Gmail saveAsDraft: one Markdown file per draft with YAML front matter. */
export const gmailDraftAdapter: StepAdapter = {
  stepType: "gmail.saveAsDraft",
  async execute(_step, ctx) {
    const tos = ctx.resolvedInputs["tos"];
    const recipients = Array.isArray(tos) ? tos.map(String) : [];
    const subject = String(ctx.resolvedInputs["subject"] ?? "");
    const body = String(ctx.resolvedInputs["body"] ?? "");
    const artifactId = ctx.ids.artifactId(ctx.runId, ctx.stepId, ctx.taskIndex);
    const frontMatter = yamlStringify({
      schemaVersion: 1,
      id: artifactId,
      to: recipients,
      labels: ["Inbox"],
      subject,
      runId: ctx.runId,
      taskIndex: ctx.taskIndex ?? 0,
      createdAt: ctx.nowIso,
    });
    const content = `---\n${frontMatter}---\n\n${body}`;
    const relativePath = `gmail/drafts/${artifactId}.md`;
    const byteSize = await ctx.commitFile(relativePath, content, "gmail-draft");
    const draftUrl = localUri(relativePath);
    ctx.registerArtifact({
      artifactId,
      type: "gmail-draft",
      uri: draftUrl,
      taskIndex: ctx.taskIndex,
      byteSize,
    });
    return { output: { "Draft URL": draftUrl }, warnings: [] };
  },
};

function taskListForStep(stepId: string): TaskListId {
  const list = TASK_LIST_BY_STEP[stepId];
  if (!list) {
    throw new Error(`No task list mapped for step ${stepId}`);
  }
  return list;
}

/** Google Tasks createTask: one validated task resource JSON per file. */
export const googleTasksAdapter: StepAdapter = {
  stepType: "googletasks.createTask",
  async execute(_step, ctx) {
    const title = String(ctx.resolvedInputs["title"] ?? "");
    const dueRaw = ctx.resolvedInputs["due"];
    const due = typeof dueRaw === "string" && dueRaw.trim().length > 0 ? dueRaw : null;
    const notes = String(ctx.resolvedInputs["notes"] ?? "");
    const list = taskListForStep(ctx.stepId);
    const artifactId = ctx.ids.artifactId(ctx.runId, ctx.stepId, ctx.taskIndex);
    const resource: LocalTaskResource = {
      schemaVersion: 1,
      id: artifactId,
      list,
      title,
      due,
      notes,
      status: "needsAction",
      source: {
        runId: ctx.runId,
        taskIndex: ctx.taskIndex ?? 0,
        stepId: ctx.stepId,
      },
      createdAt: ctx.nowIso,
    };
    const relativePath = `tasks/${list}/${artifactId}.json`;
    const content = `${JSON.stringify(resource, null, 2)}\n`;
    const byteSize = await ctx.commitFile(relativePath, content, "task");
    const taskUrl = localUri(relativePath);
    ctx.registerArtifact({
      artifactId,
      type: "task",
      uri: taskUrl,
      taskIndex: ctx.taskIndex,
      byteSize,
    });
    return { output: { "Task URL": taskUrl, Task: resource }, warnings: [] };
  },
};

/** Docs createDoc: one planning document per Markdown file. */
export const docsDocumentAdapter: StepAdapter = {
  stepType: "docs.createDoc",
  async execute(_step, ctx) {
    const title = String(ctx.resolvedInputs["Title"] ?? "");
    const content = String(ctx.resolvedInputs["Content"] ?? "");
    const artifactId = ctx.ids.artifactId(ctx.runId, ctx.stepId, ctx.taskIndex);
    const body = `# ${title}\n\n${content}\n`;
    const relativePath = `docs/strategy-and-planning/${artifactId}.md`;
    const byteSize = await ctx.commitFile(relativePath, body, "plan-document");
    const documentUrl = localUri(relativePath);
    ctx.registerArtifact({
      artifactId,
      type: "plan-document",
      uri: documentUrl,
      taskIndex: ctx.taskIndex,
      byteSize,
    });
    return { output: { "Document URL": documentUrl }, warnings: [] };
  },
};

/**
 * builtin.addToDataTable: the three exported table steps have no scope and no
 * column mapping, so this adapter supplies the fixed local schema. This is the
 * sole intentional repair to an invalid exported step; it is visible as the
 * LOCAL_SCOPE_SUPPLIED warning on every invocation.
 */
export const dataTableAdapter: StepAdapter = {
  stepType: "builtin.addToDataTable",
  async execute(_step: WorkflowStepDef, ctx: StepAdapterContext) {
    const task = ctx.task;
    if (!task || ctx.taskIndex === null) {
      throw new Error("Data-table step requires an iterator task context");
    }
    const targetStep = TABLE_TARGET_STEP[ctx.stepId];
    const targetOutput = ctx.resolverContext.artifacts?.get(targetStep) as
      | Record<string, unknown>
      | undefined;
    let targetUri = "";
    if (targetStep === "axgv0j") {
      targetUri = String(targetOutput?.["Draft URL"] ?? "");
    } else if (targetStep === "kjlw70") {
      targetUri = String(targetOutput?.["Document URL"] ?? "");
    } else if (targetStep === "8w9czb") {
      targetUri = String(targetOutput?.["Task URL"] ?? "");
    }
    const row: CsvRow = {
      row_id: ctx.ids.rowId(ctx.runId, ctx.taskIndex),
      run_id: ctx.runId,
      task_index: ctx.taskIndex,
      task_name: task["Task name"],
      task_type: task["Task type"],
      assigned_to: task["Assigned to"],
      deadline: task.Deadline ?? "",
      source_step: ctx.stepId,
      target_uri: targetUri,
      status: "created",
      created_at: ctx.nowIso,
      source_validation_error: TRACKING_SCOPE_VALIDATION_ERROR,
    };
    await ctx.trackingCsv.upsert(row);
    const warning = {
      code: LOCAL_SCOPE_SUPPLIED_WARNING,
      message: "The exported table step has no scope; the local adapter supplied tracking/actions.csv",
    };
    const recordUrl = localUri("tracking/actions.csv");
    ctx.registerArtifact({
      artifactId: ctx.ids.artifactId(ctx.runId, ctx.stepId, ctx.taskIndex),
      type: "tracking-csv",
      uri: recordUrl,
      taskIndex: ctx.taskIndex,
      byteSize: 0,
    });
    return {
      output: { Record: row, "Record URL": recordUrl },
      warnings: [warning],
    };
  },
};

/** builtin.sendEmailNotification: write the exported completion summary. */
export const notificationAdapter: StepAdapter = {
  stepType: "builtin.sendEmailNotification",
  async execute(_step, ctx) {
    const subject = String(ctx.resolvedInputs["subject"] ?? "");
    const body = String(ctx.resolvedInputs["body"] ?? "");
    const relativePath = `notifications/${ctx.runId}-summary.md`;
    const content = `# ${subject}\n\n${body}\n`;
    const byteSize = await ctx.commitFile(relativePath, content, "notification");
    const notificationUrl = localUri(relativePath);
    ctx.registerArtifact({
      artifactId: `${ctx.runId}-summary`,
      type: "notification",
      uri: notificationUrl,
      taskIndex: null,
      byteSize,
    });
    return { output: { "Notification URL": notificationUrl }, warnings: [] };
  },
};

export const LOCAL_ADAPTERS: readonly StepAdapter[] = [
  triggerAdapter,
  gmailDraftAdapter,
  googleTasksAdapter,
  docsDocumentAdapter,
  dataTableAdapter,
  notificationAdapter,
];

export function buildAdapterRegistry(
  extras: ReadonlyArray<StepAdapter> = []
): ReadonlyMap<string, StepAdapter> {
  const registry = new Map<string, StepAdapter>();
  for (const adapter of [...LOCAL_ADAPTERS, ...extras]) {
    registry.set(adapter.stepType, adapter);
  }
  return registry;
}

export type { ExtractedTask };
