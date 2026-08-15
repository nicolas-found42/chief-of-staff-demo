import { Type, type TSchema } from "typebox";
import type {
  AppConfig,
  CalendarEvents,
  ExtractedTask,
  LocalTaskResource,
  ModelsConfig,
  ProfileConfig,
  StepArtifact,
} from "./types.js";

/** Runtime schema for the exported `eitxht.userSchema`, kept in sync with
 * reference/workflow-definition.json. */
export const ExtractedTaskSchema = Type.Object(
  {
    "Task name": Type.String(),
    "Task type": Type.Union([
      Type.Literal("email"),
      Type.Literal("business plan"),
      Type.Literal("other"),
    ]),
    "Assigned to": Type.String(),
    Deadline: Type.Optional(Type.String({ format: "date-time" })),
    "Email details": Type.Optional(
      Type.Object({
        Recipient: Type.String(),
        Subject: Type.String(),
        Body: Type.String(),
      })
    ),
    "Business plan details": Type.Optional(
      Type.Object({
        Title: Type.String(),
        Summary: Type.String(),
      })
    ),
    "Task description": Type.Optional(Type.String()),
  },
  { title: "Response" }
);

export const ExtractedTasksSchema = Type.Array(ExtractedTaskSchema, {
  title: "Responses",
});

export const ProfileConfigSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  company: Type.String({ minLength: 1 }),
  writingStyle: Type.String({ minLength: 1 }),
  focusAreas: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
});

export const ModelsConfigSchema = Type.Object({
  provider: Type.Literal("openrouter"),
  model: Type.String({ minLength: 1 }),
  reasoningEffort: Type.Union([
    Type.Null(),
    Type.Literal("MINIMAL"),
    Type.Literal("LOW"),
    Type.Literal("MEDIUM"),
    Type.Literal("HIGH"),
  ]),
  maxOutputTokens: Type.Union([Type.Null(), Type.Number({ minimum: 1 })]),
});

export const AppConfigSchema = Type.Object({
  maxParallelTasks: Type.Integer({ minimum: 1, maximum: 64 }),
  watchDebounceMs: Type.Integer({ minimum: 0 }),
  maxTranscriptBytes: Type.Integer({ minimum: 1 }),
  allowedUiOrigins: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
});

export const CalendarEventSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  start: Type.String({ format: "date-time" }),
  end: Type.String({ format: "date-time" }),
  summary: Type.String(),
  status: Type.Union([
    Type.Literal("busy"),
    Type.Literal("tentative"),
    Type.Literal("free"),
  ]),
});

export const CalendarEventsSchema = Type.Object({
  timezone: Type.String({ minLength: 1 }),
  events: Type.Array(CalendarEventSchema),
});

export const LocalTaskResourceSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  id: Type.String({ minLength: 1 }),
  list: Type.Union([
    Type.Literal("email-drafts"),
    Type.Literal("business-plans"),
    Type.Literal("my-tasks"),
  ]),
  title: Type.String(),
  due: Type.Union([Type.Null(), Type.String({ format: "date-time" })]),
  notes: Type.String(),
  status: Type.Literal("needsAction"),
  source: Type.Object({
    runId: Type.String({ minLength: 1 }),
    taskIndex: Type.Number({ minimum: 0 }),
    stepId: Type.String({ minLength: 1 }),
  }),
  createdAt: Type.String({ format: "date-time" }),
});

export const StepArtifactSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  runId: Type.String(),
  stepId: Type.String(),
  invocationId: Type.String(),
  taskIndex: Type.Union([Type.Null(), Type.Number()]),
  status: Type.Union([
    Type.Literal("succeeded"),
    Type.Literal("failed"),
    Type.Literal("skipped"),
  ]),
  startedAt: Type.String(),
  finishedAt: Type.String(),
  output: Type.Unknown(),
  warnings: Type.Array(
    Type.Object({
      code: Type.String(),
      message: Type.String(),
    })
  ),
  error: Type.Union([
    Type.Null(),
    Type.Object({
      code: Type.String(),
      message: Type.String(),
      retryable: Type.Boolean(),
    }),
  ]),
});

/** Branch invariants from the specification, section 11.1. */
export interface BranchValidation {
  valid: boolean;
  errors: string[];
}

export function validateBranchInvariants(task: unknown): BranchValidation {
  if (typeof task !== "object" || task === null) {
    return { valid: false, errors: ["task is not an object"] };
  }
  const t = task as ExtractedTask;
  const errors: string[] = [];
  const name = t["Task name"];
  if (typeof name !== "string" || name.trim().length === 0) {
    errors.push("Task name is empty");
  } else if (Array.from(name).length > 50) {
    errors.push("Task name is longer than 50 code points");
  }
  const type = t["Task type"];
  if (type === "email") {
    const d = t["Email details"];
    if (
      typeof d !== "object" ||
      d === null ||
      typeof d.Recipient !== "string" ||
      typeof d.Subject !== "string" ||
      typeof d.Body !== "string"
    ) {
      errors.push("email task must include complete Email details");
    }
  } else if (type === "business plan") {
    const d = t["Business plan details"];
    if (
      typeof d !== "object" ||
      d === null ||
      typeof d.Title !== "string" ||
      typeof d.Summary !== "string"
    ) {
      errors.push("business plan task must include complete Business plan details");
    }
  } else if (type === "other") {
    if (typeof t["Task description"] !== "string" || t["Task description"].trim().length === 0) {
      errors.push("other task must include Task description");
    }
  }
  const deadline = t.Deadline;
  if (typeof deadline === "string" && deadline.trim().length > 0) {
    if (Number.isNaN(Date.parse(deadline))) {
      errors.push("Deadline must parse as an ISO 8601 date-time");
    }
  }
  return { valid: errors.length === 0, errors };
}

export type { AppConfig, CalendarEvents, ExtractedTask, LocalTaskResource, ModelsConfig, ProfileConfig, StepArtifact };
export type ExtractedTasks = ExtractedTask[];
export { Type };
export type { TSchema };
