import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ExtractionWireSchema,
  type ModelBoundaryDiagnostic,
  type ModelAttemptEvent,
} from "@chief-of-staff-demo/shared";
import {
  makeCompleteJson,
  REQUEST_TIMEOUT_MS,
  STREAM_IDLE_TIMEOUT_MS,
  STREAM_SILENT_TIMEOUT_MS,
} from "../../../apps/server/src/llm/providers";
import { modelBoundaryDiagnostic } from "../../../apps/server/src/llm/failure";

interface Call {
  url: string;
  signal?: AbortSignal | null;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * One queued reply. `text` sends a raw body the JSON encoder would not produce,
 * `hang` never answers so the request ceiling is what ends the call, and `fail`
 * is a transport that never reached the provider at all.
 */
interface Reply {
  status?: number;
  body?: unknown;
  text?: string;
  sse?: string[];
  sseDrip?: { lines: string[]; intervalMs: number };
  hang?: true;
  bodyHang?: true;
  delayMs?: number;
  fail?: Error;
}

const calls: Call[] = [];
const responses: Reply[] = [];
/** Replies to the model-capability lookup, which is a different URL to a completion. */
const declarations: Reply[] = [];
const lookups: string[] = [];

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

async function queuedResponse(queued: Reply, signal?: AbortSignal | null): Promise<Response> {
  if (queued.fail) throw queued.fail;
  if (signal?.aborted) throw abortError();
  if (queued.hang) {
    return new Promise<Response>((_, reject) => {
      signal?.addEventListener("abort", () => reject(abortError()));
    });
  }
  if (queued.delayMs !== undefined) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, queued.delayMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(abortError());
      });
    });
  }
  if (queued.bodyHang) {
    return new Response(
      new ReadableStream({
        start(controller) {
          signal?.addEventListener("abort", () => controller.error(abortError()));
        },
      }),
      { status: queued.status ?? 200 },
    );
  }
  if (queued.sse) {
    const lines = queued.sse;
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const line of lines) controller.enqueue(new TextEncoder().encode(`${line}\n`));
          controller.close();
        },
      }),
      { status: queued.status ?? 200, headers: { "content-type": "text/event-stream" } },
    );
  }
  if (queued.sseDrip) {
    const { lines, intervalMs } = queued.sseDrip;
    return new Response(
      new ReadableStream({
        start(controller) {
          let index = 0;
          /* Driven by the test's fake timers like the keepalive streams
             below: no real waiting, the clock advances deterministically. */
          const timer = setInterval(() => {
            if (signal?.aborted) {
              clearInterval(timer);
              controller.error(abortError());
              return;
            }
            /* A runaway never terminates: when the script ends the stream
               stays open until the call's own timeouts end it. */
            if (index >= lines.length) return;
            controller.enqueue(new TextEncoder().encode(`${lines[index++]}\n`));
          }, intervalMs);
          signal?.addEventListener("abort", () => {
            clearInterval(timer);
            try {
              controller.error(abortError());
            } catch {
              /* The timeout already closed the stream; nothing left to fail. */
            }
          });
        },
      }),
      { status: queued.status ?? 200, headers: { "content-type": "text/event-stream" } },
    );
  }
  return new Response(queued.text ?? JSON.stringify(queued.body), {
    status: queued.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

it("keeps the absolute request ceiling above both stream ceilings", () => {
  expect(REQUEST_TIMEOUT_MS).toBe(300_000);
  /* Ordered, and each one answers a different question: is the connection
     alive, is an answer being produced, and has the whole call run too long. */
  expect(STREAM_SILENT_TIMEOUT_MS).toBeGreaterThan(STREAM_IDLE_TIMEOUT_MS);
  expect(REQUEST_TIMEOUT_MS).toBeGreaterThan(STREAM_SILENT_TIMEOUT_MS);
});

beforeEach(() => {
  calls.length = 0;
  responses.length = 0;
  declarations.length = 0;
  lookups.length = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.includes("/endpoints")) {
      lookups.push(url);
      /* No queued declaration means the model's support is unknown, which is
         its own branch: start at the most deterministic binding and step down. */
      const queued: Reply = declarations.shift() ?? { status: 404, body: {} };
      return queuedResponse(queued, init?.signal);
    }
    calls.push({
      url,
      signal: init?.signal ?? null,
      headers,
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
        string,
        unknown
      >,
    });
    const queued: Reply = responses.shift() ?? { status: 200, body: {} };
    return queuedResponse(queued, init?.signal);
  });
});

/** An OpenRouter model-capability reply declaring exactly `params`. */
function declaring(...params: string[]): Reply {
  return { status: 200, body: { data: { endpoints: [{ supported_parameters: params }] } } };
}

function toolCallCompletion(args: unknown): Record<string, unknown> {
  return {
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: null,
          tool_calls: [
            { type: "function", function: { name: "save_extraction", arguments: args } },
          ],
        },
      },
    ],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const RESULT = { isTranscript: true, summary: "ok", tasks: [], drafts: [] };

function chatCompletion(content: unknown): Record<string, unknown> {
  return { choices: [{ message: { content } }] };
}

/** An OpenRouter answer, the way the streaming wire actually carries it. */
function sseChatCompletion(content: unknown): string[] {
  return [
    ": OPENROUTER PROCESSING",
    `data: {"choices":[{"delta":{"content":${JSON.stringify(content)}}}]}`,
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{}}',
    "data: [DONE]",
  ];
}

function sseToolCallCompletion(args: unknown): string[] {
  return [
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"type":"function","function":{"name":"save_extraction","arguments":${JSON.stringify(args)}}}]}}]}`,
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{}}',
    "data: [DONE]",
  ];
}

describe("providers", () => {
  it.each(["repetition", "unknown-support-refusal"])(
    "openrouter: caller cancellation prevents the next wire request after %s",
    async (recovery) => {
      if (recovery === "repetition") declarations.push(declaring("response_format"));
      else declarations.push({ status: 503, body: { error: "Metadata unavailable" } });
      responses.push(
        recovery === "repetition"
          ? {
              sse: [
                `data: ${JSON.stringify({ choices: [{ delta: { content: "cycle".repeat(100) } }] })}`,
              ],
            }
          : { status: 400, body: { error: "json_schema unsupported" } },
      );
      responses.push({ sse: sseToolCallCompletion(JSON.stringify(RESULT)) });
      const events: ModelAttemptEvent[] = [];
      let active = true;
      const complete = makeCompleteJson(
        {
          provider: "openrouter",
          model: `some/cancel-binding-recovery-${recovery}`,
          apiKey: "ork",
        },
        "/nonexistent/mock-result.json",
      );
      const failure = await complete({
        system: "S",
        user: "U",
        schema: ExtractionWireSchema,
        retry: {
          canRetry: () => active,
          onAttempt: (event) => {
            events.push(event);
            if (event.outcome === "retrying") active = false;
          },
        },
      }).catch((error: unknown) => modelBoundaryDiagnostic(error));
      expect(failure).toMatchObject({
        binding: "response_format",
        classification: recovery === "repetition" ? "repetition_loop" : "http_error",
      });
      expect(calls).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({
        attempt: 1,
        binding: "response_format",
        outcome: "failed",
        stoppedReason: "Retry cancelled by caller.",
      });
    },
  );

  it.each([false, true])(
    "openrouter: opted-in recovery preserves the original absolute ceiling (retry first=%s)",
    async (retryFirst) => {
      vi.useFakeTimers();
      try {
        declarations.push(declaring("tools", "tool_choice"));
        if (retryFirst) responses.push({ hang: true });
        responses.push({
          sseDrip: {
            intervalMs: 10_000,
            lines: Array.from(
              { length: 40 },
              () => 'data: {"choices":[{"delta":{"reasoning":"synthetic activity"}}]}',
            ),
          },
        });
        const events: ModelAttemptEvent[] = [];
        const complete = makeCompleteJson(
          {
            provider: "openrouter",
            model: `some/absolute-retry-${String(retryFirst)}`,
            apiKey: "ork",
          },
          "/nonexistent/mock-result.json",
        );
        const pending = complete({
          system: "S",
          user: "U",
          schema: ExtractionWireSchema,
          retry: { onAttempt: (event) => events.push(event) },
        }).catch((error: unknown) => modelBoundaryDiagnostic(error));
        let settled = false;
        void pending.then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(2);
        expect(await pending).toMatchObject({
          classification: "request_timeout",
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
        expect(calls).toHaveLength(retryFirst ? 2 : 1);
        expect(events.filter((event) => event.outcome === "failed")).toHaveLength(1);
        expect(events.at(-1)).toMatchObject({
          attempt: retryFirst ? 2 : 1,
          outcome: "failed",
          stoppedReason: "The original request deadline expired.",
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["refusal", "invalid-answer"])(
    "openrouter: opted-in recovery never retries %s",
    async (kind) => {
      declarations.push(declaring("tools", "tool_choice"));
      responses.push(
        kind === "refusal"
          ? { status: 400, body: { error: "tool_choice unsupported" } }
          : { sse: sseToolCallCompletion("invalid JSON") },
      );
      const events: ModelAttemptEvent[] = [];
      const complete = makeCompleteJson(
        { provider: "openrouter", model: `some/no-retry-${kind}`, apiKey: "ork" },
        "/nonexistent/mock-result.json",
      );
      const failure = await complete({
        system: "S",
        user: "U",
        schema: ExtractionWireSchema,
        retry: { onAttempt: (event) => events.push(event) },
      }).catch((error: unknown) => modelBoundaryDiagnostic(error));
      expect(failure).toMatchObject({
        classification: kind === "refusal" ? "http_error" : "answer_not_json",
      });
      expect(calls).toHaveLength(1);
      expect(events).toMatchObject([
        {
          attempt: 1,
          outcome: "failed",
          diagnostic: { classification: kind === "refusal" ? "http_error" : "answer_not_json" },
        },
      ]);
    },
  );

  it("openrouter: reports existing binding recovery without resetting the one-retry allowance", async () => {
    vi.useFakeTimers();
    try {
      declarations.push(declaring("response_format"));
      responses.push({ fail: new Error("First transport failure") });
      responses.push({
        sse: [
          `data: ${JSON.stringify({ choices: [{ delta: { content: "cycle".repeat(100) } }] })}`,
        ],
      });
      responses.push({ fail: new Error("Transport failure after binding recovery") });
      const events: ModelAttemptEvent[] = [];
      const complete = makeCompleteJson(
        { provider: "openrouter", model: "some/retry-then-binding-recovery", apiKey: "ork" },
        "/nonexistent/mock-result.json",
      );
      const pending = complete({
        system: "S",
        user: "U",
        schema: ExtractionWireSchema,
        retry: { onAttempt: (event) => events.push(event) },
      }).catch((error: unknown) => modelBoundaryDiagnostic(error));
      await vi.advanceTimersByTimeAsync(501);
      expect(await pending).toMatchObject({
        classification: "transport_failure",
        binding: "forced_tool_call",
      });
      expect(calls).toHaveLength(3);
      expect(events).toMatchObject([
        { attempt: 1, binding: "response_format", outcome: "retrying", delayMs: 500 },
        {
          attempt: 2,
          binding: "response_format",
          outcome: "retrying",
          delayMs: 0,
          diagnostic: { classification: "repetition_loop" },
        },
        {
          attempt: 3,
          binding: "forced_tool_call",
          outcome: "failed",
          stoppedReason: "The one additional same-binding retry was exhausted.",
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["idle", "transport"])(
    "openrouter: an opted-in %s failure retries the same binding and preserves sanitized attempt history",
    async (failure) => {
      vi.useFakeTimers();
      try {
        declarations.push(declaring("response_format", "tools", "tool_choice"));
        const partial =
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"partial\\":"}}]}}]}';
        responses.push(
          failure === "transport"
            ? { fail: new Error("SECRET provider text") }
            : {
                /* A partial answer and then nothing at all. Keepalives used to
                   stand in for idleness here; since #232 they say the upstream
                   is alive and buffering, which is a different fixture and its
                   own test. This one is the connection going quiet. */
                sseDrip: { intervalMs: 1000, lines: [partial] },
              },
        );
        responses.push({ sse: sseToolCallCompletion(JSON.stringify(RESULT)) });
        const events: ModelAttemptEvent[] = [];
        const complete = makeCompleteJson(
          { provider: "openrouter", model: `some/retry-${failure}`, apiKey: "ork" },
          "/nonexistent/mock-result.json",
        );
        const pending = complete({
          system: "S",
          user: "U",
          schema: ExtractionWireSchema,
          preferredBinding: "forced_tool_call",
          retry: { onAttempt: (event) => events.push(event) },
        }).catch((error: unknown) => modelBoundaryDiagnostic(error));
        await vi.advanceTimersByTimeAsync(31_501);
        expect(await pending).toEqual(RESULT);
        expect(calls).toHaveLength(2);
        expect(calls[1].body).toEqual(calls[0].body);
        expect(calls[0].signal?.aborted).toBe(true);
        expect(events).toMatchObject([
          {
            attempt: 1,
            binding: "forced_tool_call",
            outcome: "retrying",
            delayMs: 500,
            diagnostic: {
              classification: failure === "idle" ? "request_timeout" : "transport_failure",
            },
          },
          { attempt: 2, binding: "forced_tool_call", outcome: "succeeded", diagnostic: null },
        ]);
        expect(JSON.stringify(events)).not.toContain("SECRET");
        expect(JSON.stringify(events)).not.toContain("partial");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("openrouter: persistent opted-in idle failures stop after one additional attempt", async () => {
    vi.useFakeTimers();
    try {
      declarations.push(declaring("tools", "tool_choice"));
      responses.push({ hang: true }, { hang: true });
      const events: ModelAttemptEvent[] = [];
      const complete = makeCompleteJson(
        { provider: "openrouter", model: "some/persistent-opted-retry", apiKey: "ork" },
        "/nonexistent/mock-result.json",
      );
      const pending = complete({
        system: "S",
        user: "U",
        schema: ExtractionWireSchema,
        retry: { onAttempt: (event) => events.push(event) },
      }).catch((error: unknown) => modelBoundaryDiagnostic(error));
      await vi.advanceTimersByTimeAsync(60_501);
      expect(await pending).toMatchObject({
        classification: "request_timeout",
        timeoutMs: STREAM_IDLE_TIMEOUT_MS,
      });
      expect(calls).toHaveLength(2);
      expect(events).toMatchObject([
        { attempt: 1, outcome: "retrying" },
        {
          attempt: 2,
          outcome: "failed",
          stoppedReason: "The one additional same-binding retry was exhausted.",
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("openrouter: insufficient original deadline leaves no room for a retry", async () => {
    vi.useFakeTimers();
    try {
      declarations.push({ ...declaring("tools", "tool_choice"), delayMs: 255_000 });
      responses.push({ hang: true });
      const events: ModelAttemptEvent[] = [];
      const complete = makeCompleteJson(
        { provider: "openrouter", model: "some/no-retry-budget", apiKey: "ork" },
        "/nonexistent/mock-result.json",
      );
      const pending = complete({
        system: "S",
        user: "U",
        schema: ExtractionWireSchema,
        retry: { onAttempt: (event) => events.push(event) },
      }).catch((error: unknown) => modelBoundaryDiagnostic(error));
      await vi.advanceTimersByTimeAsync(300_001);
      expect(await pending).toMatchObject({ classification: "request_timeout" });
      expect(calls).toHaveLength(1);
      expect(events).toMatchObject([
        {
          attempt: 1,
          outcome: "failed",
          stoppedReason: "Insufficient original deadline for backoff and another idle window.",
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("openrouter: caller cancellation during backoff prevents another wire attempt", async () => {
    vi.useFakeTimers();
    try {
      declarations.push(declaring("tools", "tool_choice"));
      responses.push({ hang: true });
      const events: ModelAttemptEvent[] = [];
      let active = true;
      const complete = makeCompleteJson(
        { provider: "openrouter", model: "some/cancel-retry", apiKey: "ork" },
        "/nonexistent/mock-result.json",
      );
      const pending = complete({
        system: "S",
        user: "U",
        schema: ExtractionWireSchema,
        retry: {
          canRetry: () => active,
          onAttempt: (event) => {
            events.push(event);
            if (event.outcome === "retrying") active = false;
          },
        },
      }).catch((error: unknown) => modelBoundaryDiagnostic(error));
      await vi.advanceTimersByTimeAsync(30_501);
      expect(await pending).toMatchObject({ classification: "request_timeout" });
      expect(calls).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({
        attempt: 1,
        outcome: "failed",
        stoppedReason: "Retry cancelled by caller.",
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([
    { label: "reasoning_content", delta: { reasoning_content: "synthetic private activity" } },
    {
      label: "text",
      delta: {
        reasoning_details: [{ type: "reasoning.text", text: "synthetic private activity" }],
      },
    },
    {
      label: "summary",
      delta: {
        reasoning_details: [{ type: "reasoning.summary", summary: "synthetic private activity" }],
      },
    },
    {
      label: "encrypted",
      delta: {
        reasoning_details: [{ type: "reasoning.encrypted", data: "synthetic private activity" }],
      },
    },
  ])(
    "openrouter: $label activity keeps the stream alive without entering its answer",
    async ({ label, delta }) => {
      vi.useFakeTimers();
      try {
        declarations.push(declaring("response_format"));
        const activity = `data: ${JSON.stringify({ choices: [{ delta }] })}`;
        responses.push({
          sseDrip: {
            intervalMs: 20_000,
            lines: [
              activity,
              activity,
              `data: ${JSON.stringify({ choices: [{ delta: { content: '{"answer":"ok"}' } }] })}`,
              "data: [DONE]",
            ],
          },
        });
        const complete = makeCompleteJson(
          { provider: "openrouter", model: `some/reasoning-heartbeat-${label}`, apiKey: "ork" },
          "/nonexistent/mock-result.json",
        );
        const result = complete({
          system: "S",
          user: "U",
          schema: z.object({ answer: z.string() }),
        }).catch((error: unknown) => modelBoundaryDiagnostic(error));
        await vi.advanceTimersByTimeAsync(80_001);
        expect(await result).toEqual({ answer: "ok" });
        expect(calls).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { label: "empty", delta: { reasoning_details: [], reasoning_content: "" } },
    {
      label: "metadata",
      delta: {
        reasoning_details: [
          {
            type: "reasoning.text",
            id: "synthetic-private-id",
            signature: "synthetic-private-signature",
            index: 0,
            format: "unknown",
          },
        ],
      },
    },
    {
      label: "blank",
      delta: {
        reasoning_details: [{ type: "reasoning.summary", summary: " " }],
        reasoning_content: " ",
      },
    },
  ])("openrouter: $label reasoning metadata never becomes an answer", async ({ label, delta }) => {
    vi.useFakeTimers();
    try {
      declarations.push(declaring("response_format"));
      const activity = `data: ${JSON.stringify({ choices: [{ delta }] })}`;
      responses.push({
        sseDrip: { intervalMs: 10_000, lines: Array.from({ length: 20 }, () => activity) },
      });
      const complete = makeCompleteJson(
        {
          provider: "openrouter",
          model: `some/empty-reasoning-heartbeat-${label}`,
          apiKey: "ork",
        },
        "/nonexistent/mock-result.json",
      );
      const result = complete({
        system: "S",
        user: "U",
        schema: z.object({ answer: z.string() }),
      }).catch((error: unknown) => modelBoundaryDiagnostic(error));
      /* These carry no answer, so the call still fails. Since #232 they are
           traffic, so the connection counts as alive and the absolute ceiling
           is what ends it rather than the idle one — the same reason a
           buffering upstream is no longer aborted mid-generation. */
      await vi.advanceTimersByTimeAsync(STREAM_SILENT_TIMEOUT_MS + 1);
      const diagnostic = await result;
      expect(diagnostic).toMatchObject({
        classification: "request_timeout",
        timeoutMs: STREAM_SILENT_TIMEOUT_MS,
      });
      expect(JSON.stringify(diagnostic)).not.toContain("synthetic-private");
    } finally {
      vi.useRealTimers();
    }
  });

  it("openrouter: a stalled stream still names the upstream that was serving it", async () => {
    vi.useFakeTimers();
    try {
      declarations.push(declaring("response_format"));
      /* One model id routes across many upstreams. A refusal body names its
         own; a stream that times out has no body to read it from, so without
         this the difference between "this model cannot do the task" and "that
         route was not answering" is unobservable (#232). */
      const activity = `data: ${JSON.stringify({
        provider: "Z.AI",
        choices: [{ delta: { reasoning: " " } }],
      })}`;
      responses.push({
        sseDrip: { intervalMs: 10_000, lines: Array.from({ length: 20 }, () => activity) },
      });
      const complete = makeCompleteJson(
        { provider: "openrouter", model: "some/stalling-model", apiKey: "ork" },
        "/nonexistent/mock-result.json",
      );
      const result = complete({
        system: "S",
        user: "U",
        schema: z.object({ answer: z.string() }),
      }).catch((error: unknown) => modelBoundaryDiagnostic(error));
      await vi.advanceTimersByTimeAsync(STREAM_SILENT_TIMEOUT_MS + 1);
      expect(await result).toMatchObject({
        classification: "request_timeout",
        timeoutMs: STREAM_SILENT_TIMEOUT_MS,
        upstreamServer: "Z.AI",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("openrouter: a buffering upstream that sends only keepalives is not aborted", async () => {
    vi.useFakeTimers();
    try {
      declarations.push(declaring("tools", "tool_choice"));
      /* Measured behaviour: NextBit delivers an 18,797-character answer in a
         single delta after 57 seconds of nothing but SSE comments. The idle
         ceiling measures gaps between answer tokens, so it killed exactly the
         routes that buffer — while the connection was demonstrably alive. */
      const keepalives = Array.from({ length: 12 }, () => ": OPENROUTER PROCESSING");
      responses.push({
        sseDrip: {
          intervalMs: 5_000,
          lines: [...keepalives, ...sseToolCallCompletion(JSON.stringify(RESULT))],
        },
      });
      const complete = makeCompleteJson(
        { provider: "openrouter", model: "some/buffering-upstream", apiKey: "ork" },
        "/nonexistent/mock-result.json",
      );
      const answered = complete({
        system: "S",
        user: "U",
        schema: z.object({ isTranscript: z.boolean(), summary: z.string() }).passthrough(),
        preferredBinding: "forced_tool_call",
      });
      await vi.advanceTimersByTimeAsync(80_000);
      expect(await answered).toMatchObject({ summary: "ok" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("openrouter: a stream with no traffic at all still hits the idle ceiling", async () => {
    vi.useFakeTimers();
    try {
      declarations.push(declaring("tools", "tool_choice"));
      /* The ceiling's real job: a connection that has gone silent entirely.
         Keepalives are the upstream saying it is alive; nothing is nothing. */
      responses.push({ bodyHang: true });
      const complete = makeCompleteJson(
        { provider: "openrouter", model: "some/dead-stream", apiKey: "ork" },
        "/nonexistent/mock-result.json",
      );
      const result = complete({
        system: "S",
        user: "U",
        schema: z.object({ answer: z.string() }),
        preferredBinding: "forced_tool_call",
      }).catch((error: unknown) => modelBoundaryDiagnostic(error));
      await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1);
      expect(await result).toMatchObject({
        classification: "request_timeout",
        timeoutMs: STREAM_IDLE_TIMEOUT_MS,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("openrouter: asks for the fastest route rather than pinning one", async () => {
    declarations.push(declaring("tools", "tool_choice"));
    responses.push({ sse: sseToolCallCompletion(JSON.stringify(RESULT)) });
    const complete = makeCompleteJson(
      { provider: "openrouter", model: "some/routed", apiKey: "ork" },
      "/nonexistent/mock-result.json",
    );
    await complete({
      system: "S",
      user: "U",
      schema: z.object({ isTranscript: z.boolean() }).passthrough(),
      preferredBinding: "forced_tool_call",
    });
    /* Measured: the same model runs at 28 tok/s on one route and 66-75 tok/s
       on another. Sorting is OpenRouter's own continuous measurement; naming a
       vendor here would be a catalogue label that goes stale. */
    expect(calls[0]?.body.provider).toEqual({ sort: "throughput" });
  });

  it("openrouter: a routing refusal steps the binding down instead of failing", async () => {
    declarations.push(declaring("tools", "tool_choice"));
    /* Observed live: "No endpoints found that support the provided
       'tool_choice' value" — a 404 for a model whose metadata declares
       tool_choice, because the union across endpoints is not a promise that
       any single endpoint honours the whole body. */
    responses.push({
      status: 404,
      body: {
        error: {
          code: 404,
          message: "No endpoints found that support the provided 'tool_choice' value.",
        },
      },
    });
    responses.push({ sse: sseChatCompletion(JSON.stringify(RESULT)) });
    const complete = makeCompleteJson(
      { provider: "openrouter", model: "some/no-tool-choice-endpoint", apiKey: "ork" },
      "/nonexistent/mock-result.json",
    );
    expect(
      await complete({
        system: "S",
        user: "U",
        schema: z.object({ isTranscript: z.boolean(), summary: z.string() }).passthrough(),
        preferredBinding: "forced_tool_call",
      }),
    ).toMatchObject({ summary: "ok" });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body.tool_choice).toBeUndefined();
  });

  it("openrouter: an upstream that ignores forced tool choice steps down", async () => {
    declarations.push(declaring("tools", "tool_choice"));
    /* Measured: gpt-oss-20b and north-mini-code answer finish_reason stop with
       zero tool calls under a forced named function, and do the task in
       content instead. That answer is unusable at this binding and perfectly
       usable at the next one. */
    responses.push({
      sse: [
        `data: {"choices":[{"delta":{"content":${JSON.stringify(JSON.stringify(RESULT))}}}]}`,
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{}}',
        "data: [DONE]",
      ],
    });
    responses.push({ sse: sseChatCompletion(JSON.stringify(RESULT)) });
    const complete = makeCompleteJson(
      { provider: "openrouter", model: "some/ignores-tool-choice", apiKey: "ork" },
      "/nonexistent/mock-result.json",
    );
    expect(
      await complete({
        system: "S",
        user: "U",
        schema: z.object({ isTranscript: z.boolean(), summary: z.string() }).passthrough(),
        preferredBinding: "forced_tool_call",
      }),
    ).toMatchObject({ summary: "ok" });
    expect(calls).toHaveLength(2);
  });

  it("openrouter: a Gemini-family model gets a schema its upstream accepts", async () => {
    declarations.push(declaring("tools", "tool_choice"));
    responses.push({ sse: sseToolCallCompletion(JSON.stringify(RESULT)) });
    const complete = makeCompleteJson(
      { provider: "openrouter", model: "google/gemma-4-31b-it", apiKey: "ork" },
      "/nonexistent/mock-result.json",
    );
    await complete({
      system: "S",
      user: "U",
      schema: z.object({ isTranscript: z.boolean() }).passthrough(),
      preferredBinding: "forced_tool_call",
    });
    /* Live: Google AI Studio answers INVALID_ARGUMENT to the full JSON Schema
       and 200 to a stripped one. The stripping already existed for the direct
       gemini provider; routing through OpenRouter did not reach it. */
    const sent = JSON.stringify(
      (calls[0]?.body.tools as { function?: { parameters?: unknown } }[] | undefined)?.[0]?.function
        ?.parameters,
    );
    expect(sent).not.toContain("additionalProperties");
    expect(sent).not.toContain("$schema");
  });

  it("openrouter: abbreviates wire field names and hands back the caller's own", async () => {
    declarations.push(declaring("tools", "tool_choice"));
    /* Measured on the person-extraction request: a quarter to a third of every
       answer's characters were field names, repeated once per claim, and
       abbreviating them cut output tokens 21% and wall time 15% (#232). */
    responses.push({ sse: sseToolCallCompletion(JSON.stringify({ it: true, su: "ok" })) });
    const complete = makeCompleteJson(
      { provider: "openrouter", model: "some/compact", apiKey: "ork" },
      "/nonexistent/mock-result.json",
    );
    const answer = await complete({
      system: "S",
      user: "U",
      schema: z.object({ isTranscript: z.boolean(), summary: z.string() }),
      preferredBinding: "forced_tool_call",
      compactWireNames: true,
    });
    /* The caller gets its own contract back, whatever went over the wire. */
    expect(answer).toEqual({ isTranscript: true, summary: "ok" });
    const parameters = (
      calls[0]?.body.tools as { function?: { parameters?: { properties?: object } } }[] | undefined
    )?.[0]?.function?.parameters;
    expect(Object.keys(parameters?.properties ?? {})).toEqual(["it", "su"]);
    /* And the model is told what the abbreviations mean, or it cannot comply. */
    const messages = calls[0]?.body.messages as { role: string; content: string }[];
    expect(messages[0]?.content).toContain("it=isTranscript");
    expect(messages[0]?.content).toContain("su=summary");
  });

  it("openrouter: leaves the wire names alone unless the caller opts in", async () => {
    declarations.push(declaring("tools", "tool_choice"));
    responses.push({ sse: sseToolCallCompletion(JSON.stringify(RESULT)) });
    const complete = makeCompleteJson(
      { provider: "openrouter", model: "some/uncompacted", apiKey: "ork" },
      "/nonexistent/mock-result.json",
    );
    await complete({
      system: "S",
      user: "U",
      schema: z.object({ isTranscript: z.boolean(), summary: z.string() }).passthrough(),
      preferredBinding: "forced_tool_call",
    });
    const parameters = (
      calls[0]?.body.tools as { function?: { parameters?: { properties?: object } } }[] | undefined
    )?.[0]?.function?.parameters;
    expect(Object.keys(parameters?.properties ?? {})).toContain("isTranscript");
    expect((calls[0]?.body.messages as { content: string }[])[0]?.content).toBe("S");
  });

  it("openrouter: reconstructs interleaved tool streams by index and selects the first call", async () => {
    declarations.push(declaring("tools", "tool_choice"));
    const delta = (toolCalls: unknown[]) =>
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: toolCalls } }] })}`;
    responses.push({
      sse: [
        delta([
          {
            index: 1,
            id: "call_",
            type: "function",
            function: { name: "save_", arguments: '{"answer":"sec' },
          },
        ]),
        delta([
          {
            index: 0,
            id: "call_",
            type: "function",
            function: { name: "save_", arguments: '{"answer":' },
          },
        ]),
        delta([
          { index: 1, id: "second", function: { name: "extraction", arguments: 'ond"}' } },
          { index: 0, id: "first", function: { name: "extraction", arguments: '"first"}' } },
        ]),
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        "data: [DONE]",
      ],
    });
    const complete = makeCompleteJson(
      { provider: "openrouter", model: "some/interleaved-tool-streams", apiKey: "ork" },
      "/nonexistent/mock-result.json",
    );
    expect(
      await complete({ system: "S", user: "U", schema: z.object({ answer: z.string() }) }),
    ).toEqual({ answer: "first" });
    expect(calls).toHaveLength(1);
  });

  it("openrouter: keeps index-free tool fragments compatible without combining adjacent calls", async () => {
    declarations.push(declaring("tools", "tool_choice"));
    const delta = (toolCalls: unknown[]) =>
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: toolCalls } }] })}`;
    responses.push({
      sse: [
        delta([
          { function: { name: "save_extraction", arguments: '{"answer":' } },
          { function: { name: "save_extraction", arguments: '{"answer":' } },
        ]),
        delta([{ function: { arguments: '"first"}' } }, { function: { arguments: '"second"}' } }]),
        "data: [DONE]",
      ],
    });
    const complete = makeCompleteJson(
      { provider: "openrouter", model: "some/index-free-tool-streams", apiKey: "ork" },
      "/nonexistent/mock-result.json",
    );
    expect(
      await complete({ system: "S", user: "U", schema: z.object({ answer: z.string() }) }),
    ).toEqual({ answer: "first" });
  });

  it("openrouter: rejects an invalid first tool answer even when the second is valid", async () => {
    declarations.push(declaring("tools", "tool_choice"));
    responses.push({
      sse: [
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { name: "save_extraction", arguments: "invalid" } },
                  {
                    index: 1,
                    function: { name: "save_extraction", arguments: '{"answer":"second"}' },
                  },
                ],
              },
            },
          ],
        })}`,
        "data: [DONE]",
      ],
    });
    const complete = makeCompleteJson(
      { provider: "openrouter", model: "some/invalid-first-tool-stream", apiKey: "ork" },
      "/nonexistent/mock-result.json",
    );
    const failure = await complete({
      system: "S",
      user: "U",
      schema: z.object({ answer: z.string() }),
    }).catch((error: unknown) => modelBoundaryDiagnostic(error));
    expect(failure).toMatchObject({
      classification: "answer_not_json",
      binding: "forced_tool_call",
    });
    expect(calls).toHaveLength(1);
  });

  it("ollama: nonstreamed multiple tool calls use the first answer consistently", async () => {
    responses.push({ status: 400, body: { error: "json_schema unsupported" } });
    responses.push({
      body: {
        choices: [
          {
            message: {
              tool_calls: [
                { function: { name: "save_extraction", arguments: '{"answer":"first"}' } },
                { function: { name: "save_extraction", arguments: '{"answer":"second"}' } },
              ],
            },
          },
        ],
      },
    });
    const complete = makeCompleteJson(
      { provider: "ollama", model: "some/multiple-tools", apiKey: "" },
      "/nonexistent/mock-result.json",
    );
    expect(
      await complete({ system: "S", user: "U", schema: z.object({ answer: z.string() }) }),
    ).toEqual({ answer: "first" });
  });

  it("openai: posts json_schema strict with bearer auth and parses content", async () => {
    responses.push({ status: 200, body: chatCompletion(JSON.stringify(RESULT)) });
    const complete = makeCompleteJson(
      { provider: "openai", model: "gpt-5.2", apiKey: "sk-test" },
      "/nonexistent/mock-result.json",
    );
    const parsed = await complete({ system: "S", user: "U", schema: ExtractionWireSchema });
    expect(parsed).toEqual(RESULT);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0].headers.authorization).toBe("Bearer sk-test");
    const body = calls[0].body;
    const responseFormat = body.response_format as Record<string, unknown>;
    expect(responseFormat.type).toBe("json_schema");
    const jsonSchema = responseFormat.json_schema as Record<string, unknown>;
    expect(jsonSchema.name).toBe("extraction_result");
    expect(jsonSchema.strict).toBe(true);
    const schema = jsonSchema.schema as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, unknown>;
    expect(properties).toHaveProperty("tasks");
    expect(properties).toHaveProperty("drafts");
    expect(schema.$schema).toBeUndefined();
    expect(schema.definitions).toBeUndefined();
    expect((properties.tasks as Record<string, unknown>).type).toBe("array");
    expect(body.model).toBe("gpt-5.2");
    expect(body.messages).toEqual([
      { role: "system", content: "S" },
      { role: "user", content: "U" },
    ]);
  });

  it("forwards a requested temperature and omits it when not requested", async () => {
    responses.push({ status: 200, body: chatCompletion(JSON.stringify(RESULT)) });
    const complete = makeCompleteJson(
      { provider: "openai", model: "gpt-5.2", apiKey: "sk-test" },
      "/nonexistent/mock-result.json",
    );
    await complete({ system: "S", user: "U", schema: ExtractionWireSchema, temperature: 0 });
    expect(calls[0].body.temperature).toBe(0);
    responses.push({ status: 200, body: chatCompletion(JSON.stringify(RESULT)) });
    await complete({ system: "S", user: "U", schema: ExtractionWireSchema });
    expect(calls[1].body).not.toHaveProperty("temperature");
  });

  it("anthropic: forces the save_extraction tool and reads its input", async () => {
    responses.push({
      status: 200,
      body: {
        content: [
          { type: "text", text: "working" },
          { type: "tool_use", name: "save_extraction", input: RESULT },
        ],
      },
    });
    const complete = makeCompleteJson(
      { provider: "anthropic", model: "claude-sonnet-5", apiKey: "ak" },
      "/nonexistent/mock-result.json",
    );
    const parsed = await complete({ system: "S", user: "U", schema: ExtractionWireSchema });
    expect(parsed).toEqual(RESULT);
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].headers["x-api-key"]).toBe("ak");
    expect(calls[0].headers["anthropic-version"]).toBe("2023-06-01");
    const body = calls[0].body;
    expect(body.system).toBe("S");
    expect(body.max_tokens).toBe(8192);
    const tools = body.tools as { name: string; input_schema: unknown }[];
    expect(tools[0].name).toBe("save_extraction");
    const inputSchema = tools[0].input_schema as Record<string, unknown>;
    expect((inputSchema.properties ?? {}) as Record<string, unknown>).toHaveProperty("tasks");
    expect(body.tool_choice).toEqual({ type: "tool", name: "save_extraction" });
  });

  it("gemini: posts responseSchema + mime type and parses the text part", async () => {
    responses.push({
      status: 200,
      body: { candidates: [{ content: { parts: [{ text: JSON.stringify(RESULT) }] } }] },
    });
    const complete = makeCompleteJson(
      { provider: "gemini", model: "gemini-3.7-flash", apiKey: "gk" },
      "/nonexistent/mock-result.json",
    );
    const parsed = await complete({ system: "S", user: "U", schema: ExtractionWireSchema });
    expect(parsed).toEqual(RESULT);
    expect(calls[0].url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent?key=gk",
    );
    const body = calls[0].body;
    expect(body.systemInstruction).toEqual({ parts: [{ text: "S" }] });
    const generationConfig = body.generationConfig as Record<string, unknown>;
    expect(generationConfig.responseMimeType).toBe("application/json");
    const schema = generationConfig.responseSchema as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, unknown>;
    expect(properties).toHaveProperty("tasks");
    expect(JSON.stringify(schema)).not.toContain("additionalProperties");
    expect(JSON.stringify(schema)).not.toContain("$ref");
  });

  it("openrouter: posts the openai body shape and asks for the fastest route", async () => {
    declarations.push(declaring("structured_outputs", "response_format"));
    responses.push({ sse: sseChatCompletion(JSON.stringify(RESULT)) });
    const complete = makeCompleteJson(
      { provider: "openrouter", model: "google/gemini-3.7-flash", apiKey: "ork" },
      "/nonexistent/mock-result.json",
    );
    const parsed = await complete({ system: "S", user: "U", schema: ExtractionWireSchema });
    expect(parsed).toEqual(RESULT);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[0].headers.authorization).toBe("Bearer ork");
    expect((calls[0].body.response_format as Record<string, unknown>).type).toBe("json_schema");
    expect(calls[0].body.provider).toEqual({ sort: "throughput" });
  });

  /* An unreadable declaration is the only case that steps down, and it steps to
     the next binding in the ordering rather than to the bottom of it: a model
     that will not take a JSON Schema may still take a forced tool call. */
  it("openrouter: steps down one binding at a time when the declaration is unavailable", async () => {
    responses.push({ status: 400, body: { error: "response_format json_schema not supported" } });
    responses.push({ sse: sseToolCallCompletion(JSON.stringify(RESULT)) });
    const complete = makeCompleteJson(
      { provider: "openrouter", model: "some/undeclared-model", apiKey: "ork" },
      "/nonexistent/mock-result.json",
    );
    const parsed = await complete({ system: "S", user: "U", schema: ExtractionWireSchema });
    expect(parsed).toEqual(RESULT);
    expect(calls).toHaveLength(2);
    expect((calls[0].body.response_format as Record<string, unknown>).type).toBe("json_schema");
    expect(calls[1].body.response_format).toBeUndefined();
    expect(calls[1].body.tool_choice).toEqual({
      type: "function",
      function: { name: "save_extraction" },
    });
    expect(calls[0].body.provider).toEqual({ sort: "throughput" });
    expect(calls[1].body.provider).toEqual({ sort: "throughput" });
  });

  it("openrouter: reaches the prompt only after a tool call is refused too", async () => {
    responses.push({ status: 400, body: { error: "json_schema not supported" } });
    responses.push({ status: 400, body: { error: "tool_choice not supported" } });
    responses.push({ sse: sseChatCompletion(JSON.stringify(RESULT)) });
    const complete = makeCompleteJson(
      { provider: "openrouter", model: "some/bare-model", apiKey: "ork" },
      "/nonexistent/mock-result.json",
    );
    const parsed = await complete({ system: "S", user: "U", schema: ExtractionWireSchema });
    expect(parsed).toEqual(RESULT);
    expect(calls).toHaveLength(3);
    expect(calls[2].body.response_format).toBeUndefined();
    expect(calls[2].body.tools).toBeUndefined();
    const messages = calls[2].body.messages as { role: string; content: string }[];
    expect(messages[0].content).toMatch(
      /^S\n\nReturn exactly one JSON object matching this schema/,
    );
    expect(messages[0].content).toContain('"tasks"');
  });
  /* A streamed binding that emits bulk without terminating is evidence the
     endpoint does not honor the constraint, not a slow answer: the ladder
     steps down one rung rather than riding the ceiling to a failure. */
  it("openrouter: steps down when a streamed binding runs away without terminating", async () => {
    vi.useFakeTimers();
    try {
      const fragment = "x".repeat(1024);
      const runaway = Array.from(
        { length: 48 },
        () => `data: {"choices":[{"delta":{"content":${JSON.stringify(fragment)}}}]}`,
      );
      responses.push({ sseDrip: { lines: runaway, intervalMs: 1000 } });
      responses.push({ sse: sseToolCallCompletion(JSON.stringify(RESULT)) });
      const complete = makeCompleteJson(
        { provider: "openrouter", model: "some/runaway-model", apiKey: "ork" },
        "/nonexistent/mock-result.json",
      );
      const pending = complete({ system: "S", user: "U", schema: ExtractionWireSchema });
      await vi.advanceTimersByTimeAsync(90_000);
      await expect(pending).resolves.toEqual(RESULT);
      expect(calls).toHaveLength(2);
      expect((calls[0].body.response_format as Record<string, unknown>).type).toBe("json_schema");
      expect(calls[1].body.response_format).toBeUndefined();
      expect(calls[1].body.tool_choice).toEqual({
        type: "function",
        function: { name: "save_extraction" },
      });
      expect(calls[0].signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  /* Bulk alone is not runaway: a large answer that arrives promptly must
     complete on its first binding without paying for a fallback. */

  it("openrouter: a fast large answer is not a runaway", async () => {
    /* Varied, not a uniform run: bulk bulk is legitimate; only repetition is
       degenerate, and the padding below would trip the loop rule if it were
       one repeated character. */
    const padding = Array.from({ length: 14_000 }, (_, i) => `y${i} `).join("");
    responses.push({
      sse: [
        `data: {"choices":[{"delta":{"content":${JSON.stringify('{"isTranscript":true,"summary":"')}}}]}`,
        `data: {"choices":[{"delta":{"content":${JSON.stringify(padding)}}}]}`,
        `data: {"choices":[{"delta":{"content":${JSON.stringify('","tasks":[],"drafts":[]}')}}}]}`,
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        "data: [DONE]",
      ],
    });
    const complete = makeCompleteJson(
      { provider: "openrouter", model: "some/verbose-model", apiKey: "ork" },
      "/nonexistent/mock-result.json",
    );
    const parsed = (await complete({
      system: "S",
      user: "U",
      schema: ExtractionWireSchema,
    })) as { isTranscript: boolean; summary: string };
    expect(parsed.isTranscript).toBe(true);
    expect(parsed.summary).toContain("y13999");
    expect(parsed.summary.length).toBeGreaterThan(80_000);
    expect(calls).toHaveLength(1);
  });
  /* The live declared-binding failure: a dossier extraction under
     `response_format` degenerated into repeating one short JSON fragment and
     rode the 120-second ceiling while the tool and prompt rungs completed the
     same input. A declared binding is final for refusals, but observed
     degeneration is not a refusal: with a rung remaining, the ladder spends
     the call's remaining budget on the next binding. */
  it("openrouter: steps down a declared binding whose answer loops", async () => {
    vi.useFakeTimers();
    try {
      declarations.push(declaring("structured_outputs", "response_format"));
      const fragment = "x".repeat(1024);
      responses.push({
        sseDrip: {
          lines: Array.from(
            { length: 48 },
            () => `data: {"choices":[{"delta":{"content":${JSON.stringify(fragment)}}}]}`,
          ),
          intervalMs: 1000,
        },
      });
      responses.push({ sse: sseToolCallCompletion(JSON.stringify(RESULT)) });
      const complete = makeCompleteJson(
        { provider: "openrouter", model: "some/looping-declared-model", apiKey: "ork" },
        "/nonexistent/mock-result.json",
      );
      const pending = complete({ system: "S", user: "U", schema: ExtractionWireSchema });
      await vi.advanceTimersByTimeAsync(90_000);
      await expect(pending).resolves.toEqual(RESULT);
      expect(calls).toHaveLength(2);
      expect((calls[0].body.response_format as Record<string, unknown>).type).toBe("json_schema");
      expect(calls[1].body.tool_choice).toEqual({
        type: "function",
        function: { name: "save_extraction" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  /* A declared answer that keeps saying new things is a slow success: past the
     bulk mark and the idle cadence alike, the first binding finishes the call
     and the ladder must not discard it. */
  it.each([true, false])(
    "openrouter: a slow varied answer finishes (declared=%s)",
    async (declared) => {
      vi.useFakeTimers();
      try {
        if (declared) declarations.push(declaring("structured_outputs", "response_format"));
        const varied = Array.from(
          { length: 40 },
          (_, i) =>
            `data: {"choices":[{"delta":{"content":${JSON.stringify(
              `Record ${i}: ` + Array.from({ length: 100 }, (_, j) => `point ${i}-${j}`).join(", "),
            )}}}]}`,
        );
        responses.push({
          sseDrip: {
            lines: [
              `data: {"choices":[{"delta":{"content":${JSON.stringify('{"isTranscript":true,"summary":"')}}}]}`,
              ...varied,
              `data: {"choices":[{"delta":{"content":${JSON.stringify('","tasks":[],"drafts":[]}')}}}]}`,
              'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
              "data: [DONE]",
            ],
            intervalMs: 1000,
          },
        });
        const complete = makeCompleteJson(
          {
            provider: "openrouter",
            model: `some/verbose-model-${String(declared)}`,
            apiKey: "ork",
          },
          "/nonexistent/mock-result.json",
        );
        const pending = complete({ system: "S", user: "U", schema: ExtractionWireSchema });
        await vi.advanceTimersByTimeAsync(60_000);
        const parsed = (await pending) as { isTranscript: boolean; summary: string };
        expect(parsed.isTranscript).toBe(true);
        expect(parsed.summary).toContain("Record 39: point 39-0");
        expect(parsed.summary).toMatch(/point 39-99$/);
        expect(calls).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  /* The tool-argument surface is an answer surface too: a forced tool call
     whose arguments repeat one fragment forever is the same degeneration, and
     the ladder steps down from it. */
  it("openrouter: steps down when tool arguments loop without finishing", async () => {
    vi.useFakeTimers();
    try {
      declarations.push(declaring("tools", "tool_choice"));
      const argument = '{"k":1}';
      const loopingArgs = JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  type: "function",
                  function: { name: "save_extraction", arguments: argument },
                },
              ],
            },
          },
        ],
      });
      responses.push({
        sseDrip: {
          lines: Array.from({ length: 96 }, () => `data: ${loopingArgs}`),
          intervalMs: 500,
        },
      });
      responses.push({ sse: sseChatCompletion(JSON.stringify(RESULT)) });
      const complete = makeCompleteJson(
        { provider: "openrouter", model: "some/looping-tool-model", apiKey: "ork" },
        "/nonexistent/mock-result.json",
      );
      const pending = complete({ system: "S", user: "U", schema: ExtractionWireSchema });
      await vi.advanceTimersByTimeAsync(90_000);
      await expect(pending).resolves.toEqual(RESULT);
      expect(calls).toHaveLength(2);
      expect(calls[0].body.tool_choice).toEqual({
        type: "function",
        function: { name: "save_extraction" },
      });
      expect(calls[1].body.response_format).toBeUndefined();
      expect(calls[1].body.tool_choice).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("openrouter: a 4xx unrelated to the schema surfaces as an error", async () => {
    responses.push({ status: 401, body: { error: "bad key" } });
    const complete = makeCompleteJson(
      { provider: "openrouter", model: "m", apiKey: "ork" },
      "/nonexistent/mock-result.json",
    );
    await expect(
      complete({ system: "S", user: "U", schema: ExtractionWireSchema }),
    ).rejects.toThrow("HTTP 401");
    expect(calls).toHaveLength(1);
  });

  /* One Shell seam serves every Module and every provider, so the Result Shape
     Binding has to follow what the model declares rather than which provider
     fronts it. This model declares tool calling and not structured outputs. */
  it("openrouter: forces a tool call when the model declares tools and not structured outputs", async () => {
    declarations.push(declaring("tools", "tool_choice", "reasoning"));
    responses.push({ sse: sseToolCallCompletion(JSON.stringify(RESULT)) });
    const complete = makeCompleteJson(
      { provider: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b:free", apiKey: "ork" },
      "/nonexistent/mock-result.json",
    );
    const parsed = await complete({ system: "S", user: "U", schema: ExtractionWireSchema });
    expect(parsed).toEqual(RESULT);
    expect(lookups[0]).toContain("nvidia/nemotron-3-ultra-550b-a55b:free");
    expect(calls).toHaveLength(1);
    const body = calls[0].body;
    expect(body.response_format).toBeUndefined();
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "save_extraction" } });
    const tools = body.tools as {
      type: string;
      function: { name: string; parameters: Record<string, unknown> };
    }[];
    expect(tools[0].type).toBe("function");
    expect(tools[0].function.name).toBe("save_extraction");
    expect(tools[0].function.parameters.properties).toHaveProperty("tasks");
  });

  /* Bindings are ordered by determinism, so declaring both is not ambiguous:
     constrained decoding beats a constrained tool call. */
  it("openrouter: prefers response_format when the model declares structured outputs and tools", async () => {
    declarations.push(declaring("structured_outputs", "response_format", "tools", "tool_choice"));
    responses.push({ sse: sseChatCompletion(JSON.stringify(RESULT)) });
    const complete = makeCompleteJson(
      { provider: "openrouter", model: "openai/gpt-5.2", apiKey: "ork" },
      "/nonexistent/mock-result.json",
    );
    const parsed = await complete({ system: "S", user: "U", schema: ExtractionWireSchema });
    expect(parsed).toEqual(RESULT);
    expect(calls).toHaveLength(1);
    expect((calls[0].body.response_format as Record<string, unknown>).type).toBe("json_schema");
    expect(calls[0].body.tools).toBeUndefined();
    expect(calls[0].body.tool_choice).toBeUndefined();
  });

  it("openrouter: honors a declared tool preference for one request without changing the cached default", async () => {
    declarations.push(declaring("structured_outputs", "response_format", "tools", "tool_choice"));
    responses.push({ sse: sseToolCallCompletion(JSON.stringify(RESULT)) });
    responses.push({ sse: sseChatCompletion(JSON.stringify(RESULT)) });
    const complete = makeCompleteJson(
      { provider: "openrouter", model: "some/request-preference-model", apiKey: "ork" },
      "/nonexistent/mock-result.json",
    );
    expect(
      await complete({
        system: "S",
        user: "U",
        schema: ExtractionWireSchema,
        preferredBinding: "forced_tool_call",
      }),
    ).toEqual(RESULT);
    expect(calls[0].body.response_format).toBeUndefined();
    expect(calls[0].body.tool_choice).toEqual({
      type: "function",
      function: { name: "save_extraction" },
    });
    expect(calls[0].body.provider).toEqual({ sort: "throughput" });
    const tools = calls[0].body.tools as { function: { parameters: Record<string, unknown> } }[];
    expect(tools[0].function.parameters.properties).toHaveProperty("tasks");
    expect(await complete({ system: "S", user: "U", schema: ExtractionWireSchema })).toEqual(
      RESULT,
    );
    expect(calls[1].body.response_format).toBeDefined();
    expect(calls[1].body.tools).toBeUndefined();
    expect(lookups).toHaveLength(1);
  });

  it.each([{ parameters: [] }, { parameters: ["tools"] }, { parameters: ["tool_choice"] }])(
    "openrouter: ignores a tool preference without both declared tool parameters ($parameters)",
    async ({ parameters }) => {
      declarations.push(declaring("response_format", ...parameters));
      responses.push({ sse: sseChatCompletion(JSON.stringify(RESULT)) });
      const complete = makeCompleteJson(
        {
          provider: "openrouter",
          model: `some/unsupported-tool-preference-${parameters.join("-")}`,
          apiKey: "ork",
        },
        "/nonexistent/mock-result.json",
      );
      expect(
        await complete({
          system: "S",
          user: "U",
          schema: ExtractionWireSchema,
          preferredBinding: "forced_tool_call",
        }),
      ).toEqual(RESULT);
      expect(calls[0].body.response_format).toBeDefined();
      expect(calls[0].body.tools).toBeUndefined();
    },
  );

  it("openrouter: unknown metadata does not establish support for a preferred tool binding", async () => {
    declarations.push({ status: 503, body: { error: "Unavailable" } });
    responses.push({ sse: sseChatCompletion(JSON.stringify(RESULT)) });
    const complete = makeCompleteJson(
      { provider: "openrouter", model: "some/unknown-tool-preference", apiKey: "ork" },
      "/nonexistent/mock-result.json",
    );
    expect(
      await complete({
        system: "S",
        user: "U",
        schema: ExtractionWireSchema,
        preferredBinding: "forced_tool_call",
      }),
    ).toEqual(RESULT);
    expect(calls[0].body.response_format).toBeDefined();
    expect(calls[0].body.tools).toBeUndefined();
    expect(calls[0].body.provider).toEqual({ sort: "throughput" });
  });

  it("openai: a tool preference does not change its fixed binding", async () => {
    responses.push({ body: chatCompletion(JSON.stringify(RESULT)) });
    const complete = makeCompleteJson(
      { provider: "openai", model: "fixed-model", apiKey: "key" },
      "/nonexistent/mock-result.json",
    );
    expect(
      await complete({
        system: "S",
        user: "U",
        schema: ExtractionWireSchema,
        preferredBinding: "forced_tool_call",
      }),
    ).toEqual(RESULT);
    expect(calls[0].body.response_format).toBeDefined();
    expect(calls[0].body.tools).toBeUndefined();
  });

  it("openrouter: a preferred declared tool binding does not fall back on refusal", async () => {
    declarations.push(declaring("response_format", "tools", "tool_choice"));
    responses.push({ status: 400, body: { error: "tool_choice is unsupported" } });
    const complete = makeCompleteJson(
      { provider: "openrouter", model: "some/preferred-tool-refusal", apiKey: "ork" },
      "/nonexistent/mock-result.json",
    );
    await expect(
      complete({
        system: "S",
        user: "U",
        schema: ExtractionWireSchema,
        preferredBinding: "forced_tool_call",
      }),
    ).rejects.toThrow("HTTP 400");
    expect(calls).toHaveLength(1);
    expect(calls[0].body.tool_choice).toBeDefined();
  });

  it("openrouter: a preferred declared tool binding does not fall back on timeout", async () => {
    vi.useFakeTimers();
    try {
      declarations.push(declaring("response_format", "tools", "tool_choice"));
      responses.push({ hang: true });
      const complete = makeCompleteJson(
        { provider: "openrouter", model: "some/preferred-tool-timeout", apiKey: "ork" },
        "/nonexistent/mock-result.json",
      );
      const pending = complete({
        system: "S",
        user: "U",
        schema: ExtractionWireSchema,
        preferredBinding: "forced_tool_call",
      }).catch((error: unknown) => modelBoundaryDiagnostic(error));
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
      expect(await pending).toMatchObject({
        binding: "forced_tool_call",
        classification: "request_timeout",
      });
      expect(calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  /* Declaring no support is a decision, not a gap: asking is all that is left,
     and sending a binding the model has said it does not support would waste a
     call. */
  it("openrouter: asks in the prompt when the model declares neither binding", async () => {
    declarations.push(declaring("max_tokens", "temperature"));
    responses.push({ sse: sseChatCompletion(JSON.stringify(RESULT)) });
    const complete = makeCompleteJson(
      { provider: "openrouter", model: "some/plain-model", apiKey: "ork" },
      "/nonexistent/mock-result.json",
    );
    const parsed = await complete({ system: "S", user: "U", schema: ExtractionWireSchema });
    expect(parsed).toEqual(RESULT);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.response_format).toBeUndefined();
    expect(calls[0].body.tools).toBeUndefined();
    expect(calls[0].body.provider).toEqual({ sort: "throughput" });
    const messages = calls[0].body.messages as { role: string; content: string }[];
    expect(messages[0].content).toMatch(
      /^S\n\nReturn exactly one JSON object matching this schema/,
    );
    expect(messages[0].content).toContain('"tasks"');
  });

  /* The Idea Engine runs 12 Stages against one model and Content Scout ranks
     then drafts, so a lookup per completion would be a lookup per Stage. What a
     model supports does not change under us mid-Run. */
  it("openrouter: looks a model's declaration up once and reuses it", async () => {
    declarations.push(declaring("tools", "tool_choice"));
    responses.push({ sse: sseToolCallCompletion(JSON.stringify(RESULT)) });
    responses.push({ sse: sseToolCallCompletion(JSON.stringify(RESULT)) });
    const complete = makeCompleteJson(
      { provider: "openrouter", model: "some/cached-model", apiKey: "ork" },
      "/nonexistent/mock-result.json",
    );
    await complete({ system: "S", user: "U", schema: ExtractionWireSchema });
    await complete({ system: "S", user: "U", schema: ExtractionWireSchema });
    expect(lookups).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(calls[1].body.tool_choice).toEqual({
      type: "function",
      function: { name: "save_extraction" },
    });
  });

  it("ollama: posts to the configured base URL with no auth header", async () => {
    responses.push({ status: 200, body: chatCompletion(JSON.stringify(RESULT)) });
    const complete = makeCompleteJson(
      { provider: "ollama", model: "nemotron", apiKey: "", baseUrl: "http://ollama.test:11434/" },
      "/nonexistent/mock-result.json",
    );
    const parsed = await complete({ system: "S", user: "U", schema: ExtractionWireSchema });
    expect(parsed).toEqual(RESULT);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://ollama.test:11434/v1/chat/completions");
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[0].body.model).toBe("nemotron");
    expect((calls[0].body.response_format as Record<string, unknown>).type).toBe("json_schema");
    expect(calls[0].body.provider).toBeUndefined();
  });

  /* Ollama serves arbitrary local models and has nothing to ask about them, so
     its support is unknown in the same way an unreadable declaration is. */
  it("ollama: steps down to a forced tool call when the model rejects response_format", async () => {
    responses.push({ status: 400, body: { error: "json_schema is not supported" } });
    responses.push({ status: 200, body: toolCallCompletion(JSON.stringify(RESULT)) });
    const complete = makeCompleteJson(
      { provider: "ollama", model: "nemotron", apiKey: "", baseUrl: "http://ollama.test:11434" },
      "/nonexistent/mock-result.json",
    );
    const parsed = await complete({ system: "S", user: "U", schema: ExtractionWireSchema });
    expect(parsed).toEqual(RESULT);
    expect(calls).toHaveLength(2);
    expect(calls[1].body.response_format).toBeUndefined();
    expect(calls[1].body.tool_choice).toEqual({
      type: "function",
      function: { name: "save_extraction" },
    });
    expect(lookups).toHaveLength(0);
  });

  it("mock: returns the workspace mock-result.json when present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "providers-mock-"));
    writeFileSync(
      join(dir, "mock-result.json"),
      JSON.stringify({ ...RESULT, sourceId: "fixture" }),
    );
    const complete = makeCompleteJson(
      { provider: "mock", model: "", apiKey: "" },
      join(dir, "mock-result.json"),
    );
    const parsed = await complete({ system: "S", user: "U", schema: ExtractionWireSchema });
    expect(parsed).toEqual({ ...RESULT, sourceId: "fixture" });
  });

  it("mock: falls back to a skip stub when no mock file exists", async () => {
    const complete = makeCompleteJson(
      { provider: "mock", model: "", apiKey: "" },
      "/nonexistent/mock-result.json",
    );
    const parsed = (await complete({
      system: "S",
      user: "U",
      schema: ExtractionWireSchema,
    })) as Record<string, unknown>;
    expect(parsed.isTranscript).toBe(false);
    expect(parsed.skipReason).toBe("mock: no mock-result.json");
  });
  /* The Shell's one LLM seam serves every Module, and `strict: true` means the
     schema sent is the schema the model obeys. A seam that substituted its own
     shape silently returned another Module's result. */
  it("sends the caller's own schema, not a shape of its own", async () => {
    responses.push({
      sse: sseChatCompletion(JSON.stringify({ markdown: "# Brand Profile" })),
    });
    const complete = makeCompleteJson(
      { provider: "openrouter", model: "some/model", apiKey: "sk-test" },
      "/nonexistent/mock-result.json",
    );
    const parsed = await complete({
      system: "S",
      user: "U",
      schema: z.strictObject({ markdown: z.string() }),
    });
    expect(parsed).toEqual({ markdown: "# Brand Profile" });
    const body = calls[0].body;
    const responseFormat = body.response_format as Record<string, unknown>;
    const jsonSchema = responseFormat.json_schema as Record<string, unknown>;
    const schema = jsonSchema.schema as Record<string, unknown>;
    const properties = schema.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toEqual(["markdown"]);
    expect(properties.tasks).toBeUndefined();
  });
});

/**
 * Every failure crossing the Shell's one LLM seam reaches its caller as a
 * classified model-boundary failure. These assert the diagnostic at the seam's
 * public interface — one case per failure mode — because callers decide
 * retryability and wording from those fields and never from the message.
 */
describe("model-boundary failures", () => {
  /** The diagnostic the seam attached, or a failure that says what arrived instead. */
  async function failureOf(
    complete: ReturnType<typeof makeCompleteJson>,
    request = { system: "S", user: "U", schema: ExtractionWireSchema },
  ): Promise<ModelBoundaryDiagnostic & { message: string }> {
    try {
      await complete(request);
    } catch (error) {
      const diagnostic = modelBoundaryDiagnostic(error);
      if (!diagnostic) throw new Error("failure crossed the seam unclassified", { cause: error });
      return { ...diagnostic, message: error instanceof Error ? error.message : String(error) };
    }
    throw new Error("the call resolved where a failure was expected");
  }

  function openrouter(model: string): ReturnType<typeof makeCompleteJson> {
    return makeCompleteJson(
      { provider: "openrouter", model, apiKey: "ork" },
      "/nonexistent/mock-result.json",
    );
  }

  /* A 0-byte 200 used to surface as "Unexpected end of JSON input" from the JSON
     parser, which names neither the provider nor the fact that nothing arrived. */
  it("classifies a 2xx with no body as an empty body", async () => {
    declarations.push(declaring("tools", "tool_choice"));
    responses.push({ sse: [] });
    const failure = await failureOf(openrouter("some/silent-model"));
    expect(failure.classification).toBe("empty_body");
    expect(failure.provider).toBe("openrouter");
    expect(failure.model).toBe("some/silent-model");
    expect(failure.binding).toBe("forced_tool_call");
    expect(failure.status).toBe(200);
    expect(failure.bodyBytes).toBe(0);
    expect(failure.topLevelKeys).toEqual([]);
    expect(failure.finishReason).toBeNull();
    expect(failure.message).toContain("HTTP 200");
  });

  /* Measured against the live provider: OpenRouter answers HTTP 200 and puts an
     upstream failure in the body, so a status check alone reports a
     response-shape problem for a fault the provider named exactly. */
  it("classifies an upstream failure carried by a 200 response", async () => {
    declarations.push(declaring("tools", "tool_choice"));
    responses.push({
      sse: [
        'data: {"error":{"message":"Upstream error from Nvidia: Service temporarily overloaded","code":502,"metadata":{"provider_name":"Nvidia"}}}',
        "data: [DONE]",
      ],
    });
    const failure = await failureOf(openrouter("some/overloaded-model"));
    expect(failure.classification).toBe("upstream_error");
    expect(failure.upstreamServer).toBe("Nvidia");
    expect(failure.upstreamCode).toBe(502);
    expect(failure.status).toBe(200);
    expect(failure.topLevelKeys).toEqual(["error"]);
    expect(failure.bodyBytes).toBeGreaterThan(0);
  });

  /* The observed defect: the endpoint never declared `response_format`, so the
     answer landed outside `content`. The failure has to say which field was
     populated, because that is what identified the cause. */
  it("classifies a streamed reply with nothing in the binding's field", async () => {
    declarations.push(declaring("structured_outputs", "response_format"));
    responses.push({
      sse: [
        'data: {"choices":[{"delta":{"reasoning":"thinking out loud"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{}}',
        "data: [DONE]",
      ],
    });
    const failure = await failureOf(openrouter("some/reasoning-model"));
    expect(failure.classification).toBe("unusable_shape");
    expect(failure.binding).toBe("response_format");
    expect(failure.finishReason).toBe("stop");
    expect(failure.topLevelKeys).toEqual(["choices"]);
    expect(failure.emptyFields).toContain("choices[0].message.content");
    expect(failure.populatedFields).toContain("choices[0].message.role");
  });

  it("classifies a tool call that returned no tool_calls", async () => {
    declarations.push(declaring("tools", "tool_choice"));
    responses.push({
      sse: ['data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{}}', "data: [DONE]"],
    });
    const failure = await failureOf(openrouter("some/truncating-model"));
    expect(failure.classification).toBe("unusable_shape");
    expect(failure.binding).toBe("forced_tool_call");
    expect(failure.finishReason).toBe("length");
    expect(failure.emptyFields).toEqual(
      expect.arrayContaining(["choices[0].message.content", "choices[0].message.tool_calls"]),
    );
  });

  it("ends a request that hangs before its first token at the idle ceiling", async () => {
    vi.useFakeTimers();
    try {
      declarations.push(declaring("tools", "tool_choice"));
      responses.push({ hang: true });
      const pending = failureOf(openrouter("some/queued-model"));
      await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1);
      const failure = await pending;
      expect(failure.classification).toBe("request_timeout");
      expect(failure.timeoutMs).toBe(STREAM_IDLE_TIMEOUT_MS);
      expect(failure.model).toBe("some/queued-model");
      expect(failure.status).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let transport keepalives hide an idle model and preserves observed response bytes", async () => {
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
        if (input.endsWith("/endpoints"))
          return new Response(
            JSON.stringify({
              data: { endpoints: [{ supported_parameters: ["response_format"] }] },
            }),
          );
        return new Response(
          new ReadableStream({
            start(controller) {
              const timer = setInterval(
                () => controller.enqueue(encoder.encode(": OPENROUTER PROCESSING\n\n")),
                1000,
              );
              init?.signal?.addEventListener("abort", () => {
                clearInterval(timer);
                controller.error(abortError());
              });
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      });
      const pending = failureOf(openrouter("some/keepalive-only-model"));
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      /* Keepalives answer "is the connection alive", never "is there an
         answer". Since #232 they hold the connection ceiling open, so the
         silent ceiling is what ends this — still short of the absolute one, so
         a line kept warm without an answer stays distinguishable from a slow
         generation. */
      await vi.advanceTimersByTimeAsync(STREAM_SILENT_TIMEOUT_MS + 1);
      expect(settled).toBe(true);
      const failure = await pending;
      expect(failure.timeoutMs).toBe(STREAM_SILENT_TIMEOUT_MS);
      expect(failure.status).toBe(200);
      expect(failure.bodyBytes).toBeGreaterThan(0);
      expect(JSON.stringify(failure)).not.toContain("OPENROUTER PROCESSING");
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves response observations when active generation reaches the absolute ceiling", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
        if (input.endsWith("/endpoints"))
          return new Response(
            JSON.stringify({
              data: { endpoints: [{ supported_parameters: ["response_format"] }] },
            }),
          );
        return new Response(
          new ReadableStream({
            start(controller) {
              let fragment = 0;
              const timer = setInterval(
                () =>
                  controller.enqueue(
                    new TextEncoder().encode(
                      `data: {"choices":[{"delta":{"content":"private-answer-${(fragment += 1)}-ends"}}]}\n\n`,
                    ),
                  ),
                1000,
              );
              init?.signal?.addEventListener("abort", () => {
                clearInterval(timer);
                controller.error(abortError());
              });
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      });
      const pending = failureOf(openrouter("some/slow-active-model"));
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
      const failure = await pending;
      expect(failure.timeoutMs).toBe(REQUEST_TIMEOUT_MS);
      expect(failure.status).toBe(200);
      expect(failure.bodyBytes).toBeGreaterThan(0);
      expect(JSON.stringify(failure)).not.toContain("private-answer-fragment");
    } finally {
      vi.useRealTimers();
    }
  });
  /* The last rung has nowhere to step: an answer that repeats one short unit
     there still fails, immediately, with the loop named as the cause and the
     bytes it delivered preserved as observed evidence. */
  it("fails a looping answer on the final binding instead of looping", async () => {
    vi.useFakeTimers();
    try {
      declarations.push(declaring("temperature"));
      const fragment = "x".repeat(1024);
      responses.push({
        sseDrip: {
          lines: Array.from(
            { length: 96 },
            () => `data: {"choices":[{"delta":{"content":${JSON.stringify(fragment)}}}]}`,
          ),
          intervalMs: 500,
        },
      });
      const pending = failureOf(openrouter("some/runaway-final-model"));
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(150_000);
      expect(settled).toBe(true);
      const failure = await pending;
      expect(failure.classification).toBe("repetition_loop");
      expect(failure.binding).toBe("prompt_only");
      expect(failure.status).toBe(200);
      expect(failure.bodyBytes).toBeGreaterThan(1024);
      expect(calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  /* A declared binding rides out its timeouts even when the bulk arrives as
     reasoning: without a fallback rung an early abort only turns a slow
     success into a fast failure. */
  it("does not end a declared reasoning stream early", async () => {
    vi.useFakeTimers();
    try {
      declarations.push(declaring("structured_outputs", "response_format"));
      const fragment = "r".repeat(1024);
      responses.push({
        sseDrip: {
          lines: Array.from(
            { length: 96 },
            () =>
              `data: {"choices":[{"delta":{"content":"","reasoning":${JSON.stringify(fragment)}}}]}`,
          ),
          intervalMs: 500,
        },
      });
      const pending = failureOf(openrouter("some/slow-thinker-model"));
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(45_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(105_000);
      expect(settled).toBe(true);
      const failure = await pending;
      expect(failure.classification).toBe("request_timeout");
      expect(failure.timeoutMs).toBe(STREAM_IDLE_TIMEOUT_MS);
      expect(failure.binding).toBe("response_format");
      expect(calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  /* A stall carries no bulk, so there is no evidence the binding is at fault:
     stepping down would only spend a second ceiling on the same hung route. */
  it("does not step down a stalled stream without bulk", async () => {
    vi.useFakeTimers();
    try {
      responses.push({ bodyHang: true });
      const pending = failureOf(openrouter("some/stalled-model"));
      await vi.advanceTimersByTimeAsync(40_000);
      const failure = await pending;
      expect(failure.classification).toBe("request_timeout");
      expect(failure.bodyBytes).toBe(0);
      expect(calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("includes the model capability lookup in the request ceiling", async () => {
    vi.useFakeTimers();
    try {
      declarations.push({ hang: true });
      const pending = failureOf(openrouter("some/lookup-stalled-model"));
      let settled = false;
      void pending.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);

      expect(settled).toBe(true);
      const failure = await pending;
      expect(failure.classification).toBe("request_timeout");
      expect(failure.model).toBe("some/lookup-stalled-model");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the response body read inside the request ceiling", async () => {
    vi.useFakeTimers();
    try {
      declarations.push(declaring("tools", "tool_choice"));
      responses.push({ bodyHang: true });
      const pending = failureOf(openrouter("some/body-stalled-model"));
      let settled = false;
      void pending.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);

      expect(settled).toBe(true);
      const failure = await pending;
      expect(failure.classification).toBe("request_timeout");
      expect(failure.model).toBe("some/body-stalled-model");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares one request ceiling across binding step-down attempts", async () => {
    vi.useFakeTimers();
    try {
      responses.push({
        status: 400,
        body: { error: "json_schema not supported" },
        delayMs: 10_000,
      });
      responses.push({
        status: 400,
        body: { error: "tool_choice not supported" },
        delayMs: 10_000,
      });
      responses.push({ hang: true });
      const pending = failureOf(openrouter("some/slow-step-down-model"));
      let settled = false;
      void pending.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);

      expect(settled).toBe(true);
      const failure = await pending;
      expect(failure.classification).toBe("request_timeout");
      expect(failure.model).toBe("some/slow-step-down-model");
      expect(failure.timeoutMs).toBe(STREAM_IDLE_TIMEOUT_MS);
      expect(calls).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies a status outside 2xx", async () => {
    responses.push({ status: 401, body: { error: "bad key" } });
    const failure = await failureOf(openrouter("some/model"));
    expect(failure.classification).toBe("http_error");
    expect(failure.status).toBe(401);
    expect(failure.message).toContain("HTTP 401");
  });

  it("classifies an error event carried inside the stream", async () => {
    declarations.push(declaring("response_format"));
    responses.push({
      sse: ['data: {"error":{"message":"upstream overloaded","code":504}}', "data: [DONE]"],
    });
    const failure = await failureOf(openrouter("some/mid-stream-failure-model"));
    expect(failure.classification).toBe("upstream_error");
    expect(failure.status).toBe(200);
  });

  it("classifies an answer field that holds text which is not JSON", async () => {
    declarations.push(declaring("max_tokens"));
    responses.push({ sse: sseChatCompletion("Sure! Here are the tasks:") });
    const failure = await failureOf(openrouter("some/chatty-model"));
    expect(failure.classification).toBe("answer_not_json");
    expect(failure.binding).toBe("prompt_only");
    expect(failure.populatedFields).toContain("choices[0].message.content");
  });

  it("classifies a request that never reached the provider", async () => {
    declarations.push(declaring("tools", "tool_choice"));
    responses.push({ fail: new TypeError("fetch failed") });
    const failure = await failureOf(openrouter("some/unreachable-model"));
    expect(failure.classification).toBe("transport_failure");
    expect(failure.status).toBeNull();
    expect(failure.bodyBytes).toBe(0);
  });

  it("classifies the runtime's native headers timeout as a request timeout", async () => {
    declarations.push(declaring("tools", "tool_choice"));
    responses.push({
      fail: Object.assign(new TypeError("fetch failed"), {
        cause: { code: "UND_ERR_HEADERS_TIMEOUT" },
      }),
    });
    const failure = await failureOf(openrouter("some/native-timeout-model"));
    expect(failure.classification).toBe("request_timeout");
    expect(failure.timeoutMs).toBe(REQUEST_TIMEOUT_MS);
  });

  it("ends a stream that never sends a token at the idle ceiling", async () => {
    vi.useFakeTimers();
    try {
      declarations.push(declaring("response_format"));
      responses.push({ status: 200, bodyHang: true });
      const pending = failureOf(openrouter("some/hung-stream-model"));
      await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1);
      const failure = await pending;
      expect(failure.classification).toBe("request_timeout");
      expect(failure.timeoutMs).toBe(STREAM_IDLE_TIMEOUT_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  /* Transcripts are private and Source Items are untrusted third-party evidence.
     A provider that echoes the request back in an error body must not be able to
     put any of it into a durable failure. */
  it("retains no payload text, even when the provider echoes the request back", async () => {
    const secret = "Acquisition of Northwind closes on Tuesday";
    responses.push({
      status: 400,
      body: { error: { message: `invalid request: ${secret}`, code: 400 } },
    });
    const failure = await failureOf(
      makeCompleteJson(
        { provider: "openai", model: "gpt-5.2", apiKey: "sk" },
        "/nonexistent/mock-result.json",
      ),
      { system: "S", user: secret, schema: ExtractionWireSchema },
    );
    expect(failure.classification).toBe("http_error");
    expect(JSON.stringify(failure)).not.toContain("Northwind");
    expect(failure.message).not.toContain("Northwind");
  });

  it("classifies every provider's failures, not only the OpenAI-shaped ones", async () => {
    responses.push({ status: 200, body: { stop_reason: "max_tokens", content: [] } });
    const anthropic = await failureOf(
      makeCompleteJson(
        { provider: "anthropic", model: "claude-sonnet-5", apiKey: "ak" },
        "/nonexistent/mock-result.json",
      ),
    );
    expect(anthropic.classification).toBe("unusable_shape");
    expect(anthropic.provider).toBe("anthropic");
    expect(anthropic.finishReason).toBe("max_tokens");
    expect(anthropic.emptyFields).toContain("content");

    responses.push({
      status: 200,
      body: { candidates: [{ finishReason: "SAFETY", content: { parts: [] } }] },
    });
    const gemini = await failureOf(
      makeCompleteJson(
        { provider: "gemini", model: "gemini-3.7-flash", apiKey: "gk" },
        "/nonexistent/mock-result.json",
      ),
    );
    expect(gemini.classification).toBe("unusable_shape");
    expect(gemini.provider).toBe("gemini");
    expect(gemini.finishReason).toBe("SAFETY");
    expect(gemini.emptyFields).toContain("candidates[0].content.parts");
  });
});

/**
 * OpenRouter serves one model from many upstream routes and picks per call, so
 * the same model fails in unrelated ways from one call to the next: a
 * repetition loop, a stalled buffer, a capacity refusal. These assert the two
 * controls that keep one bad route from costing a whole operation — the route
 * rests, and the binding ladder has somewhere to step.
 */
describe("openrouter route rests and the binding ladder", () => {
  function openrouter(model: string): ReturnType<typeof makeCompleteJson> {
    return makeCompleteJson(
      { provider: "openrouter", model, apiKey: "ork" },
      "/nonexistent/mock-result.json",
    );
  }

  /** The routing block one call sent, as OpenRouter received it. */
  function routing(index: number): Record<string, unknown> {
    return calls[index].body.provider as Record<string, unknown>;
  }

  /** A stream that names its route and then repeats one unit until something stops it. */
  function sseLoopFrom(route: string, lines = 48): { lines: string[]; intervalMs: number } {
    const fragment = "x".repeat(1024);
    return {
      lines: Array.from(
        { length: lines },
        () =>
          `data: {"provider":${JSON.stringify(route)},"choices":[{"delta":{"content":${JSON.stringify(fragment)}}}]}`,
      ),
      intervalMs: 1000,
    };
  }

  it("skips the route that looped on the next call of the same run", async () => {
    vi.useFakeTimers();
    try {
      declarations.push(declaring("structured_outputs", "response_format"));
      responses.push({ sseDrip: sseLoopFrom("Wafer") });
      responses.push({ sse: sseToolCallCompletion(JSON.stringify(RESULT)) });
      const pending = openrouter("some/looping-route-model")({
        system: "S",
        user: "U",
        schema: ExtractionWireSchema,
      });
      await vi.advanceTimersByTimeAsync(90_000);
      await expect(pending).resolves.toEqual(RESULT);
      expect(calls).toHaveLength(2);
      /* Sorting alone would be free to hand the next call straight back to the
         route that just burned this one. */
      expect(routing(0)).toEqual({ sort: "throughput" });
      expect(routing(1)).toEqual({ sort: "throughput", ignore: ["Wafer"] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a rest across separate calls, and keeps it to the model that earned it", async () => {
    vi.useFakeTimers();
    try {
      declarations.push(declaring("temperature"));
      responses.push({ sseDrip: sseLoopFrom("Together") });
      const failed = openrouter("some/rest-outlives-the-call")({
        system: "S",
        user: "U",
        schema: ExtractionWireSchema,
      }).catch((error: unknown) => modelBoundaryDiagnostic(error));
      await vi.advanceTimersByTimeAsync(90_000);
      expect(await failed).toMatchObject({ classification: "repetition_loop" });

      /* A different `completeJson` object: `makeCompleteJson` is rebuilt per
         attempt, so a rest kept in its closure would be forgotten here. */
      declarations.push(declaring("temperature"));
      responses.push({ sse: sseChatCompletion(JSON.stringify(RESULT)) });
      await expect(
        openrouter("some/rest-outlives-the-call")({
          system: "S",
          user: "U",
          schema: ExtractionWireSchema,
        }),
      ).resolves.toEqual(RESULT);
      expect(routing(1)).toEqual({ sort: "throughput", ignore: ["Together"] });

      /* The same route can serve one model well and another badly, so a rest
         is per model and route, never per route alone. */
      declarations.push(declaring("temperature"));
      responses.push({ sse: sseChatCompletion(JSON.stringify(RESULT)) });
      await expect(
        openrouter("some/other-model-same-route")({
          system: "S",
          user: "U",
          schema: ExtractionWireSchema,
        }),
      ).resolves.toEqual(RESULT);
      expect(routing(2)).toEqual({ sort: "throughput" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rests a route that refused for capacity", async () => {
    declarations.push(declaring("temperature"));
    responses.push({
      status: 429,
      body: {
        error: {
          message: "Provider returned error",
          code: 429,
          metadata: { provider_name: "DeepInfra" },
        },
      },
    });
    const failed = await openrouter("some/rate-limited-route")({
      system: "S",
      user: "U",
      schema: ExtractionWireSchema,
    }).catch((error: unknown) => modelBoundaryDiagnostic(error));
    expect(failed).toMatchObject({ classification: "http_error", upstreamServer: "DeepInfra" });

    declarations.push(declaring("temperature"));
    responses.push({ sse: sseChatCompletion(JSON.stringify(RESULT)) });
    await expect(
      openrouter("some/rate-limited-route")({
        system: "S",
        user: "U",
        schema: ExtractionWireSchema,
      }),
    ).resolves.toEqual(RESULT);
    expect(routing(1)).toEqual({ sort: "throughput", ignore: ["DeepInfra"] });
  });

  /* A route that names a fault of its own is not a route that cannot serve the
     call: the upstream answered, said what went wrong, and may well answer the
     next one. Resting on every failure alike would empty the routing pool. */
  it("rests nothing when the upstream named its own fault", async () => {
    declarations.push(declaring("temperature"));
    responses.push({
      sse: [
        'data: {"error":{"message":"Upstream error","code":502,"metadata":{"provider_name":"Novita"}}}',
        "data: [DONE]",
      ],
    });
    const failed = await openrouter("some/named-upstream-fault")({
      system: "S",
      user: "U",
      schema: ExtractionWireSchema,
    }).catch((error: unknown) => modelBoundaryDiagnostic(error));
    expect(failed).toMatchObject({ classification: "upstream_error" });

    declarations.push(declaring("temperature"));
    responses.push({ sse: sseChatCompletion(JSON.stringify(RESULT)) });
    await expect(
      openrouter("some/named-upstream-fault")({
        system: "S",
        user: "U",
        schema: ExtractionWireSchema,
      }),
    ).resolves.toEqual(RESULT);
    expect(routing(1)).toEqual({ sort: "throughput" });
  });

  /* The measured cost of stepping only downwards: a request that prefers a
     forced tool call starts halfway down the ladder, and the rung it skipped
     is the one that streams incrementally on routes that buffer a tool call. */
  it("steps a preferred forced tool call back up to a declared response_format", async () => {
    vi.useFakeTimers();
    try {
      declarations.push(declaring("structured_outputs", "response_format", "tools", "tool_choice"));
      responses.push({ sseDrip: sseLoopFrom("NextBit") });
      responses.push({ sse: sseChatCompletion(JSON.stringify(RESULT)) });
      const pending = openrouter("some/preferred-tool-call-model")({
        system: "S",
        user: "U",
        schema: ExtractionWireSchema,
        preferredBinding: "forced_tool_call",
      });
      await vi.advanceTimersByTimeAsync(90_000);
      await expect(pending).resolves.toEqual(RESULT);
      expect(calls).toHaveLength(2);
      expect(calls[0].body.tool_choice).toEqual({
        type: "function",
        function: { name: "save_extraction" },
      });
      expect((calls[1].body.response_format as Record<string, unknown>).type).toBe("json_schema");
    } finally {
      vi.useRealTimers();
    }
  });

  /* And the bound on that: an absence in the declaration is an absence across
     every endpoint, so the ladder steps down past it rather than spending a
     call proving it. */
  it("does not step up to a binding the model never declared", async () => {
    vi.useFakeTimers();
    try {
      declarations.push(declaring("tools", "tool_choice"));
      responses.push({ sseDrip: sseLoopFrom("Makora") });
      responses.push({ sse: sseChatCompletion(JSON.stringify(RESULT)) });
      const pending = openrouter("some/tool-only-model")({
        system: "S",
        user: "U",
        schema: ExtractionWireSchema,
        preferredBinding: "forced_tool_call",
      });
      await vi.advanceTimersByTimeAsync(90_000);
      await expect(pending).resolves.toEqual(RESULT);
      expect(calls).toHaveLength(2);
      expect(calls[1].body.response_format).toBeUndefined();
      expect(calls[1].body.tool_choice).toBeUndefined();
      expect(calls[1].body.messages).toMatchObject([{ role: "system" }, { role: "user" }]);
    } finally {
      vi.useRealTimers();
    }
  });
});
