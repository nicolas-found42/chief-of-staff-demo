import type {
  AppConfig,
  ArtifactType,
  ExtractedTask,
  LlmMode,
  ModelsConfig,
  ProfileConfig,
  RunManifest,
  StepError,
  StepWarning,
  UsageSummary,
} from "@chief-of-staff/contracts";
import type { SpanAttributes, TelemetryContext, TelemetrySpan } from "@earendil-works/pi-telemetry";
import type { WorkflowDefinition, WorkflowPathRuleNode, WorkflowStepDef, WorkflowThreadDef } from "./definition.js";
import { getIteratorParameterSchema, getIteratorTargetThread, getStep, getThread } from "./definition.js";
import { WorkflowError, toWorkflowError } from "./errors.js";
import { EventSink } from "./events.js";
import { bytesEqual, sha256Hex, utf8ByteLength, utf8Bytes } from "./crypto.js";
import type { IdGenerator } from "./ids.js";
import {
  addArtifact,
  addStepRecord,
  addUsage,
  addWarning,
  artifactToStepArtifact,
  createManifest,
  toStepError,
  writeManifestFile,
} from "./manifest.js";
import { ReferenceResolver, type ResolverContext } from "./resolver.js";
import { TrackingCsv } from "./tracking.js";
import { substituteProfileStrict } from "./profile.js";
import type { Workspace } from "./workspace.js";
export interface RunSourceInfo {
  /** Original file name including extension. */
  filename: string;
  /** File name without extension (the trigger Title). */
  title: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  stat: { birthtimeMs: number; mtimeMs: number; ctimeMs: number };
}

export interface RunInput {
  runId: string;
  source: RunSourceInfo;
  transcriptText: string;
  transcriptSha256: string;
  /** Present when resuming a run; prior successful invocations are reused. */
  resumeFrom?: RunManifest;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const noopLogger: Logger = {
  info() {},
  warn() {},
  error() {},
};

export interface AiInvokeContext {
  runId: string;
  stepId: string;
  invocationId: string;
  taskIndex: number | null;
  task: ExtractedTask | null;
  kind: "extract" | "email" | "plan";
  promptText: string;
  transcriptText: string;
  modelId: string;
  signal: AbortSignal;
  ids: IdGenerator;
  clock: () => Date;
  mode: LlmMode;
  workspace: Workspace;
  events: EventSink;
  logger: Logger;
  /** Redacted progress callback (kind + label only). */
  onProgress: (kind: "thinking" | "text" | "tool_call", label: string) => void;
  /** Start the pi AI/agent span under the current step span. */
  startAiSpan: (
    retryCount: number,
    callback: (span: TelemetrySpan) => Promise<AiInvokeResult>
  ) => Promise<AiInvokeResult>;
}

export interface AiInvokeResult {
  output: unknown;
  usage: UsageSummary;
  warnings: StepWarning[];
  retryCount: number;
}

export interface AiInvoker {
  invoke(ctx: AiInvokeContext): Promise<AiInvokeResult>;
}

export interface StepAdapterContext {
  runId: string;
  stepId: string;
  invocationId: string;
  taskIndex: number | null;
  task: ExtractedTask | null;
  resolver: ReferenceResolver;
  resolverContext: ResolverContext;
  resolvedInputs: Record<string, unknown>;
  nowIso: string;
  profile: ProfileConfig;
  source: RunSourceInfo;
  transcriptText: string;
  workspace: Workspace;
  ids: IdGenerator;
  signal: AbortSignal;
  logger: Logger;
  /**
   * Idempotent verified commit: writes the artifact if absent, reuses it when
   * byte-identical, and fails with IDEMPOTENCY_CONFLICT when it differs.
   */
  commitFile: (
    relativePath: string,
    content: Uint8Array | string,
    artifactType: ArtifactType
  ) => Promise<number>;
  registerArtifact: (artifact: {
    artifactId: string;
    type: ArtifactType;
    uri: string;
    taskIndex: number | null;
    byteSize: number;
  }) => void;
  trackingCsv: TrackingCsv;
}

export interface StepAdapter {
  readonly stepType: string;
  execute(
    step: WorkflowStepDef,
    ctx: StepAdapterContext
  ): Promise<{ output: unknown; warnings: StepWarning[] }>;
}

export interface EngineServices {
  workspace: Workspace;
  ids: IdGenerator;
  clock: () => Date;
  telemetry: TelemetryContext;
  adapters: ReadonlyMap<string, StepAdapter>;
  ai: AiInvoker;
  profile: ProfileConfig;
  models: ModelsConfig;
  app: AppConfig;
  mode: LlmMode;
  signal: AbortSignal;
  timezone: string;
  definition: WorkflowDefinition;
  definitionSha256: string;
  definitionPath: string;
  logger: Logger;
}

interface Scope {
  ctx: ResolverContext;
}

interface StepOutcome {
  output: unknown;
  warnings: StepWarning[];
  usage?: UsageSummary;
  invocationId: string;
  startedAt: string;
  finishedAt: string;
  retryCount: number;
}

interface RunState {
  manifest: RunManifest;
  events: EventSink;
  resolver: ReferenceResolver;
  nowIso: string;
}

const AI_STEP_TYPES = new Set(["ai.prompt.object", "ai.prompt.text"]);
const TASK_STEP_IDS = new Set(["x1gstq", "4a71s7", "8w9czb"]);
const TABLE_STEP_IDS = new Set(["7b5596", "1730yy", "pthrsh"]);

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new WorkflowError("RUN_CANCELLED", "The run was cancelled");
  }
}
const STEP_MANIFEST_ORDER: Record<string, number> = {
  trigger: 0,
  eitxht: 1,
  yk5itn: 2,
  ou028y: 3,
  maoa1p: 4,
  axgv0j: 5,
  x1gstq: 6,
  "7b5596": 7,
  ia2vvr: 8,
  kjlw70: 9,
  "4a71s7": 10,
  "1730yy": 11,
  "8w9czb": 12,
  pthrsh: 13,
  aase0r: 14,
};
interface RunState {
  manifest: RunManifest;
  events: EventSink;
  resolver: ReferenceResolver;
  nowIso: string;
  trackingCsv: TrackingCsv;
}

export async function runWorkflow(
  services: EngineServices,
  input: RunInput
): Promise<RunManifest> {
  const workspace = services.workspace;
  const nowIso = services.clock().toISOString();
  const configSha = {
    profile: sha256Hex(`${JSON.stringify(services.profile)}\n`),
    models: sha256Hex(`${JSON.stringify(services.models)}\n`),
  };

function normalizeInputText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

  const state: RunState = {
    manifest: createManifest({
      runId: input.runId,
      workflow: {
        path: services.definitionPath,
        revision: services.definition.revision,
        sha256: services.definitionSha256,
      },
      source: {
        filename: input.source.filename,
        mimeType: input.source.mimeType,
        byteSize: input.source.byteSize,
        sha256: input.source.sha256,
        timestamps: {
          claimedAt: nowIso,
          birthtimeMs: input.source.stat.birthtimeMs,
          mtimeMs: input.source.stat.mtimeMs,
          ctimeMs: input.source.stat.ctimeMs,
        },
      },
      transcriptSha256: input.transcriptSha256,
      configSha256: configSha,
      now: nowIso,
      timezone: services.timezone,
      llm: { mode: services.mode, model: services.models.model },
    }),
    events: new EventSink(workspace, `runs/${input.runId}/events.jsonl`, services.clock),
    resolver: new ReferenceResolver(getIteratorParameterSchema(services.definition)),
    nowIso,
    trackingCsv: new TrackingCsv(workspace, "tracking/actions.csv"),
  };

  // Input snapshot (section 12 step 7): normalized transcript plus source
  // metadata. The original bytes stay under source/.
  const normalizedTranscript = normalizeInputText(input.transcriptText);
  await workspace.writeText(
    `runs/${input.runId}/input/transcript.txt`,
    normalizedTranscript
  );
  const sourceMetadata = {
    schemaVersion: 1,
    runId: input.runId,
    source: {
      filename: input.source.filename,
      mimeType: input.source.mimeType,
      byteSize: input.source.byteSize,
      sha256: input.source.sha256,
      timestamps: {
        claimedAt: nowIso,
        birthtimeMs: input.source.stat.birthtimeMs,
        mtimeMs: input.source.stat.mtimeMs,
        ctimeMs: input.source.stat.ctimeMs,
      },
    },
  };
  await workspace.writeText(
    `runs/${input.runId}/input/source-metadata.json`,
    `${JSON.stringify(sourceMetadata, null, 2)}\n`
  );
  addArtifact(state.manifest, {
    artifactId: services.ids.artifactId(input.runId, "input-transcript", null),
    type: "transcript",
    uri: `local://runs/${input.runId}/input/transcript.txt`,
    taskIndex: null,
    byteSize: utf8ByteLength(normalizedTranscript),
  });
  await writeManifestFile(workspace, `runs/${input.runId}/manifest.json`, state.manifest);
  await state.events.emit({ runId: input.runId, type: "run.started" });

  const scope: Scope = {
    ctx: {
      artifacts: new Map<string, unknown>(),
      system: { now: nowIso },
    },
  };

  let finalStatus: "succeeded" | "failed" | "cancelled" = "succeeded";
  let finalError: StepError | null = null;

  try {
    await services.telemetry.startSpan(
      {
        name: "chief_of_staff.run",
        attributes: {
          "chief_of_staff.run_id": input.runId,
          "chief_of_staff.mode": services.mode,
          "chief_of_staff.model_id": services.models.model,
          "chief_of_staff.provider": services.models.provider,
        },
      },
      async (runSpan) => {
        const mainThread = getThread(services.definition, "main");
        for (const step of mainThread.steps) {
          throwIfAborted(services.signal);
          if (step.stepId === "yk5itn") {
            await executeIterator(services, input, state, scope, step, runSpan);
            continue;
          }
          const outcome = await executeStep(
            services,
            input,
            state,
            scope,
            step,
            null,
            runSpan
          );
          if (step.stepId === "trigger") {
            scope.ctx.trigger = outcome.output as Record<string, unknown>;
          }
          if (step.stepId === "eitxht" && Array.isArray(outcome.output)) {
            // Extraction output is filtered by assignment here.
            const accepted = filterAssigned(outcome.output, services.profile.name);
            const discarded = outcome.output.length - accepted.length;
            if (discarded > 0) {
              state.manifest.discardedTasks = discarded;
              await state.events.emit({
                runId: input.runId,
                type: "task.discarded",
                stepId: "eitxht",
                data: { count: discarded },
              });
            }
            scope.ctx.eitxht = accepted;
            for (const [index, rawTask] of accepted.entries()) {
              const extracted = rawTask as ExtractedTask;
              await state.events.emit({
                runId: input.runId,
                type: "task.accepted",
                stepId: "eitxht",
                taskIndex: index,
                taskType: extracted["Task type"],
              });
            }
          }
        }
        runSpan.setStatus({ status: "ok" });
        runSpan.setAttributes({
          "chief_of_staff.status": "succeeded",
          "chief_of_staff.discarded_tasks": state.manifest.discardedTasks,
          "chief_of_staff.accepted_tasks": (scope.ctx.eitxht ?? []).length,
        });
      }
    );
  } catch (error) {
    const workflowError = toWorkflowError(error);
    if (workflowError.code === "RUN_CANCELLED") {
      finalStatus = "cancelled";
    } else {
      finalStatus = "failed";
    }
    finalError = toStepError(workflowError);
    state.manifest.error = finalError;
  }

  state.manifest.status = finalStatus;
  state.manifest.tasks = (scope.ctx.eitxht ?? []).map((task, index) => {
    const extracted = task as ExtractedTask;
    return {
      index,
      name: extracted["Task name"],
      type: extracted["Task type"],
      branch: branchForTaskType(extracted["Task type"]),
      deadline: extracted.Deadline ?? null,
    };
  });
  state.manifest.unresolvedRefs = [...new Set(state.manifest.unresolvedRefs)];
  // Parallel iterations complete in racy order; record steps and artifacts in
  // deterministic topological order so repeated runs produce identical files.
  state.manifest.steps.sort((a, b) => {
    const orderA = STEP_MANIFEST_ORDER[a.stepId] ?? 100;
    const orderB = STEP_MANIFEST_ORDER[b.stepId] ?? 100;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return (a.taskIndex ?? -1) - (b.taskIndex ?? -1);
  });
  state.manifest.artifacts.sort((a, b) => {
    const byUri = a.uri.localeCompare(b.uri);
    if (byUri !== 0) {
      return byUri;
    }
    const byTask = (a.taskIndex ?? -1) - (b.taskIndex ?? -1);
    if (byTask !== 0) {
      return byTask;
    }
    const byType = a.type.localeCompare(b.type);
    if (byType !== 0) {
      return byType;
    }
    return a.artifactId.localeCompare(b.artifactId);
  });
  await writeManifestFile(workspace, `runs/${input.runId}/manifest.json`, state.manifest);
  await state.events.emit({
    runId: input.runId,
    type: "run.finished",
    data: { status: finalStatus },
    ...(finalError ? { error: finalError } : {}),
  });
  return state.manifest;
}

function filterAssigned(tasks: unknown[], configuredName: string): unknown[] {
  const expected = configuredName.trim().toLowerCase();
  return tasks.filter((task) => {
    if (typeof task !== "object" || task === null) {
      return false;
    }
    const assigned = (task as Record<string, unknown>)["Assigned to"];
    return typeof assigned === "string" && assigned.trim().toLowerCase() === expected;
  });
}


function branchForTaskType(type: string): string {
  if (type === "email") {
    return "ou028y_xg63bi";
  }
  if (type === "business plan") {
    return "ou028y_vd3vc1";
  }
  return "ou028y_wtnzhv";
}

async function executeStep(
  services: EngineServices,
  input: RunInput,
  state: RunState,
  scope: Scope,
  step: WorkflowStepDef,
  taskIndex: number | null,
  parentSpan: TelemetrySpan
): Promise<StepOutcome> {
  const task =
    taskIndex === null
      ? null
      : ((scope.ctx.eitxht?.[taskIndex] as ExtractedTask | undefined) ?? null);
  const invocationId = services.ids.invocationId(input.runId, step.stepId, taskIndex, 0);
  const startedAt = services.clock().toISOString();

  // Resume: reuse a prior successful invocation verbatim when its artifact
  // still exists at the deterministic path.
  const artifactRel =
    taskIndex === null
      ? `runs/${input.runId}/steps/${step.stepId}.json`
      : `runs/${input.runId}/steps/${step.stepId}/${String(taskIndex).padStart(4, "0")}.json`;
  const priorRecord = input.resumeFrom?.steps.find(
    (record) =>
      record.stepId === step.stepId &&
      record.taskIndex === taskIndex &&
      record.status === "succeeded"
  );
  if (priorRecord && (await services.workspace.exists(artifactRel))) {
    const priorArtifact = JSON.parse(
      await services.workspace.readText(artifactRel)
    ) as { output?: unknown; invocationId?: string; startedAt?: string; finishedAt?: string; retryCount?: number };
    scope.ctx.artifacts?.set(step.stepId, priorArtifact.output);
    if (step.stepId === "trigger") {
      scope.ctx.trigger = priorArtifact.output as Record<string, unknown>;
    }
    if (step.stepId === "eitxht" && Array.isArray(priorArtifact.output)) {
      const accepted = filterAssigned(priorArtifact.output, services.profile.name);
      scope.ctx.eitxht = accepted;
      state.manifest.discardedTasks = priorArtifact.output.length - accepted.length;
    }
    addStepRecord(state.manifest, { ...priorRecord });
    await state.events.emit({
      runId: input.runId,
      type: "step.skipped",
      stepId: step.stepId,
      invocationId: priorArtifact.invocationId ?? priorRecord.invocationId,
      taskIndex,
    });
    return {
      output: priorArtifact.output ?? null,
      warnings: priorRecord.warnings,
      usage: priorRecord.usage,
      invocationId: priorRecord.invocationId,
      startedAt: priorArtifact.startedAt ?? priorRecord.startedAt,
      finishedAt: priorArtifact.finishedAt ?? priorRecord.finishedAt,
      retryCount: priorArtifact.retryCount ?? priorRecord.retryCount,
    };
  }

  const stepAttributes: SpanAttributes = {
    "chief_of_staff.run_id": input.runId,
    "chief_of_staff.step_id": step.stepId,
    "chief_of_staff.invocation_id": invocationId,
  };
  if (taskIndex !== null) {
    stepAttributes["chief_of_staff.task_index"] = taskIndex;
  }
  if (task) {
    stepAttributes["chief_of_staff.task_type"] = task["Task type"];
  }

  await state.events.emit({
    runId: input.runId,
    type: "step.started",
    stepId: step.stepId,
    invocationId,
    taskIndex,
    taskType: task?.["Task type"],
  });

  try {
    return await parentSpan.startSpan(
      { name: "chief_of_staff.step", attributes: stepAttributes },
      async (stepSpan): Promise<StepOutcome> => {
        let outcome: StepOutcome;
        if (AI_STEP_TYPES.has(step.stepType)) {
          outcome = await executeAiStep(
            services,
            input,
            state,
            scope,
            step,
            taskIndex,
            task,
            invocationId,
            startedAt,
            stepSpan
          );
        } else {
          outcome = await executeAdapterStep(
            services,
            input,
            state,
            scope,
            step,
            taskIndex,
            task,
            invocationId,
            startedAt,
            stepSpan
          );
        }

        stepSpan.setStatus({ status: "ok" });
        const endAttributes: SpanAttributes = {
          "chief_of_staff.status": "succeeded",
        };
        if (outcome.usage) {
          endAttributes["chief_of_staff.input_tokens"] = outcome.usage.input;
          endAttributes["chief_of_staff.output_tokens"] = outcome.usage.output;
          endAttributes["chief_of_staff.total_tokens"] = outcome.usage.totalTokens;
        }
        stepSpan.setAttributes(endAttributes);
        await state.events.emit({
          runId: input.runId,
          type: "step.succeeded",
          stepId: step.stepId,
          invocationId: outcome.invocationId,
          taskIndex,
          taskType: task?.["Task type"],
        });
        return outcome;
      }
    );
  } catch (error) {
    const workflowError = toWorkflowError(error);
    const stepError = toStepError(workflowError);
    if (workflowError.code === "UNRESOLVED_REFERENCE") {
      state.manifest.unresolvedRefs.push(workflowError.message);
    }
    await state.events.emit({
      runId: input.runId,
      type: "step.failed",
      stepId: step.stepId,
      invocationId,
      taskIndex,
      taskType: task?.["Task type"],
      error: stepError,
    });
    await writeStepArtifact(
      services,
      state,
      input,
      step,
      taskIndex,
      invocationId,
      startedAt,
      services.clock().toISOString(),
      "failed",
      null,
      [],
      stepError,
      0,
      undefined
    );
    throw workflowError;
  }
}

async function executeAiStep(
  services: EngineServices,
  input: RunInput,
  state: RunState,
  scope: Scope,
  step: WorkflowStepDef,
  taskIndex: number | null,
  task: ExtractedTask | null,
  invocationId: string,
  startedAt: string,
  stepSpan: TelemetrySpan
): Promise<StepOutcome> {
  const promptInput = step.inputs.find((i) => i.input === "prompt");
  const promptTemplate = typeof promptInput?.value === "string" ? promptInput.value : "";
  // Section 13.3: profile placeholders are replaced before template
  // resolution; leftover placeholders reject the run.
  const substituted = substituteProfileStrict(promptTemplate, services.profile);
  const promptText = state.resolver.render(substituted, scope.ctx, step.stepId);
  const kind: "extract" | "email" | "plan" =
    step.stepId === "eitxht" ? "extract" : step.stepId === "maoa1p" ? "email" : "plan";

  const result = await services.ai.invoke({
    runId: input.runId,
    stepId: step.stepId,
    invocationId,
    taskIndex,
    task,
    kind,
    promptText,
    transcriptText: input.transcriptText,
    modelId: services.models.model,
    signal: services.signal,
    ids: services.ids,
    clock: services.clock,
    mode: services.mode,
    workspace: services.workspace,
    events: state.events,
    logger: services.logger,
    onProgress: (progressKind, label) => {
      void state.events.emit({
        runId: input.runId,
        type: "progress",
        stepId: step.stepId,
        invocationId,
        taskIndex,
        data: { kind: progressKind, label },
      });
    },
    startAiSpan: (retryCount, callback) =>
      stepSpan.startSpan(
        {
          name: "chief_of_staff.ai_invocation",
          attributes: {
            "chief_of_staff.run_id": input.runId,
            "chief_of_staff.step_id": step.stepId,
            "chief_of_staff.invocation_id": invocationId,
            ...(taskIndex !== null ? { "chief_of_staff.task_index": taskIndex } : {}),
            "chief_of_staff.provider": services.models.provider,
            "chief_of_staff.model_id": services.models.model,
            "chief_of_staff.retry_count": retryCount,
          },
        },
        callback
      ),
  });

  const finalInvocationId = services.ids.invocationId(
    input.runId,
    step.stepId,
    taskIndex,
    result.retryCount
  );
  const finishedAt = services.clock().toISOString();
  const output = result.output;
  scope.ctx.artifacts?.set(step.stepId, output);

  const warnings = [...result.warnings];
  if (step.stepType === "ai.prompt.text") {
    const message = (output as { message?: string } | undefined)?.message ?? "";
    if (kind === "email") {
      if (message.includes("\u2014")) {
        warnings.push({
          code: "EMAIL_EM_DASH",
          message: "The draft contains an em dash, which the original prompt forbids",
        });
      }
      if (/\b(Best|Thanks|Regards|Sincerely|Kind regards)[,]?\s*$/im.test(message.trim())) {
        warnings.push({
          code: "EMAIL_SIGNOFF",
          message: "The draft ends with a probable sign-off, which the original prompt forbids",
        });
      }
    }
    if (kind === "plan" && message.split(/\s+/).filter((word) => word.length > 0).length > 1000) {
      warnings.push({
        code: "PLAN_WORD_LIMIT_EXCEEDED",
        message: "The plan draft exceeds 1,000 words; the original prompt asked to keep it under 1,000",
      });
    }
  }

  if (result.usage) {
    addUsage(state.manifest, result.usage);
  }
  for (const warning of warnings) {
    addWarning(state.manifest, warning);
  }

  await writeStepArtifact(
    services,
    state,
    input,
    step,
    taskIndex,
    finalInvocationId,
    startedAt,
    finishedAt,
    "succeeded",
    output,
    warnings,
    null,
    result.retryCount,
    result.usage
  );
  return {
    output,
    warnings,
    usage: result.usage,
    invocationId: finalInvocationId,
    startedAt,
    finishedAt,
    retryCount: result.retryCount,
  };
}

async function executeAdapterStep(
  services: EngineServices,
  input: RunInput,
  state: RunState,
  scope: Scope,
  step: WorkflowStepDef,
  taskIndex: number | null,
  task: ExtractedTask | null,
  invocationId: string,
  startedAt: string,
  stepSpan: TelemetrySpan
): Promise<StepOutcome> {
  const adapter = services.adapters.get(step.stepType);
  if (!adapter) {
    throw new WorkflowError(
      "WORKFLOW_DEFINITION_CHANGED",
      `No adapter registered for step type ${step.stepType}`
    );
  }

  const resolvedInputs = state.resolver.resolveInputs(step.inputs, scope.ctx, step.stepId);
  const commitFile = async (
    relativePath: string,
    content: Uint8Array | string,
    artifactType: ArtifactType
  ): Promise<number> => {
    const bytes =
      typeof content === "string" ? utf8Bytes(content) : content;
    return stepSpan.startSpan(
      {
        name: "chief_of_staff.filesystem_commit",
        attributes: {
          "chief_of_staff.run_id": input.runId,
          "chief_of_staff.step_id": step.stepId,
          "chief_of_staff.invocation_id": invocationId,
          "chief_of_staff.artifact_type": artifactType,
          "chief_of_staff.byte_count": bytes.byteLength,
        },
      },
      async (commitSpan) => {
        const exists = await services.workspace.exists(relativePath);
        if (exists) {
          const existing = await services.workspace.readBytes(relativePath);
          const identical =
            existing.byteLength === bytes.byteLength &&
            bytesEqual(existing, bytes);
          if (identical) {
            commitSpan.setStatus({ status: "ok" });
            return bytes.byteLength;
          }
          throw new WorkflowError(
            "IDEMPOTENCY_CONFLICT",
            `Existing artifact differs from the deterministic output; refusing to overwrite: ${relativePath}`
          );
        }
        await services.workspace.writeBytes(relativePath, bytes);
        commitSpan.setStatus({ status: "ok" });
        return bytes.byteLength;
      }
    );
  };

  const { output, warnings } = await adapter.execute(step, {
    runId: input.runId,
    stepId: step.stepId,
    invocationId,
    taskIndex,
    task,
    resolver: state.resolver,
    resolverContext: scope.ctx,
    resolvedInputs,
    nowIso: state.nowIso,
    profile: services.profile,
    source: input.source,
    transcriptText: input.transcriptText,
    workspace: services.workspace,
    ids: services.ids,
    signal: services.signal,
    trackingCsv: state.trackingCsv,
    logger: services.logger,
    commitFile,
    registerArtifact: (artifact) => {
      addArtifact(state.manifest, {
        artifactId: artifact.artifactId,
        type: artifact.type,
        uri: artifact.uri,
        taskIndex: artifact.taskIndex,
        byteSize: artifact.byteSize,
      });
    },
  });

  const finishedAt = services.clock().toISOString();
  for (const warning of warnings) {
    addWarning(state.manifest, warning);
  }
  scope.ctx.artifacts?.set(step.stepId, output);
  await writeStepArtifact(
    services,
    state,
    input,
    step,
    taskIndex,
    invocationId,
    startedAt,
    finishedAt,
    "succeeded",
    output,
    warnings,
    null,
    0,
    undefined
  );
  return {
    output,
    warnings,
    invocationId,
    startedAt,
    finishedAt,
    retryCount: 0,
  };
}

async function executeIterator(
  services: EngineServices,
  input: RunInput,
  state: RunState,
  scope: Scope,
  iteratorStep: WorkflowStepDef,
  runSpan: TelemetrySpan
): Promise<void> {
  const tasks = (scope.ctx.eitxht ?? []) as ExtractedTask[];
  const iteratorThread = getIteratorTargetThread(services.definition, iteratorStep);
  const pathsStep = iteratorThread.steps.find((s) => s.stepId === "ou028y");
  if (!pathsStep) {
    throw new WorkflowError(
      "WORKFLOW_DEFINITION_CHANGED",
      "Iterator thread is missing the paths step"
    );
  }
  const iteratorInvocationId = services.ids.invocationId(
    input.runId,
    iteratorStep.stepId,
    null,
    0
  );
  const iteratorStartedAt = services.clock().toISOString();

  await state.events.emit({
    runId: input.runId,
    type: "step.started",
    stepId: iteratorStep.stepId,
    invocationId: iteratorInvocationId,
  });

  const results: Array<unknown | null> = new Array(tasks.length).fill(null);
  const failures: WorkflowError[] = [];
  const workers = Math.min(Math.max(1, services.app.maxParallelTasks), tasks.length);
  let nextTask = 0;

  try {
    await runSpan.startSpan(
      {
        name: "chief_of_staff.step",
        attributes: {
          "chief_of_staff.run_id": input.runId,
          "chief_of_staff.step_id": iteratorStep.stepId,
          "chief_of_staff.invocation_id": iteratorInvocationId,
        },
      },
      async (iteratorSpan) => {
        const worker = async (): Promise<void> => {
          for (;;) {
            throwIfAborted(services.signal);
            const index = nextTask;
            nextTask += 1;
            if (index >= tasks.length) {
              return;
            }
            try {
              results[index] = await runIteration(
                services,
                input,
                state,
                scope,
                pathsStep,
                iteratorThread,
                index,
                tasks[index],
                runSpan
              );
            } catch (error) {
              const workflowError = toWorkflowError(error);
              if (workflowError.code === "RUN_CANCELLED") {
                throw workflowError;
              }
              failures.push(workflowError);
            }
          }
        };
        await Promise.all(Array.from({ length: workers }, () => worker()));
        if (failures.length > 0) {
          iteratorSpan.setStatus({
            status: "error",
            error: {
              name: failures[0].code,
              message: failures[0].message,
            },
          });
          return;
        }
        iteratorSpan.setStatus({ status: "ok" });
      }
    );
  } catch (error) {
    const workflowError = toWorkflowError(error);
    await state.events.emit({
      runId: input.runId,
      type: "step.failed",
      stepId: iteratorStep.stepId,
      invocationId: iteratorInvocationId,
      error: toStepError(workflowError),
    });
    throw workflowError;
  }

  if (failures.length > 0) {
    const first = failures[0];
    await state.events.emit({
      runId: input.runId,
      type: "step.failed",
      stepId: iteratorStep.stepId,
      invocationId: iteratorInvocationId,
      error: toStepError(first),
    });
    await writeStepArtifact(
      services,
      state,
      input,
      iteratorStep,
      null,
      iteratorInvocationId,
      iteratorStartedAt,
      services.clock().toISOString(),
      "failed",
      null,
      [],
      toStepError(first),
      0,
      undefined
    );
    throw first;
  }

  // Aggregate in extraction order, never completion order.
  const aggregate = results.map((record) => {
    if (record === null || typeof record !== "object") {
      return {};
    }
    const r = record as Record<string, unknown>;
    return typeof r.Record === "object" && r.Record !== null ? { ...(r.Record as object) } : {};
  });
  const output = { agg_ou028y: aggregate };
  await writeStepArtifact(
    services,
    state,
    input,
    iteratorStep,
    null,
    iteratorInvocationId,
    iteratorStartedAt,
    services.clock().toISOString(),
    "succeeded",
    output,
    [],
    null,
    0,
    undefined
  );
  scope.ctx.artifacts?.set(iteratorStep.stepId, output);
  await state.events.emit({
    runId: input.runId,
    type: "step.succeeded",
    stepId: iteratorStep.stepId,
    invocationId: iteratorInvocationId,
  });
}

async function runIteration(
  services: EngineServices,
  input: RunInput,
  state: RunState,
  scope: Scope,
  pathsStep: WorkflowStepDef,
  iteratorThread: WorkflowThreadDef,
  taskIndex: number,
  task: ExtractedTask,
  runSpan: TelemetrySpan
): Promise<unknown> {
  return runSpan.startSpan(
    {
      name: "chief_of_staff.iteration",
      attributes: {
        "chief_of_staff.run_id": input.runId,
        "chief_of_staff.task_index": taskIndex,
        "chief_of_staff.task_type": task["Task type"],
      },
    },
    async (iterationSpan) => {
      await state.events.emit({
        runId: input.runId,
        type: "iteration.started",
        stepId: iteratorThread.threadId,
        taskIndex,
        taskType: task["Task type"],
      });
      const iterationScope: Scope = {
        ctx: {
          iterator: task as unknown as Record<string, unknown>,
          artifacts: new Map<string, unknown>(),
          trigger: scope.ctx.trigger,
          system: scope.ctx.system,
          eitxht: scope.ctx.eitxht,
        },
      };
      const branchThreadId = dispatchPath(services, state, iterationScope, pathsStep, task);
      const branchThread = getThread(services.definition, branchThreadId);
      const branchSteps = branchThread.steps;
      let taskOutput: unknown = null;
      let recordRow: unknown = null;
      for (const branchStep of branchSteps) {
        throwIfAborted(services.signal);
        const outcome = await executeStep(
          services,
          input,
          state,
          iterationScope,
          branchStep,
          taskIndex,
          iterationSpan
        );
        if (TASK_STEP_IDS.has(branchStep.stepId)) {
          taskOutput = outcome.output;
        }
        if (TABLE_STEP_IDS.has(branchStep.stepId)) {
          recordRow = (outcome.output as { Record?: unknown } | null)?.Record ?? null;
        }
      }
      const ou028yOutput = { Task: taskOutput, Record: recordRow, Thread: branchThreadId };
      const ou028yInvocationId = services.ids.invocationId(input.runId, "ou028y", taskIndex, 0);
      await writeStepArtifact(
        services,
        state,
        input,
        getStep(services.definition, "ou028y"),
        taskIndex,
        ou028yInvocationId,
        state.nowIso,
        services.clock().toISOString(),
        "succeeded",
        ou028yOutput,
        [],
        null,
        0,
        undefined
      );
      iterationSpan.setStatus({ status: "ok" });
      await state.events.emit({
        runId: input.runId,
        type: "iteration.finished",
        stepId: iteratorThread.threadId,
        taskIndex,
        taskType: task["Task type"],
      });
      return ou028yOutput;
    }
  );
}

function dispatchPath(
  services: EngineServices,
  state: RunState,
  scope: Scope,
  pathsStep: WorkflowStepDef,
  task: ExtractedTask
): string {
  const evaluate = (node: WorkflowPathRuleNode): boolean => {
    if (typeof node.subject?.ref === "string") {
      const subject = state.resolver.resolveRef(node.subject.ref, scope.ctx, "ou028y");
      const values = node.value ?? [];
      return typeof subject === "string" && values.includes(subject);
    }
    if (node.or) {
      return node.or.some(evaluate);
    }
    if (node.and) {
      return node.and.every(evaluate);
    }
    return false;
  };

  const branches = pathsStep.paths ?? [];
  let fallback: string | null = null;
  for (const branch of branches) {
    if (branch.fallback) {
      fallback = branch.threadId;
      continue;
    }
    if (branch.rules && evaluate(branch.rules)) {
      return branch.threadId;
    }
  }
  if (fallback) {
    return fallback;
  }
  throw new WorkflowError(
    "WORKFLOW_DEFINITION_CHANGED",
    `No path matched task "${task["Task name"]}" and no fallback branch exists`
  );
}

async function writeStepArtifact(
  services: EngineServices,
  state: RunState,
  input: RunInput,
  step: WorkflowStepDef,
  taskIndex: number | null,
  invocationId: string,
  startedAt: string,
  finishedAt: string,
  status: "succeeded" | "failed" | "skipped",
  output: unknown,
  warnings: StepWarning[],
  error: StepError | null,
  retryCount: number,
  usage: UsageSummary | undefined
): Promise<void> {
  const artifact = artifactToStepArtifact(
    input.runId,
    step.stepId,
    invocationId,
    taskIndex,
    startedAt,
    finishedAt,
    status,
    output,
    warnings,
    error
  );
  const relativePath =
    taskIndex === null
      ? `runs/${input.runId}/steps/${step.stepId}.json`
      : `runs/${input.runId}/steps/${step.stepId}/${String(taskIndex).padStart(4, "0")}.json`;
  const content = `${JSON.stringify(artifact, null, 2)}\n`;
  await services.workspace.writeText(relativePath, content);
  addStepRecord(state.manifest, {
    stepId: step.stepId,
    invocationId,
    taskIndex,
    status,
    startedAt,
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    retryCount,
    warnings,
    error,
    artifactUri: `local://${relativePath}`,
    ...(usage ? { usage } : {}),
  });
  addArtifact(state.manifest, {
    artifactId: services.ids.artifactId(input.runId, step.stepId, taskIndex),
    type: "step-artifact",
    uri: `local://${relativePath}`,
    taskIndex,
    byteSize: utf8ByteLength(content),
  });
}
