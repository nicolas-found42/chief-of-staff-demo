/** Diagnostic harness: records timing/shape only, never credentials or transcript output. */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { AsyncLocalStorage } from "node:async_hooks";
import { buildDebriefMessages } from "../../apps/server/src/modules/meeting-debrief/extraction.js";
import { makeCompleteJson } from "../../apps/server/src/llm/providers.js";
import { modelBoundaryDiagnostic } from "../../apps/server/src/llm/failure.js";
import type { TranscriptRecord } from "../../packages/shared/src/transcript.js";

const model = "inception/mercury-2.5";
const mode = process.argv[2] ?? "serial";
const samples = Number(process.argv[3] ?? 3);
const concurrency = Number(process.argv[4] ?? 1);
const originalFetch = globalThis.fetch;
type Attempt = {
  headersMs: number;
  status: number;
  binding: string;
  chunks: number;
  pings: number;
  bytes: number;
  firstByteMs: number | null;
  firstAnswerMs: number | null;
  firstReasoningMs: number | null;
  maxWireGapMs: number;
  maxAnswerGapMs: number;
  answerChars: number;
  upstream?: string | undefined;
};
type Trace = {
  model: string;
  mode: string;
  sample: number;
  concurrency: number;
  inputChars: number;
  attempts: Attempt[];
  valid?: boolean;
  outcome?: string;
  diagnostic?: unknown;
  totalMs?: number;
};
type Event = {
  provider?: string;
  choices?: {
    delta?: {
      content?: string;
      tool_calls?: { function?: { arguments?: string } }[];
      reasoning?: string;
      reasoning_content?: string;
      reasoning_details?: unknown[];
    };
  }[];
};
const context = new AsyncLocalStorage<Trace>();
const results: Trace[] = [];
globalThis.fetch = async (url, options) => {
  const trace = context.getStore();
  const address = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
  if (!trace || !address.includes("/chat/completions")) return originalFetch(url, options);
  if (typeof options?.body !== "string")
    throw new Error("Expected JSON request body for timing probe");
  const began = performance.now();
  const response = await originalFetch(url, options);
  const request = JSON.parse(options.body) as {
    tools?: unknown;
    response_format?: unknown;
  };
  const attempt: Attempt = {
    headersMs: performance.now() - began,
    status: response.status,
    binding: request.tools
      ? "forced_tool_call"
      : request.response_format
        ? "response_format"
        : "prompt_only",
    chunks: 0,
    pings: 0,
    bytes: 0,
    firstByteMs: null,
    firstAnswerMs: null,
    firstReasoningMs: null,
    maxWireGapMs: 0,
    maxAnswerGapMs: 0,
    answerChars: 0,
  };
  trace.attempts.push(attempt);
  let lastWire = began,
    lastAnswer = began,
    buffer = "";
  const decoder = new TextDecoder();
  const body = response.body?.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        const now = performance.now();
        attempt.chunks++;
        attempt.bytes += chunk.byteLength;
        attempt.firstByteMs ??= now - began;
        attempt.maxWireGapMs = Math.max(attempt.maxWireGapMs, now - lastWire);
        lastWire = now;
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith(":")) attempt.pings++;
          if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
          try {
            const event = JSON.parse(line.slice(5)) as Event;
            attempt.upstream ??= event.provider;
            const delta = event.choices?.[0]?.delta;
            const answer =
              (typeof delta?.content === "string" ? delta.content : "") +
              (delta?.tool_calls ?? []).map((call) => call.function?.arguments ?? "").join("");
            if (answer) {
              attempt.firstAnswerMs ??= now - began;
              if (attempt.answerChars)
                attempt.maxAnswerGapMs = Math.max(attempt.maxAnswerGapMs, now - lastAnswer);
              lastAnswer = now;
              attempt.answerChars += answer.length;
            }
            if (delta?.reasoning || delta?.reasoning_content || delta?.reasoning_details?.length)
              attempt.firstReasoningMs ??= now - began;
          } catch {
            /* incomplete/non-JSON SSE line carries no content timing */
          }
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};
const text = await readFile(
  "tests/fixtures/operational-handoff/2026-09-09-found42-stand-up.md",
  "utf8",
);
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error("OPENROUTER_API_KEY is required");
const complete = makeCompleteJson({ provider: "openrouter", model, apiKey: key }, "");
let next = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next < samples) {
      const sample = next++;
      const record = {
        id: "timing-probe",
        source: { fileName: "2026-09-09.md" },
        meetingDate: "2026-09-09",
        normalizedText: text,
        roster: [],
        speakers: [],
        occurrence: null,
      } as unknown as TranscriptRecord;
      const messages = buildDebriefMessages(record, {
        mentions: [],
        decisions: [],
        organizations: [],
      });
      const result: Trace = {
        model,
        mode,
        sample,
        concurrency,
        inputChars: messages.user.length,
        attempts: [],
      };
      const began = performance.now();
      await context.run(result, async () => {
        try {
          const answer = await complete({
            ...messages,
            temperature: 0,
            ...(mode === "tool" ? { preferredBinding: "forced_tool_call" as const } : {}),
          });
          result.valid = messages.schema.safeParse(answer).success;
          result.outcome = "answered";
        } catch (error) {
          result.outcome = "failed";
          result.diagnostic = modelBoundaryDiagnostic(error);
        }
      });
      result.totalMs = performance.now() - began;
      results.push(result);
      console.log(JSON.stringify(result));
      await mkdir("/tmp/mercury-timeout-research", { recursive: true });
      await writeFile(
        `/tmp/mercury-timeout-research/${mode}-c${concurrency}.json`,
        JSON.stringify(results, null, 2),
      );
    }
  }),
);
