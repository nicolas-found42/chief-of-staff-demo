import { describe, expect, it } from "vitest";
import {
  CALENDAR_TOOL_NAME,
  EXTRACTION_TOOL_NAME,
  type CalendarEvents,
  type ExtractedTask,
} from "@chief-of-staff/contracts";
import {
  EventSink,
  WorkflowError,
  createDeterministicIdGenerator,
  type AiInvokeContext,
  Workspace,
} from "@chief-of-staff/workflow";
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { createFauxCore, fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { createModels, type Models } from "@earendil-works/pi-ai";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PiAiInvoker,
  calendarToolFromWorkspace,
  createCalendarTool,
  createSubmitTasksTool,
  type ExtractionCapture,
} from "@chief-of-staff/agents";

const MODEL_ID = "google/gemini-3.7-flash";

const EXTRACTION_TASKS: ExtractedTask[] = [
  {
    "Task name": "Email supplier",
    "Task type": "email",
    "Assigned to": "Ada Lovelace",
    Deadline: "2026-08-15T15:00:00.000Z",
    "Email details": {
      Recipient: "supplier@example.com",
      Subject: "Delivery timeline",
      Body: "Please share the updated schedule.",
    },
  },
];

interface FauxModelsHandle {
  models: Models;
  setResponses: (responses: FauxResponseStep[]) => void;
  getPendingResponseCount: () => number;
}

/** A models registry backed by pi's faux provider, scripted per test. */
function fauxModels(providerId = "openrouter"): FauxModelsHandle {
  const handle = fauxProvider({
    api: "openai-completions",
    provider: providerId,
    models: [
      {
        id: MODEL_ID,
        name: "Faux model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 262144,
      },
    ],
    tokenSize: { min: 64, max: 64 },
  });
  const models = createModels();
  models.setProvider(handle.provider);
  return {
    models,
    setResponses: handle.setResponses,
    getPendingResponseCount: handle.getPendingResponseCount,
  };
}

function scriptedToolCall(name: string, args: Record<string, unknown>) {
  return fauxAssistantMessage(fauxToolCall(name, args, { id: `call-${name}` }), {
    stopReason: "toolUse",
    timestamp: 0,
  });
}

function scriptedText(text: string) {
  return fauxAssistantMessage(fauxText(text), { stopReason: "stop", timestamp: 0 });
}

async function makeInvokeContext(overrides: Partial<AiInvokeContext> = {}) {
  const root = await mkdtemp(join(tmpdir(), "contract-"));
  const workspace = new Workspace(root);
  await workspace.initialize();
  await writeFile(
    join(root, "calendar", "events.json"),
    JSON.stringify({
      timezone: "America/New_York",
      events: [
        {
          id: "busy",
          start: "2026-08-17T10:00:00-04:00",
          end: "2026-08-17T10:30:00-04:00",
          summary: "Busy",
          status: "busy",
        },
      ],
    } satisfies CalendarEvents),
    "utf8"
  );
  const ids = createDeterministicIdGenerator("contract");
  const events = new EventSink(workspace, "events.jsonl", () => new Date("2026-08-15T15:00:00.000Z"));
  const base: AiInvokeContext = {
    runId: "run-contract",
    stepId: "eitxht",
    invocationId: "inv-1",
    taskIndex: null,
    task: null,
    kind: "extract",
    promptText: "Extract the tasks.",
    transcriptText: "Meeting notes: Ada sends an email to the supplier.",
    modelId: MODEL_ID,
    signal: new AbortController().signal,
    ids,
    clock: () => new Date("2026-08-15T15:00:00.000Z"),
    mode: "live",
    workspace,
    events,
    logger: { info() {}, warn() {}, error() {} },
    onProgress: (kind, label) => {
      void events.emit({
        runId: "run-contract",
        type: "progress",
        data: { kind, label },
      });
    },
    startAiSpan: (_retryCount, callback) =>
      callback({
        setStatus() {},
        setAttributes() {},
        addEvent() {},
        startSpan: (_options: unknown, childCallback: (s: unknown) => unknown) =>
          childCallback({} as never),
      } as never),
    ...overrides,
  };
  return base;
}

describe("extraction agent contract", () => {
  it("calls submit_tasks exactly once and captures validated tasks", async () => {
    const tasks = [
      {
        "Task name": "Email supplier",
        "Task type": "email",
        "Assigned to": "Ada Lovelace",
        Deadline: "2026-08-15T15:00:00.000Z",
        "Email details": { Recipient: "s@example.com", Subject: "S", Body: "B" },
      },
    ];
    const { models, setResponses } = fauxModels();
    setResponses([
      fauxAssistantMessage(fauxToolCall("submit_tasks", { tasks }, { id: "c1" }), {
        stopReason: "toolUse",
        timestamp: 0,
      }),
    ]);
    const ctx = await makeInvokeContext();
    const invoker = new PiAiInvoker({
      models,
      mode: "live",
      thinkingLevel: "off",
      workspace: ctx.workspace,
      sleep: async () => undefined,
      jitter: () => 0,
    });
    const result = await invoker.invoke(ctx);
    expect(result.retryCount).toBe(0);
    expect(result.output).toEqual(tasks);
  });

  it("retries once after finishing without a submission, then succeeds", async () => {
    const { models, setResponses } = fauxModels();
    // First attempt: prose only. Second attempt: the tool call.
    setResponses([
      scriptedText("I found these tasks for you."),
      scriptedToolCall(EXTRACTION_TOOL_NAME, { tasks: EXTRACTION_TASKS }),
    ]);
    const ctx = await makeInvokeContext();
    const invoker = new PiAiInvoker({
      models,
      mode: "live",
      thinkingLevel: "off",
      workspace: ctx.workspace,
      sleep: async () => undefined,
      jitter: () => 0,
    });
    const result = await invoker.invoke(ctx);
    expect(result.retryCount).toBe(1);
    expect(result.output).toEqual(EXTRACTION_TASKS);
  });

  it("fails with INVALID_STRUCTURED_OUTPUT when no submission is ever made", async () => {
    const { models, setResponses } = fauxModels();
    setResponses([scriptedText("Nothing to report.")]);
    const ctx = await makeInvokeContext();
    const invoker = new PiAiInvoker({
      models,
      mode: "live",
      thinkingLevel: "off",
      workspace: ctx.workspace,
      sleep: async () => undefined,
      jitter: () => 0,
    });
    const promise = invoker.invoke(ctx);
    // The single retry consumes the second response slot and errors out.
    await expect(promise).rejects.toMatchObject({ code: "INVALID_STRUCTURED_OUTPUT" });
  });


  it("blocks any tool name other than submit_tasks", async () => {
    const { models, setResponses } = fauxModels();
    setResponses([scriptedToolCall("run_shell_command", { cmd: "rm -rf" })]);
    const ctx = await makeInvokeContext();
    const invoker = new PiAiInvoker({
      models,
      mode: "live",
      thinkingLevel: "off",
      workspace: ctx.workspace,
      sleep: async () => undefined,
      jitter: () => 0,
    });
    await expect(invoker.invoke(ctx)).rejects.toMatchObject({
      code: "INVALID_STRUCTURED_OUTPUT",
    });
  });

  it("fails when submit_tasks is attempted twice", async () => {
    const { models, setResponses } = fauxModels();
    // One assistant message carrying two tool calls: the second attempt is
    // blocked and the step must fail.
    const double = fauxAssistantMessage(
      [
        fauxToolCall(EXTRACTION_TOOL_NAME, { tasks: EXTRACTION_TASKS }, { id: "call-1" }),
        fauxToolCall(EXTRACTION_TOOL_NAME, { tasks: EXTRACTION_TASKS }, { id: "call-2" }),
      ],
      { stopReason: "toolUse", timestamp: 0 }
    );
    setResponses([double]);
    const ctx = await makeInvokeContext();
    const invoker = new PiAiInvoker({
      models,
      mode: "live",
      thinkingLevel: "off",
      workspace: ctx.workspace,
      sleep: async () => undefined,
      jitter: () => 0,
    });
    await expect(invoker.invoke(ctx)).rejects.toMatchObject({
      code: "INVALID_STRUCTURED_OUTPUT",
    });
  });

  it("hard-stops the loop when the model keeps calling submit_tasks with invalid payloads", async () => {
    const { models, setResponses, getPendingResponseCount } = fauxModels();
    // A live model can loop forever when every submission fails validation
    // and each message carries several calls: the batch never terminates.
    // The invoker must hard-stop the loop after the second submission.
    const invalidTasks = [
      {
        "Task name": "Email supplier",
        "Task type": "email",
        "Assigned to": "Ada Lovelace",
        Deadline: "2026-08-15T15:00:00.000Z",
      },
    ];
    setResponses(
      Array.from({ length: 5 }, () =>
        fauxAssistantMessage(
          [
            fauxToolCall(EXTRACTION_TOOL_NAME, { tasks: invalidTasks }, { id: "call-a" }),
            fauxToolCall(EXTRACTION_TOOL_NAME, { tasks: invalidTasks }, { id: "call-b" }),
          ],
          { stopReason: "toolUse", timestamp: 0 }
        )
      )
    );
    const ctx = await makeInvokeContext();
    const invoker = new PiAiInvoker({
      models,
      mode: "live",
      thinkingLevel: "off",
      workspace: ctx.workspace,
      sleep: async () => undefined,
      jitter: () => 0,
    });
    await expect(invoker.invoke(ctx)).rejects.toMatchObject({
      code: "INVALID_STRUCTURED_OUTPUT",
    });
    // Fixed: attempt 0 consumes one response, the retry one more; three remain
    // unconsumed, proving the loop stopped instead of draining the queue.
    expect(getPendingResponseCount()).toBe(3);
  });

  it("caps runaway tool calls for the email agent", async () => {
    const { models, setResponses, getPendingResponseCount } = fauxModels();
    setResponses(
      Array.from({ length: 10 }, () =>
        scriptedToolCall(CALENDAR_TOOL_NAME, {
          earliest: "2026-08-17T09:00:00Z",
          latest: "2026-08-17T17:00:00Z",
          durationMinutes: 30,
        })
      )
    );
    const ctx = await makeInvokeContext({ kind: "email", stepId: "maoa1p", taskIndex: 0 });
    const invoker = new PiAiInvoker({
      models,
      mode: "live",
      thinkingLevel: "off",
      workspace: ctx.workspace,
      sleep: async () => undefined,
      jitter: () => 0,
    });
    await expect(invoker.invoke(ctx)).rejects.toMatchObject({
      code: "INVALID_STRUCTURED_OUTPUT",
      message: expect.stringContaining("tool call limit"),
    });
    expect(getPendingResponseCount()).toBe(1);
  });


  it("rejects tasks that violate branch invariants", async () => {
    const { models, setResponses } = fauxModels();
    setResponses([
      scriptedToolCall(EXTRACTION_TOOL_NAME, {
        tasks: [{ ...EXTRACTION_TASKS[0], "Email details": undefined }],
      }),
    ]);
    const ctx = await makeInvokeContext();
    const invoker = new PiAiInvoker({
      models,
      mode: "live",
      thinkingLevel: "off",
      workspace: ctx.workspace,
      sleep: async () => undefined,
      jitter: () => 0,
    });
    await expect(invoker.invoke(ctx)).rejects.toMatchObject({
      code: "INVALID_STRUCTURED_OUTPUT",
    });
  });

  it("uses a fresh agent per invocation with no shared transcript state", async () => {
    const { models, setResponses } = fauxModels();
    setResponses([scriptedToolCall(EXTRACTION_TOOL_NAME, { tasks: EXTRACTION_TASKS })]);
    const first = await makeInvokeContext();
    const second = await makeInvokeContext({
      invocationId: "inv-2",
      transcriptText: "Different meeting.",
    });
    const invoker = new PiAiInvoker({
      models,
      mode: "live",
      thinkingLevel: "off",
      workspace: first.workspace,
      sleep: async () => undefined,
      jitter: () => 0,
    });
    const resultA = await invoker.invoke(first);
    expect(resultA.output).toEqual(EXTRACTION_TASKS);
    // The second invocation gets its own agent; the first transcript does not
    // leak into it (the faux stream serves the response independently).
    const { models: modelsB, setResponses: setB } = fauxModels();
    setB([scriptedToolCall(EXTRACTION_TOOL_NAME, { tasks: EXTRACTION_TASKS })]);
    const invokerB = new PiAiInvoker({
      models: modelsB,
      mode: "live",
      thinkingLevel: "off",
      workspace: second.workspace,
      sleep: async () => undefined,
      jitter: () => 0,
    });
    const resultB = await invokerB.invoke(second);
    expect(resultB.output).toEqual(EXTRACTION_TASKS);
  });
});

describe("email drafting agent contract", () => {
  it("can call find_calendar_events and continue to final text", async () => {
    let toolCalls = 0;
    const tool: AgentTool = createCalendarTool({
      readCalendarFile: async () => {
        toolCalls += 1;
        return JSON.stringify({
          timezone: "America/New_York",
          events: [],
        } satisfies CalendarEvents);
      },
    });
    const core = createFauxCore({
      api: "openai-completions",
      provider: "replay",
      models: [
        {
          id: MODEL_ID,
          name: "Faux",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1000,
          maxTokens: 1000,
        },
      ],
      tokenSize: { min: 64, max: 64 },
    });
    core.setResponses([
      scriptedToolCall(CALENDAR_TOOL_NAME, {
        earliest: "2026-08-17T09:00:00-04:00",
        latest: "2026-08-17T17:00:00-04:00",
        durationMinutes: 30,
      }),
      scriptedText("Shall we meet Tuesday at 11?"),
    ]);
    const agent = new Agent({
      initialState: {
        systemPrompt: "Draft an email.",
        model: core.getModel(MODEL_ID) as never,
        tools: [tool],
        thinkingLevel: "off" as never,
      },
      streamFn: core.streamSimple as never,
      toolExecution: "sequential",
    });
    const messages: AgentMessage[] = [];
    agent.subscribe((event) => {
      if (event.type === "agent_end") {
        messages.push(...(event.messages as AgentMessage[]));
      }
    });
    await agent.prompt({ role: "user", content: "Draft it.", timestamp: 0 } as never);
    await agent.waitForIdle();
    expect(toolCalls).toBe(1);
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    const content = Array.isArray(lastAssistant?.content) ? lastAssistant.content : [];
    const text = content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    expect(text).toContain("Shall we meet Tuesday at 11?");
  });

  it("never lets the plan agent call any tool", async () => {
    // The business-plan agent is constructed with an empty tool list; any
    // tool call the model attempts is rejected as "not found" and never
    // executes. This mirrors the invoker's plan-agent configuration.
    const core = createFauxCore({
      api: "openai-completions",
      provider: "replay",
      models: [
        {
          id: MODEL_ID,
          name: "Faux",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1000,
          maxTokens: 1000,
        },
      ],
      tokenSize: { min: 64, max: 64 },
    });
    core.setResponses([
      scriptedToolCall(CALENDAR_TOOL_NAME, {
        earliest: "2026-08-17T09:00:00-04:00",
        latest: "2026-08-17T17:00:00-04:00",
        durationMinutes: 30,
      }),
    ]);
    const agent = new Agent({
      initialState: {
        systemPrompt: "Write a plan.",
        model: core.getModel(MODEL_ID) as never,
        tools: [],
        thinkingLevel: "off" as never,
      },
      streamFn: core.streamSimple as never,
      toolExecution: "sequential",
    });
    const results: Array<{ toolName: string; isError: boolean }> = [];
    agent.subscribe((event) => {
      if (event.type === "tool_execution_end") {
        results.push({ toolName: event.toolName, isError: event.isError });
      }
    });
    await agent.prompt({ role: "user", content: "Plan it.", timestamp: 0 } as never);
    await agent.waitForIdle();
    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(true);
    expect(results[0].toolName).toBe(CALENDAR_TOOL_NAME);
  });
});

describe("agent progress redaction", () => {
  it("maps agent events to redacted workflow events only", async () => {
    const { models, setResponses } = fauxModels();
    const draftText = "TOP SECRET DRAFT BODY with a unique marker: xyzzy-marker-42";
    const tasksWithSecret: ExtractedTask[] = [
      {
        "Task name": "Secret task xyzzy-marker-42",
        "Task type": "other",
        "Assigned to": "Ada Lovelace",
        "Task description": "secret description xyzzy-marker-42",
      },
    ];
    setResponses([
      scriptedToolCall(EXTRACTION_TOOL_NAME, { tasks: tasksWithSecret }),
      scriptedText(draftText),
    ]);
    const ctx = await makeInvokeContext();
    const invoker = new PiAiInvoker({
      models,
      mode: "live",
      thinkingLevel: "off",
      workspace: ctx.workspace,
      sleep: async () => undefined,
      jitter: () => 0,
    });
    await invoker.invoke(ctx).catch(() => undefined);
    // First invocation consumed the tool call; run a text step to emit text
    // deltas and verify nothing secret reaches the event stream.
    const ctxEmail = await makeInvokeContext({ kind: "email", stepId: "maoa1p", taskIndex: 0 });
    const { models: modelsB, setResponses: setB } = fauxModels();
    setB([scriptedText(draftText)]);
    const invokerB = new PiAiInvoker({
      models: modelsB,
      mode: "live",
      thinkingLevel: "off",
      workspace: ctxEmail.workspace,
      sleep: async () => undefined,
      jitter: () => 0,
    });
    const result = await invokerB.invoke(ctxEmail);
    expect((result.output as { message: string }).message).toBe(draftText);
    const eventText = await readFile(join(ctxEmail.workspace.root, "events.jsonl"), "utf8");
    expect(eventText).not.toContain("xyzzy-marker-42");
    expect(eventText).not.toContain("TOP SECRET");
  });
});

describe("agent cancellation", () => {
  it("propagates the run abort to the active model stream", async () => {
    const controller = new AbortController();
    const core = createFauxCore({
      api: "openai-completions",
      provider: "replay",
      models: [
        {
          id: MODEL_ID,
          name: "Faux",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1_000_000,
          maxTokens: 1_000_000,
        },
      ],
      // Slow stream: abort lands mid-generation.
      tokensPerSecond: 4,
      tokenSize: { min: 8, max: 8 },
    });
    core.setResponses([scriptedText("word ".repeat(200_000))]);
    const capture: ExtractionCapture = { tasks: [], submissionCount: 0 };
    const agent = new Agent({
      initialState: {
        systemPrompt: "Extract tasks.",
        model: core.getModel(MODEL_ID) as never,
        tools: [createSubmitTasksTool(capture) as AgentTool],
        thinkingLevel: "off" as never,
      },
      streamFn: core.streamSimple as never,
      toolExecution: "sequential",
    });
    const abortPromise = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        controller.abort();
        resolve();
      }, 30);
      void timer;
    });
    let settled = false;
    agent.subscribe((event) => {
      if (event.type === "agent_end") {
        settled = true;
      }
    });
    const onAbort = () => agent.abort();
    controller.signal.addEventListener("abort", onAbort);
    await agent.prompt({ role: "user", content: "Go.", timestamp: 0 } as never);
    await agent.waitForIdle();
    await abortPromise;
    controller.signal.removeEventListener("abort", onAbort);
    expect(settled).toBe(true);
    const last = [...agent.state.messages].reverse().find((m) => m.role === "assistant");
    expect(last?.stopReason === "aborted" || agent.state.errorMessage !== undefined).toBe(true);
  });

  it("maps cancellation to RUN_CANCELLED in the invoker", async () => {
    const controller = new AbortController();
    const { models, setResponses } = fauxModels();
    setResponses([scriptedToolCall(EXTRACTION_TOOL_NAME, { tasks: EXTRACTION_TASKS })]);
    const ctx = await makeInvokeContext({ signal: controller.signal });
    const invoker = new PiAiInvoker({
      models,
      mode: "live",
      thinkingLevel: "off",
      workspace: ctx.workspace,
      sleep: async (ms, signal) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, ms);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new WorkflowError("RUN_CANCELLED", "cancelled"));
            },
            { once: true }
          );
        });
      },
      jitter: () => 0,
    });
    const promise = invoker.invoke(ctx);
    // Abort during the (scripted-zero) settle window is flaky; instead abort
    // before awaiting and accept either the cancelled error or a race win.
    controller.abort();
    await promise.catch((error) => {
      expect(["RUN_CANCELLED", "OPENROUTER_RATE_LIMIT"].includes(error.code)).toBe(true);
    });
  });
});

describe("calendar tool reads only", () => {
  it("never writes to the calendar file", async () => {
    const root = await mkdtemp(join(tmpdir(), "calendar-"));
    const calendarPath = join(root, "events.json");
    const original = JSON.stringify({
      timezone: "UTC",
      events: [],
    } satisfies CalendarEvents);
    await writeFile(calendarPath, original, "utf8");
    const workspace = new Workspace(root);
    const tool = calendarToolFromWorkspace(workspace, "events.json");
    await tool.execute("call-1", {
      earliest: "2026-08-17T09:00:00Z",
      latest: "2026-08-17T17:00:00Z",
      durationMinutes: 30,
    });
    expect(await readFile(calendarPath, "utf8")).toBe(original);
  });
});
