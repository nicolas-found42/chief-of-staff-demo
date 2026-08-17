import {
  CALENDAR_TOOL_NAME,
  LLM_PROVIDER_ID,
  type UsageSummary,
  type WorkflowEvent,
} from "@chief-of-staff/contracts";
import {
  WorkflowError,
  type AiInvokeContext,
  type AiInvokeResult,
  type AiInvoker,
  type Logger,
  type Workspace,
} from "@chief-of-staff/workflow/browser";
import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Model, Models } from "@earendil-works/pi-ai";
import { sha256Hex } from "@chief-of-staff/workflow/browser";
import {
  createScriptedStreamFn,
  parseScriptedCase,
} from "./scripted-stream.js";
import { calendarToolFromWorkspace, createSubmitTasksTool, type ExtractionCapture } from "./tools.js";

const EXTRACTION_TOOL = "submit_tasks";

/** The single tool each agent kind may call. The plan agent gets none. */
function allowedTool(kind: AiInvokeContext["kind"]): string | null {
  if (kind === "extract") {
    return EXTRACTION_TOOL;
  }
  if (kind === "email") {
    return CALENDAR_TOOL_NAME;
  }
  return null;
}

export interface InvokerOptions {
  models: Models;
  mode: "live" | "record" | "replay";
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** Workspace handle for the calendar tool. */
  workspace: Workspace;
  /** User-supplied OpenRouter key for live mode; falls back to the process
   * environment when omitted. */
  apiKey?: string;
  /** Replay fixture directory; required when mode === "replay". */
  fixturesDir?: string;
  /** Fixture file loader seam; replay mode requires one. */
  loadFixtureFile?: (filePath: string) => Promise<string>;
  /** Sleep seam for backoff; defaults to a cancellable timer. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Jitter seam; defaults to Math.random. */
  jitter?: () => number;
  logger?: Logger;
}

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

const EXTRACTION_SYSTEM_PROMPT =
  "You extract action items from meeting transcripts. You MUST call the submit_tasks tool exactly once " +
  "with every task extracted from the transcript, including all required details for each task type. " +
  'The "Task type" must be exactly one of: "email", "business plan", "other". ' +
  "Do not answer in ordinary prose and do not call any other tool. If there are no tasks, call submit_tasks with an empty tasks array.";

const EMAIL_SYSTEM_PROMPT =
  "You draft professional, concise emails in the caller's own voice. " +
  "Call the find_calendar_events tool only when the email must propose meeting times. " +
  "Never use em dashes. Output only the email body: no sign-off at all.";

const PLAN_SYSTEM_PROMPT =
  "You draft business plans as structured markdown, following the caller's formatting guidance. " +
  "Do not call any tools; answer with the plan text only.";

function sumAgentUsage(messages: AgentMessage[]): UsageSummary {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let totalTokens = 0;
  let costTotal = 0;
  for (const message of messages) {
    if (message.role !== "assistant" || !message.usage) {
      continue;
    }
    input += message.usage.input;
    output += message.usage.output;
    cacheRead += message.usage.cacheRead;
    cacheWrite += message.usage.cacheWrite;
    totalTokens += message.usage.totalTokens;
    costTotal += message.usage.cost?.total ?? 0;
  }
  return { input, output, cacheRead, cacheWrite, totalTokens, costTotal };
}

export function classifyHttpFailure(status: number, message: string, modelId: string): WorkflowError {
  const text = message.toLowerCase();
  if (
    status === 401 ||
    status === 403 ||
    /(?:invalid|missing).{0,24}(?:api)?key|unauthorized|authentication/i.test(text)
  ) {
    return new WorkflowError(
      "OPENROUTER_AUTH",
      "OpenRouter rejected the request as unauthorized. Check OPENROUTER_API_KEY in the service environment."
    );
  }
  if (status === 404 || /model.{0,20}not found|no endpoints found/i.test(text)) {
    return new WorkflowError(
      "OPENROUTER_MODEL_UNAVAILABLE",
      `The configured model "${modelId}" is unavailable on OpenRouter. Check config/models.json.`
    );
  }
  if (status === 402 || /credit|insufficient balance|billing/i.test(text)) {
    return new WorkflowError(
      "OPENROUTER_AUTH",
      "OpenRouter rejected the request because of credits or billing. Check the OpenRouter account."
    );
  }
  if (
    RETRYABLE_STATUS_CODES.has(status) ||
    /overloaded|rate limit|rate_limit|too many requests|timed out|timeout/i.test(text)
  ) {
    return new WorkflowError(
      "OPENROUTER_RATE_LIMIT",
      `OpenRouter request failed transiently (HTTP ${status || "unknown"})`,
      { retryable: true }
    );
  }
  if (status === 400 || status === 422 || /invalid.{0,20}(request|schema)|bad request/i.test(text)) {
    return new WorkflowError(
      "INVALID_STRUCTURED_OUTPUT",
      `OpenRouter rejected the request as invalid (HTTP ${status})`
    );
  }
  return new WorkflowError(
    "OPENROUTER_RATE_LIMIT",
    `OpenRouter request failed (HTTP ${status || "unknown"}): ${message.slice(0, 200)}`,
    { retryable: true }
  );
}

function replayModel(modelId: string): Model<string> {
  return {
    id: modelId,
    name: "Replay fixture model",
    api: "openai-completions",
    provider: "replay",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 262144,
  } as Model<string>;
}

async function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new WorkflowError("RUN_CANCELLED", "The run was cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class PiAiInvoker implements AiInvoker {
  private lastRetryAfterSeconds: number | null = null;
  constructor(private readonly opts: InvokerOptions) {}


  async invoke(ctx: AiInvokeContext): Promise<AiInvokeResult> {
    let attempt = 0;
    let firstError: WorkflowError | null = null;
    for (;;) {
      try {
        return await ctx.startAiSpan(attempt, async (span) => {
          try {
            const result = await this.attempt(ctx, attempt);
            span.setStatus({ status: "ok" });
            span.setAttributes({
              "chief_of_staff.status": "succeeded",
              "chief_of_staff.input_tokens": result.usage.input,
              "chief_of_staff.output_tokens": result.usage.output,
              "chief_of_staff.total_tokens": result.usage.totalTokens,
              "chief_of_staff.cost_total": result.usage.costTotal,
            });
            return result;
          } catch (error) {
            const workflowError =
              error instanceof WorkflowError
                ? error
                : new WorkflowError(
                    "OPENROUTER_RATE_LIMIT",
                    error instanceof Error ? error.message : String(error),
                    { retryable: true, cause: error }
                  );
            span.setStatus({
              status: "error",
              error: { name: workflowError.code, message: workflowError.message },
            });
            throw workflowError;
          }
        });
      } catch (error) {
        const workflowError =
          error instanceof WorkflowError
            ? error
            : new WorkflowError(
                "OPENROUTER_RATE_LIMIT",
                error instanceof Error ? error.message : String(error),
                { retryable: true, cause: error }
              );
        firstError ??= workflowError;
        // A structured-output failure allows exactly one retry; if that retry
        // fails for any reason, surface the original structured-output error.
        if (firstError.code === "INVALID_STRUCTURED_OUTPUT" && attempt >= 1) {
          throw firstError;
        }
        const decision = this.decideRetry(ctx.kind, workflowError, attempt);
        if (!decision.retry) {
          throw workflowError;
        }
        await ctx.events.emit({
          runId: ctx.runId,
          type: "step.retry",
          stepId: ctx.stepId,
          invocationId: ctx.invocationId,
          taskIndex: ctx.taskIndex,
          data: { attempt, delayMs: decision.delayMs },
        } satisfies Omit<WorkflowEvent, "sequence" | "timestamp">);
        const sleep = this.opts.sleep ?? defaultSleep;
        await sleep(decision.delayMs, ctx.signal);
        if (ctx.signal.aborted) {
          throw new WorkflowError("RUN_CANCELLED", "The run was cancelled");
        }
        attempt += 1;
      }
    }
  }

  /** Decide whether to retry and compute the backoff delay. */
  private decideRetry(
    kind: AiInvokeContext["kind"],
    error: WorkflowError,
    attempt: number
  ): { retry: boolean; delayMs: number } {
    if (error.code === "INVALID_STRUCTURED_OUTPUT") {
      if (kind === "extract" && attempt === 0) {
        return { retry: true, delayMs: 0 };
      }
    }
    if (error.code === "OPENROUTER_RATE_LIMIT" && attempt < 2) {
      const base = 500 * 2 ** attempt;
      const jitter = this.opts.jitter?.() ?? Math.random();
      const cap = 30_000;
      const exponential = Math.min(base + Math.floor(base * jitter), cap);
      // Honor Retry-After when the provider supplied it.
      const retryAfterMs = this.lastRetryAfterSeconds
        ? Math.max(0, Number(this.lastRetryAfterSeconds) * 1000)
        : 0;
      return { retry: true, delayMs: Math.max(exponential, retryAfterMs) };
    }
    return { retry: false, delayMs: 0 };
  }

  private async attempt(ctx: AiInvokeContext, attempt: number): Promise<AiInvokeResult> {
    let attemptedSubmissions = 0;
    let invalidToolAttempted = false;
    let toolCallsSeen = 0;
    /** Hard bound against live models that loop on tool calls. */
    const TOOL_CALL_LIMIT = 8;
    const capture: ExtractionCapture = { tasks: [], submissionCount: 0 };
    const tools: AgentTool[] = [];
    let systemPrompt: string;
    if (ctx.kind === "extract") {
      systemPrompt = EXTRACTION_SYSTEM_PROMPT;
      tools.push(createSubmitTasksTool(capture));
    } else if (ctx.kind === "email") {
      systemPrompt = EMAIL_SYSTEM_PROMPT;
      tools.push(calendarToolFromWorkspace(this.opts.workspace, "calendar/events.json"));
    } else {
      systemPrompt = PLAN_SYSTEM_PROMPT;
    }

    const replay = this.opts.mode === "replay";
    const model = replay
      ? replayModel(ctx.modelId)
      : this.opts.models.getModel(LLM_PROVIDER_ID, ctx.modelId);
    if (!model) {
      throw new WorkflowError(
        "OPENROUTER_MODEL_UNAVAILABLE",
        `Configured model "${ctx.modelId}" is not in the registered pi catalog`
      );
    }

    const streamFn = replay
      ? await this.loadReplayFixture(ctx)
      : (
          model: Model<string>,
          context: Parameters<StreamFn>[1],
          options: Parameters<StreamFn>[2]
        ) =>
          this.opts.models.streamSimple(model, context, {
            ...options,
            ...(this.opts.apiKey !== undefined ? { apiKey: this.opts.apiKey } : {}),
          });

    let lastStatus = 0;
    const agent = new Agent({
      initialState: {
        systemPrompt,
        model: model as Model<string>,
        tools,
        thinkingLevel: this.opts.thinkingLevel,
      },
      streamFn: streamFn as StreamFn,
      sessionId: `${ctx.runId}:${ctx.stepId}:${ctx.taskIndex ?? "main"}`,
      toolExecution: "sequential",
      shouldStopAfterTurn: () =>
        attemptedSubmissions > 1 || invalidToolAttempted || toolCallsSeen > TOOL_CALL_LIMIT,
      onResponse: (info) => {
        lastStatus = info.status;
        const retryAfter = (info.headers as Record<string, string> | undefined)?.["retry-after"];
        this.lastRetryAfterSeconds = retryAfter ? Number(retryAfter) : null;
      },
      beforeToolCall: async (before) => {
        toolCallsSeen += 1;
        const allowed = allowedTool(ctx.kind);
        if (before.toolCall.name !== allowed) {
          if (ctx.kind === "extract") {
            invalidToolAttempted = true;
          }
          return {
            block: true,
            reason:
              allowed === null
                ? `Tool "${before.toolCall.name}" is not allowed for this agent`
                : `Tool "${before.toolCall.name}" is not allowed; only ${allowed} may be called`,
            terminate: true,
          };
        }
        if (ctx.kind === "extract") {
          attemptedSubmissions += 1;
          if (attemptedSubmissions > 1) {
            return {
              block: true,
              reason: `${EXTRACTION_TOOL} may only be called once`,
              terminate: true,
            };
          }
        }
        return undefined;
      },
    });

    const onAbort = (): void => {
      agent.abort();
    };
    ctx.signal.addEventListener("abort", onAbort);
    const unsubscribe = agent.subscribe((event) => {
      if (event.type === "message_update") {
        if (event.assistantMessageEvent.type === "text_delta") {
          ctx.onProgress("text", "");
        } else if (event.assistantMessageEvent.type === "thinking_delta") {
          ctx.onProgress("thinking", "");
        }
      } else if (event.type === "tool_execution_start") {
        ctx.onProgress("tool_call", event.toolName);
      }
    });

    let messages: AgentMessage[];
    try {
      const timestamp = ctx.clock().getTime();
      await agent.prompt([
        {
          role: "user",
          content: ctx.promptText,
          timestamp,
        },
        {
          role: "user",
          content: `Meeting transcript for context only; do not quote it verbatim:\n<transcript>\n${ctx.transcriptText}\n</transcript>`,
          timestamp,
        },
      ]);
      await agent.waitForIdle();
      messages = agent.state.messages;
    } finally {
      unsubscribe();
      ctx.signal.removeEventListener("abort", onAbort);
    }

    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    const errorMessage =
      agent.state.errorMessage ??
      (lastAssistant?.role === "assistant" ? lastAssistant.errorMessage : undefined);
    if (ctx.signal.aborted) {
      await this.writeRequestFile(ctx, attempt, "aborted", messages, "cancelled");
    }

    if (toolCallsSeen > TOOL_CALL_LIMIT) {
      await this.writeRequestFile(ctx, attempt, "failed", messages, "tool call limit exceeded");
      throw new WorkflowError(
        "INVALID_STRUCTURED_OUTPUT",
        `The agent exceeded the tool call limit of ${TOOL_CALL_LIMIT}`
      );
    }

    if (ctx.kind === "extract") {
      if (invalidToolAttempted) {
        await this.writeRequestFile(ctx, attempt, "failed", messages, "invalid tool attempted");
        throw new WorkflowError(
          "INVALID_STRUCTURED_OUTPUT",
          `The extraction agent attempted a tool other than ${EXTRACTION_TOOL}`
        );
      }
      if (attemptedSubmissions === 0 || capture.submissionCount === 0) {
        await this.writeRequestFile(ctx, attempt, "failed", messages, "no valid submit_tasks call");
        throw new WorkflowError(
          "INVALID_STRUCTURED_OUTPUT",
          `The extraction agent finished without one valid ${EXTRACTION_TOOL} call`
        );
      }
      if (attemptedSubmissions > 1) {
        await this.writeRequestFile(ctx, attempt, "failed", messages, "submit_tasks attempted more than once");
        throw new WorkflowError(
          "INVALID_STRUCTURED_OUTPUT",
          `The extraction agent attempted ${EXTRACTION_TOOL} more than once`
        );
      }
    }

    if (
      errorMessage ||
      (lastAssistant?.role === "assistant" && lastAssistant.stopReason === "error")
    ) {
      await this.writeRequestFile(ctx, attempt, "failed", messages, errorMessage ?? "model stream error");
      throw classifyHttpFailure(lastStatus, errorMessage ?? "model stream error", ctx.modelId);
    }

    const usage = sumAgentUsage(messages);

    if (ctx.kind === "extract") {
      await this.writeRequestFile(ctx, attempt, "succeeded", messages);
      await this.writeResponseFile(ctx, attempt, messages);
      return { output: capture.tasks, usage, warnings: [], retryCount: attempt };
    }

    const text = assistantText(messages);
    await this.writeRequestFile(ctx, attempt, "succeeded", messages);
    await this.writeResponseFile(ctx, attempt, messages);
    return {
      output: { message: text },
      usage,
      warnings: [],
      retryCount: attempt,
    };
  }

  private async loadReplayFixture(ctx: AiInvokeContext): Promise<StreamFn> {
    if (!this.opts.fixturesDir) {
      throw new WorkflowError("INVALID_CONFIGURATION", "Replay mode requires a fixtures directory");
    }
    if (!this.opts.loadFixtureFile) {
      throw new WorkflowError(
        "INVALID_CONFIGURATION",
        "Replay mode requires a fixture file loader"
      );
    }
    const key = `${ctx.stepId}:${ctx.taskIndex === null ? "main" : String(ctx.taskIndex).padStart(4, "0")}`;
    const indexFile = `${this.opts.fixturesDir}/index.json`;
    let indexText: string;
    try {
      indexText = await this.opts.loadFixtureFile(indexFile);
    } catch (error) {
      throw new WorkflowError(
        "REPLAY_FIXTURE_MISSING",
        `Missing replay fixture index for invocation ${key} (expected ${indexFile})`,
        { cause: error }
      );
    }
    const index = JSON.parse(indexText) as { cases?: Record<string, string> };
    const caseFile = index.cases?.[key];
    if (!caseFile) {
      throw new WorkflowError(
        "REPLAY_FIXTURE_MISSING",
        `No replay fixture registered for invocation ${key} in ${indexFile}`
      );
    }
    const path = `${this.opts.fixturesDir}/${caseFile}`;
    let caseText: string;
    try {
      caseText = await this.opts.loadFixtureFile(path);
    } catch (error) {
      throw new WorkflowError(
        "REPLAY_FIXTURE_MISSING",
        `Missing replay fixture file for invocation ${key} (expected ${path})`,
        { cause: error }
      );
    }
    const parsed = parseScriptedCase(JSON.parse(caseText) as unknown, key);
    return createScriptedStreamFn(ctx.modelId, parsed.messages, key);
  }

  private async writeRequestFile(
    ctx: AiInvokeContext,
    attempt: number,
    status: "succeeded" | "failed" | "aborted",
    messages: AgentMessage[],
    error?: string
  ): Promise<void> {
    const summary = messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => {
        const text = extractTextForHash(message.content);
        return {
          role: message.role,
          sha256: sha256Hex(text),
          contentLength: text.length,
          hasToolCall: Array.isArray(message.content)
            ? message.content.some(
                (block) =>
                  typeof block === "object" && block !== null && (block as { type?: string }).type === "toolCall"
              )
            : false,
        };
      });
    const request = {
      schemaVersion: 1,
      invocationId: ctx.invocationId,
      runId: ctx.runId,
      stepId: ctx.stepId,
      taskIndex: ctx.taskIndex,
      attempt,
      mode: this.opts.mode,
      provider: LLM_PROVIDER_ID,
      model: ctx.modelId,
      status,
      messages: summary,
      ...(error ? { error } : {}),
    };
    try {
      await ctx.workspace.writeText(
        `runs/${ctx.runId}/llm/${ctx.invocationId}.request.json`,
        `${JSON.stringify(request, null, 2)}\n`
      );
    } catch (writeError) {
      this.logWarning(ctx, `Unable to write LLM request record: ${writeError instanceof Error ? writeError.message : String(writeError)}`);
    }
  }

  private async writeResponseFile(
    ctx: AiInvokeContext,
    attempt: number,
    messages: AgentMessage[]
  ): Promise<void> {
    if (this.opts.mode !== "record") {
      return;
    }
    const response = {
      schemaVersion: 1,
      invocationId: ctx.invocationId,
      runId: ctx.runId,
      stepId: ctx.stepId,
      taskIndex: ctx.taskIndex,
      attempt,
      assistantMessages: messages
        .filter((message) => message.role === "assistant")
        .map((message) => ({
          content: message.content,
          usage: message.usage,
          stopReason: message.stopReason,
        })),
    };
    try {
      await ctx.workspace.writeText(
        `runs/${ctx.runId}/llm/${ctx.invocationId}.response.json`,
        `${JSON.stringify(response, null, 2)}\n`
      );
    } catch (writeError) {
      this.logWarning(ctx, `Unable to write LLM response record: ${writeError instanceof Error ? writeError.message : String(writeError)}`);
    }
  }

  private logWarning(ctx: AiInvokeContext, message: string): void {
    const logger = this.opts.logger ?? ctx.logger;
    logger.warn(message);
  }
}

function extractTextForHash(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "object" && block !== null && "text" in block) {
          return String((block as { text: unknown }).text);
        }
        if (typeof block === "object" && block !== null && "name" in block) {
          return String((block as { name: unknown }).name);
        }
        return "";
      })
      .join("\n");
  }
  return "";
}

function assistantText(messages: AgentMessage[]): string {
  const assistant = [...messages].reverse().find((message) => message.role === "assistant");
  if (!assistant) {
    return "";
  }
  const content = assistant.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(
        (block) =>
          typeof block === "object" && block !== null && (block as { type?: string }).type === "text"
      )
      .map((block) => String((block as { text: unknown }).text))
      .join("");
  }
  return "";
}
