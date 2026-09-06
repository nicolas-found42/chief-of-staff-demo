import { readFile } from "node:fs/promises";
import type { ZodType, ZodTypeDef } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  type ProviderId,
  type ResultShapeBinding,
  type ModelAttemptEvent,
  DEFAULT_OLLAMA_BASE_URL,
  MODEL_REQUEST_TIMEOUT_MS,
  MODEL_STREAM_IDLE_TIMEOUT_MS,
  RESULT_SHAPE_BINDINGS,
} from "@chief-of-staff-demo/shared";
import {
  modelBoundaryDiagnostic,
  modelBoundaryFailure,
  type AnswerContainer,
  type ModelBoundaryError,
  type ModelCall,
} from "./failure.js";

/**
 * Any Module's wire schema. Spelled without Zod's `any` generics so that
 * handing one to `zodToJsonSchema` stays type-safe.
 */
type WireSchema = ZodType<unknown, ZodTypeDef, unknown>;

export interface LlmConfig {
  provider: ProviderId;
  model: string;
  apiKey: string;
  /** Ollama only: where the local server listens. */
  baseUrl?: string;
}

interface CompletionRequest {
  system: string;
  user: string;
  /**
   * Request-local preference among bindings the OpenRouter model declares.
   * Honored only when both tools and tool_choice are declared; unknown or
   * unsupported preferences leave the strongest supported default intact.
   * Other providers retain their existing binding policy (ADR-0065).
   */
  preferredBinding?: "forced_tool_call";
  /** One bounded same-binding retry; recovered failures must remain observable. */
  retry?: {
    onAttempt: (event: ModelAttemptEvent) => void;
    /** Optional lifecycle fence, rechecked after backoff before another request. */
    canRetry?: () => boolean;
  };
  /**
   * Sampling temperature. Omitted → the upstream's own default, exactly as
   * before; extraction Modules set 0 so a transcript yields one extraction,
   * not a fresh sample per run.
   */
  temperature?: number;
  /**
   * The result shape this one call must return. Required, and deliberately so:
   * one Shell seam serves every Module, `strict: true` means the schema sent is
   * the schema obeyed, and a default here would hand a Module another Module's
   * shape without saying so. Every caller names its own.
   */
  schema: WireSchema;
}

export type CompleteJson = (request: CompletionRequest) => Promise<unknown>;
/** The ceiling on one model call. Exported so a test can drive it deterministically. */
export const REQUEST_TIMEOUT_MS = MODEL_REQUEST_TIMEOUT_MS;

/** The streaming idle ceiling. Exported so a test can drive it deterministically. */
export const STREAM_IDLE_TIMEOUT_MS = MODEL_STREAM_IDLE_TIMEOUT_MS;

interface RequestDeadline {
  signal: AbortSignal;
  timeRemaining(): number;
  reportAttempt(event: Omit<ModelAttemptEvent, "attempt" | "binding">): void;
  calling(call: ModelCall): void;
  observed(response: { status: number; bodyBytes: number }): void;
}

/** One provider answer, kept only as long as it takes to classify or read it. */
interface HttpResponse {
  status: number;
  text: string;
}

/**
 * One answered call, ready to be read or classified. The call, the response and
 * the parsed payload travel together because every failure below needs all
 * three: the call says what was asked, the response sizes what came back, and
 * the payload holds the shape.
 */
interface ModelReply {
  call: ModelCall;
  response: HttpResponse;
  payload: unknown;
}

/** The reply for a call whose body has passed classification. */
function modelReply(call: ModelCall, response: HttpResponse): ModelReply {
  return { call, response, payload: parseProviderPayload(call, response) };
}

type JsonObject = Record<string, unknown>;

/**
 * `Array.isArray` narrows `unknown` to `any[]`, and every element read off it is
 * then untyped — which defeats the point of the shape checks below. This
 * narrows to `unknown[]`, so each element still has to be checked before use.
 */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * JSON Schema handed to OpenAI / OpenRouter / Anthropic. The Zod source is the
 * caller's (all fields required, nullable optionals) because OpenAI strict
 * json_schema rejects non-required properties.
 */
function wireJsonSchema(source: WireSchema): JsonObject {
  const converted = zodToJsonSchema(source, {
    $refStrategy: "none",
  }) as JsonObject;
  /* OpenAI strict json_schema rejects the $schema key zod-to-json-schema adds. */
  delete converted.$schema;
  return converted;
}

function geminiWireSchema(source: WireSchema): JsonObject {
  const converted = zodToJsonSchema(source, {
    target: "openApi3",
    $refStrategy: "none",
  }) as JsonObject;
  return stripUnsupportedKeys(converted) as JsonObject;
}

function stripUnsupportedKeys(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(stripUnsupportedKeys);
  }
  if (typeof node === "object" && node !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$schema" || key === "additionalProperties") {
        continue;
      }
      out[key] = stripUnsupportedKeys(value);
    }
    return out;
  }
  return node;
}

/** The call context every failure at this seam is classified against. */
function modelCall(cfg: LlmConfig, binding: ResultShapeBinding): ModelCall {
  return { provider: cfg.provider, model: cfg.model, binding };
}

async function postJson(
  call: ModelCall,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  deadline: RequestDeadline,
): Promise<HttpResponse> {
  deadline.calling(call);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: deadline.signal,
    });
    return { status: response.status, text: await response.text() };
  } catch (error) {
    if (isRequestTimeout(error)) {
      throw modelBoundaryFailure({
        call,
        classification: "request_timeout",
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
    }
    throw modelBoundaryFailure({ call, classification: "transport_failure" });
  }
}

/**
 * POST one OpenAI-shaped chat completion as an SSE stream and read it back as
 * the plain completion `postJson` would have returned, so everything above the
 * transport — classification, binding extraction — is unchanged. Activity is a
 * token-bearing `data:` event: the keep-alive comments OpenRouter sends
 * between events (`: OPENROUTER PROCESSING`) prove a route, not a model, so
 * they do not reset the idle timer. Errors before the stream starts are plain
 * non-2xx JSON and take the same classification path as `postJson`; errors
 * mid-generation arrive as `data:` events carrying an `error` field.
 */
async function postSseStream(
  call: ModelCall,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  deadline: RequestDeadline,
): Promise<HttpResponse> {
  deadline.calling(call);
  /* The idle timer owns the wire; the seam's ceiling aborts the same wire, so
     either one ends the fetch, and the abort's origin names the timeout. */
  const idle = new AbortController();
  const onOuterAbort = (): void => idle.abort();
  deadline.signal.addEventListener("abort", onOuterAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(), STREAM_IDLE_TIMEOUT_MS);
  };
  armIdle();
  const observed: { status?: number; bodyBytes: number } = { bodyBytes: 0 };
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: idle.signal,
      });
      observed.status = response.status;
      deadline.observed({ status: response.status, bodyBytes: 0 });
    } catch (error) {
      throw requestTimeoutOrTransport(call, deadline.signal, error);
    }
    if (response.status < 200 || response.status >= 300) {
      /* Classify exactly like postJson: the refusal body carries the facts. */
      return { status: response.status, text: await response.text() };
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw modelBoundaryFailure({ call, classification: "transport_failure" });
    }
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    const toolCalls = new Map<
      number,
      {
        id: string;
        type: string;
        name: string;
        arguments: string;
        hasFunction: boolean;
        hasArguments: boolean;
        checked: number;
      }
    >();
    let finishReason: string | null = null;
    /* The answer surfaces are re-tested for degenerate repetition only after
       this much new text, so a trickle of one-character deltas does not
       rescan the whole answer per token. */
    let contentChecked = 0;
    const seen = { data: false };
    /** Fail the attempt once an answer surface repeats itself without finishing. */
    const checkDegenerate = (answer: string, checked: number): number => {
      if (answer.length - checked < REPEAT_CHECK_STEP) return checked;
      if (degenerateRepeat(answer)) {
        throw modelBoundaryFailure({
          call,
          classification: "repetition_loop",
          status: response.status,
          bodyBytes: observed.bodyBytes,
        });
      }
      return answer.length;
    };
    const consume = (line: string): boolean => {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith(":")) return false;
      if (!trimmed.startsWith("data:")) return false;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return true;
      seen.data = true;
      const chunk = tryParse(data);
      if (chunk === undefined) return false;
      if (carriesUpstreamError(chunk)) {
        throw modelBoundaryFailure({
          call,
          classification: "upstream_error",
          status: response.status,
          body: data,
          payload: chunk,
        });
      }
      if (typeof chunk !== "object" || chunk === null || !("choices" in chunk)) return false;
      const choices = chunk.choices;
      if (!isUnknownArray(choices) || choices.length === 0) return false;
      const choice = choices[0];
      if (typeof choice !== "object" || choice === null) return false;
      if ("delta" in choice && typeof choice.delta === "object" && choice.delta !== null) {
        const delta = choice.delta;
        if ("content" in delta && typeof delta.content === "string" && delta.content.length) {
          content += delta.content;
          armIdle();
        }
        /* Reasoning tokens establish activity but their contents never enter
           the answer or diagnostics. Transport comments establish neither. */
        if (carriesReasoningActivity(delta)) armIdle();
        if ("tool_calls" in delta && isUnknownArray(delta.tool_calls)) {
          for (const [position, toolCall] of delta.tool_calls.entries()) {
            if (typeof toolCall !== "object" || toolCall === null) continue;
            /* Indices identify streams, not arrival order. Older compatible
               responses omit them; their array position supplies the index. */
            const index = "index" in toolCall ? toolCall.index : position;
            if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) continue;
            const accumulated = toolCalls.get(index) ?? {
              id: "",
              type: "",
              name: "",
              arguments: "",
              hasFunction: false,
              hasArguments: false,
              checked: 0,
            };
            toolCalls.set(index, accumulated);
            if ("id" in toolCall && typeof toolCall.id === "string") accumulated.id += toolCall.id;
            if ("type" in toolCall && typeof toolCall.type === "string")
              accumulated.type = toolCall.type;
            if (!("function" in toolCall)) continue;
            const fn = toolCall.function;
            if (typeof fn !== "object" || fn === null) continue;
            accumulated.hasFunction = true;
            if ("name" in fn && typeof fn.name === "string") accumulated.name += fn.name;
            if ("arguments" in fn && typeof fn.arguments === "string") {
              accumulated.hasArguments = true;
              accumulated.arguments += fn.arguments;
              if (fn.arguments.length) armIdle();
            }
          }
        }
      }
      if ("finish_reason" in choice && typeof choice.finish_reason === "string") {
        finishReason = choice.finish_reason;
      }
      return false;
    };
    let done = false;
    for (;;) {
      const read = await readChunk(reader);
      if (!read.ok) {
        /* The abort's origin names the timeout: the seam's ceiling or the idle
           timer — which, before the first token, is also the first-token cap. */
        throw requestTimeoutOrTransport(call, deadline.signal, read.error, observed);
      }
      if (read.chunk.done) break;
      observed.bodyBytes += read.chunk.value.byteLength;
      deadline.observed({ status: response.status, bodyBytes: observed.bodyBytes });
      buffer += decoder.decode(read.chunk.value, { stream: true });
      for (;;) {
        const lineEnd = buffer.indexOf("\n");
        if (lineEnd === -1) break;
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 1);
        if (consume(line)) {
          done = true;
          break;
        }
      }
      /* A finished stream is never scanned: a close the provider sent is the
         answer, and garbage in it is the schema's and judge's to catch. An
         open stream gets its answer surfaces scanned for degenerate
         repetition. */
      if (done) break;
      contentChecked = checkDegenerate(content, contentChecked);
      for (const toolCall of toolCalls.values())
        toolCall.checked = checkDegenerate(toolCall.arguments, toolCall.checked);
    }
    let message: JsonObject = { role: "assistant", content };
    if (call.binding === "forced_tool_call") {
      /* Reconstruct the provider's array in index order. The existing reader
         selects its first call, exactly as for nonstreamed replies; malformed
         first arguments never borrow from a later call or select its answer. */
      message = {
        role: "assistant",
        content: null,
        tool_calls: [...toolCalls]
          .sort(([a], [b]) => a - b)
          .map(([, toolCall]) => ({
            ...(toolCall.id ? { id: toolCall.id } : {}),
            ...(toolCall.type ? { type: toolCall.type } : {}),
            ...(toolCall.hasFunction
              ? {
                  function: {
                    ...(toolCall.name ? { name: toolCall.name } : {}),
                    ...(toolCall.hasArguments ? { arguments: toolCall.arguments } : {}),
                  },
                }
              : {}),
          })),
      };
    }
    /* A stream that ended without a single token is an empty body, and is
       classified as one — not as an answer that said nothing. */
    if (!seen.data) return { status: response.status, text: "" };
    return {
      status: 200,
      text: JSON.stringify({ choices: [{ index: 0, message, finish_reason: finishReason }] }),
    };
  } finally {
    clearTimeout(timer);
    idle.abort();
    deadline.signal.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * OpenRouter streams reasoning as text, an alias, or typed detail deltas.
 * Only actual nonblank payload establishes activity; signatures and indices
 * alone do not. This predicate never assembles or retains reasoning.
 * https://openrouter.ai/docs/guides/best-practices/reasoning-tokens
 */
function carriesReasoningActivity(delta: object): boolean {
  const nonblank = (value: unknown) => typeof value === "string" && value.trim().length > 0;
  if ("reasoning" in delta && nonblank(delta.reasoning)) return true;
  if ("reasoning_content" in delta && nonblank(delta.reasoning_content)) return true;
  if (!("reasoning_details" in delta) || !isUnknownArray(delta.reasoning_details)) return false;
  return delta.reasoning_details.some((detail) => {
    if (typeof detail !== "object" || detail === null || !("type" in detail)) return false;
    return (
      (detail.type === "reasoning.text" && "text" in detail && nonblank(detail.text)) ||
      (detail.type === "reasoning.summary" && "summary" in detail && nonblank(detail.summary)) ||
      (detail.type === "reasoning.encrypted" && "data" in detail && nonblank(detail.data))
    );
  });
}

/** The timeout whose ceiling fired, or a transport fault when neither did. */
function requestTimeoutOrTransport(
  call: ModelCall,
  ceilingSignal: AbortSignal,
  error: unknown,
  observed: { status?: number; bodyBytes: number } = { bodyBytes: 0 },
): ModelBoundaryError {
  if (ceilingSignal.aborted) {
    return modelBoundaryFailure({
      ...observed,
      call,
      classification: "request_timeout",
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
  }
  if (error instanceof Error && error.name === "AbortError") {
    return modelBoundaryFailure({
      ...observed,
      call,
      classification: "request_timeout",
      timeoutMs: STREAM_IDLE_TIMEOUT_MS,
    });
  }
  if (isRequestTimeout(error)) {
    return modelBoundaryFailure({
      ...observed,
      call,
      classification: "request_timeout",
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
  }
  return modelBoundaryFailure({ ...observed, call, classification: "transport_failure" });
}

/** One stream read, with its failure carried instead of thrown. */
async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>) {
  try {
    return { ok: true as const, chunk: await reader.read() };
  } catch (error) {
    return { ok: false as const, error };
  }
}

function isRequestTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return true;
  const cause = (error as Error & { cause?: unknown }).cause;
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return false;
  return cause.code === "UND_ERR_HEADERS_TIMEOUT" || cause.code === "UND_ERR_BODY_TIMEOUT";
}

/** Whether a provider body carries a failure envelope alongside its 2xx status. */
function carriesUpstreamError(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return false;
  const error = payload.error;
  if (typeof error === "string") return error !== "";
  return typeof error === "object" && error !== null;
}

/**
 * The provider's parsed body, or a classified failure saying why there is none.
 * Providers answer HTTP 200 and carry the failure in the body, so a status check
 * alone reports a response-shape problem for a fault they named exactly.
 */
function parseProviderPayload(call: ModelCall, response: HttpResponse): unknown {
  const parsed = tryParse(response.text);
  if (response.status < 200 || response.status >= 300) {
    /* The body is parsed even here, for the structural facts a refusal carries —
       its top-level keys, the upstream that refused, and the code it gave. */
    throw modelBoundaryFailure({
      call,
      classification: "http_error",
      status: response.status,
      body: response.text,
      payload: parsed,
    });
  }
  if (response.text.trim() === "") {
    throw modelBoundaryFailure({
      call,
      classification: "empty_body",
      status: response.status,
      body: response.text,
    });
  }
  if (parsed === undefined) {
    throw modelBoundaryFailure({
      call,
      classification: "unparseable_body",
      status: response.status,
      body: response.text,
    });
  }
  if (carriesUpstreamError(parsed)) {
    throw modelBoundaryFailure({
      call,
      classification: "upstream_error",
      status: response.status,
      body: response.text,
      payload: parsed,
    });
  }
  return parsed;
}

/** The parsed body, or `undefined` when the text is not JSON. */
function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Where a reply puts the answer, named as far down as the reply actually goes.
 * A failure has to report the fields of the deepest container that arrived,
 * because "the shape was wrong" is exactly what withheld the cause. OpenAI-shaped
 * replies nest it under `choices[0].message` and Gemini under
 * `candidates[0].content`; the walk is the same one.
 */
function locateAnswer(payload: unknown, listKey: string, childKey: string): AnswerContainer {
  if (
    typeof payload === "object" &&
    payload !== null &&
    listKey in payload &&
    isUnknownArray((payload as JsonObject)[listKey])
  ) {
    const list = (payload as JsonObject)[listKey] as unknown[];
    const first = list.length > 0 ? list[0] : null;
    if (typeof first === "object" && first !== null) {
      return childKey in first
        ? { path: `${listKey}[0].${childKey}`, value: (first as JsonObject)[childKey] }
        : { path: `${listKey}[0]`, value: first };
    }
  }
  return { path: "", value: payload };
}

/** Read `choices[0].message.content` from an OpenAI-shaped chat completion. */
function readChatCompletionContent(reply: ModelReply, answer: AnswerContainer): string {
  const message = answer.value;
  if (
    typeof message === "object" &&
    message !== null &&
    "content" in message &&
    typeof message.content === "string" &&
    message.content !== ""
  ) {
    return message.content;
  }
  throw unusableShape(reply, answer);
}

/** Read the forced tool call's arguments from an OpenAI-shaped chat completion. */
function readToolCallArguments(reply: ModelReply, answer: AnswerContainer): string {
  const message = answer.value;
  if (
    typeof message === "object" &&
    message !== null &&
    "tool_calls" in message &&
    isUnknownArray(message.tool_calls) &&
    message.tool_calls.length > 0
  ) {
    const first = message.tool_calls[0];
    if (typeof first === "object" && first !== null && "function" in first) {
      const fn = first.function;
      if (
        typeof fn === "object" &&
        fn !== null &&
        "arguments" in fn &&
        typeof fn.arguments === "string"
      ) {
        return fn.arguments;
      }
    }
  }
  throw unusableShape(reply, answer);
}

/** The Result Shape from an OpenAI-shaped reply, out of whichever field the binding used. */
function readChatResultShape(reply: ModelReply): unknown {
  const answer = locateAnswer(reply.payload, "choices", "message");
  const text =
    reply.call.binding === "forced_tool_call"
      ? readToolCallArguments(reply, answer)
      : readChatCompletionContent(reply, answer);
  return parseAnswer(reply, answer, text);
}

/** The Result Shape from a Gemini reply, which always arrives as text. */
function readGeminiResultShape(reply: ModelReply): unknown {
  const answer = locateAnswer(reply.payload, "candidates", "content");
  return parseAnswer(reply, answer, readGeminiText(reply, answer));
}

/** Read the first `tool_use` block's input from an Anthropic messages response. */
function readToolUseInput(reply: ModelReply): unknown {
  const payload = reply.payload;
  if (
    typeof payload === "object" &&
    payload !== null &&
    "content" in payload &&
    isUnknownArray(payload.content)
  ) {
    for (const block of payload.content) {
      if (
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "tool_use" &&
        "input" in block
      ) {
        return block.input;
      }
    }
  }
  /* The blocks are an array, so the body itself is the deepest named container. */
  throw unusableShape(reply, { path: "", value: payload });
}

/** Read `candidates[0].content.parts[0].text` from a Gemini response. */
function readGeminiText(reply: ModelReply, answer: AnswerContainer): string {
  const content = answer.value;
  if (
    typeof content === "object" &&
    content !== null &&
    "parts" in content &&
    isUnknownArray(content.parts) &&
    content.parts.length > 0
  ) {
    const part = content.parts[0];
    if (
      typeof part === "object" &&
      part !== null &&
      "text" in part &&
      typeof part.text === "string" &&
      part.text !== ""
    ) {
      return part.text;
    }
  }
  throw unusableShape(reply, answer);
}

function unusableShape(reply: ModelReply, answer: AnswerContainer): ModelBoundaryError {
  return modelBoundaryFailure({
    call: reply.call,
    classification: "unusable_shape",
    status: reply.response.status,
    body: reply.response.text,
    payload: reply.payload,
    answer,
  });
}

/**
 * The answer as JSON. The parse error is deliberately not carried: it quotes the
 * text it choked on, and that text is the model's reply to a private transcript.
 */
function parseAnswer(reply: ModelReply, answer: AnswerContainer, text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw modelBoundaryFailure({
      call: reply.call,
      classification: "answer_not_json",
      status: reply.response.status,
      body: reply.response.text,
      payload: reply.payload,
      answer,
    });
  }
}

async function openaiComplete(
  cfg: LlmConfig,
  request: CompletionRequest,
  schema: JsonObject,
  deadline: RequestDeadline,
): Promise<unknown> {
  const call = modelCall(cfg, "response_format");
  const response = await postJson(
    call,
    "https://api.openai.com/v1/chat/completions",
    { authorization: `Bearer ${cfg.apiKey}` },
    {
      model: cfg.model,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "extraction_result", strict: true, schema },
      },
    },
    deadline,
  );
  return readChatResultShape(modelReply(call, response));
}

async function anthropicComplete(
  cfg: LlmConfig,
  request: CompletionRequest,
  schema: JsonObject,
  deadline: RequestDeadline,
): Promise<unknown> {
  const call = modelCall(cfg, "forced_tool_call");
  const response = await postJson(
    call,
    "https://api.anthropic.com/v1/messages",
    { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
    {
      model: cfg.model,
      max_tokens: 8192,
      system: request.system,
      messages: [{ role: "user", content: request.user }],
      tools: [
        {
          name: "save_extraction",
          description: "Save the extraction result.",
          input_schema: schema,
        },
      ],
      tool_choice: { type: "tool", name: "save_extraction" },
    },
    deadline,
  );
  return readToolUseInput(modelReply(call, response));
}

async function geminiComplete(
  cfg: LlmConfig,
  request: CompletionRequest,
  responseSchema: JsonObject,
  deadline: RequestDeadline,
): Promise<unknown> {
  const call = modelCall(cfg, "response_format");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  const response = await postJson(
    call,
    url,
    {},
    {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: "user", parts: [{ text: request.user }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema,
      },
    },
    deadline,
  );
  return readGeminiResultShape(modelReply(call, response));
}

/**
 * The prompt-only binding has no provider-side shape constraint, so the Result
 * Shape itself travels in the prompt: the field descriptions alone leave the
 * model without the schema. Provider-constrained bindings keep the Module's
 * prompt verbatim — the shape rides in response_format or in the tool's
 * parameters.
 */
function promptOnlySystem(system: string, schema: JsonObject): string {
  return `${system}\n\nReturn exactly one JSON object matching this schema, and nothing else — no prose, no markdown fences, no fields beyond it:\n${JSON.stringify(schema, null, 2)}`;
}

/** The OpenAI-shaped chat-completion body that asks for one Result Shape Binding. */
function chatCompletionBody(
  binding: ResultShapeBinding,
  cfg: LlmConfig,
  request: CompletionRequest,
  schema: JsonObject,
): JsonObject {
  const body: JsonObject = {
    model: cfg.model,
    messages: [
      {
        role: "system",
        content:
          binding === "prompt_only" ? promptOnlySystem(request.system, schema) : request.system,
      },
      { role: "user", content: request.user },
    ],
  };
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (binding === "response_format") {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "extraction_result", strict: true, schema },
    };
  }
  if (binding === "forced_tool_call") {
    body.tools = [
      {
        type: "function",
        function: {
          name: "save_extraction",
          description: "Save the extraction result.",
          parameters: schema,
        },
      },
    ];
    body.tool_choice = { type: "function", function: { name: "save_extraction" } };
  }
  return body;
}

/**
 * OpenAI-shaped chat completion, shared by OpenRouter and Ollama: both front
 * many models, and those models differ in which Result Shape Bindings they
 * support. The binding is chosen by the caller from what the model declares.
 */
async function openAiCompatibleComplete(
  url: string,
  headers: Record<string, string>,
  cfg: LlmConfig,
  request: CompletionRequest,
  schema: JsonObject,
  declared: ResultShapeBinding | null,
  deadline: RequestDeadline,
  stream: boolean,
): Promise<unknown> {
  /* A declared binding is sent first. An unknown one
     starts at the most deterministic binding and gives up one step at a time,
     because a model that refuses a JSON Schema may still honour a tool call. */
  let index = declared === null ? 0 : RESULT_SHAPE_BINDINGS.indexOf(declared);
  let retried = false;
  let recoveryFailure: { error: unknown } | null = null;
  for (;;) {
    /* Every recovery route crosses this fence, including binding changes and
       cancellation triggered by the observer of the previous attempt. */
    if (recoveryFailure && request.retry?.canRetry?.() === false) {
      deadline.reportAttempt({
        outcome: "failed",
        diagnostic: modelBoundaryDiagnostic(recoveryFailure.error) ?? null,
        delayMs: 0,
        stoppedReason: "Retry cancelled by caller.",
      });
      throw recoveryFailure.error;
    }
    const call = modelCall(cfg, RESULT_SHAPE_BINDINGS[index] ?? "prompt_only");
    const body = chatCompletionBody(call.binding, cfg, request, schema);
    if (stream) body.stream = true;
    /* OpenRouter unions endpoint declarations, so a declared binding can still
       land on an endpoint that refuses it; require_parameters holds routing to
       endpoints that declare everything the body sends. Withheld when the
       declaration is unreadable: the step-down ladder recognizes a refusal by
       the binding's name in the upstream error, and a no-endpoints routing
       failure names none. */
    if (cfg.provider === "openrouter" && declared !== null) {
      body.provider = { require_parameters: true };
    }
    let response: HttpResponse;
    try {
      response = await (stream
        ? postSseStream(call, url, headers, body, deadline)
        : postJson(call, url, headers, body, deadline));
    } catch (error) {
      const diagnostic = modelBoundaryDiagnostic(error) ?? null;
      const retryable =
        diagnostic?.classification === "transport_failure" ||
        (diagnostic?.classification === "request_timeout" &&
          diagnostic.timeoutMs === STREAM_IDLE_TIMEOUT_MS);
      if (request.retry && retryable) {
        let stoppedReason = deadline.signal.aborted
          ? "The original request deadline expired."
          : request.retry.canRetry?.() === false
            ? "Retry cancelled by caller."
            : retried
              ? "The one additional same-binding retry was exhausted."
              : deadline.timeRemaining() < STREAM_IDLE_TIMEOUT_MS + 500
                ? "Insufficient original deadline for backoff and another idle window."
                : null;
        if (!stoppedReason) {
          retried = true;
          deadline.reportAttempt({
            outcome: "retrying",
            diagnostic,
            delayMs: 500,
            stoppedReason: null,
          });
          await retryBackoff(deadline.signal);
          stoppedReason = deadline.signal.aborted
            ? "The original request deadline expired."
            : request.retry.canRetry?.() === false
              ? "Retry cancelled by caller."
              : deadline.timeRemaining() < STREAM_IDLE_TIMEOUT_MS
                ? "Insufficient original deadline for another idle window."
                : null;
          if (!stoppedReason) {
            recoveryFailure = { error };
            continue;
          }
        }
        deadline.reportAttempt({ outcome: "failed", diagnostic, delayMs: 0, stoppedReason });
        throw error;
      }
      /* ADR-0064 permits recovery from sustained answer repetition even on a
         declared binding. The next binding gets the call's remaining budget;
         the final binding preserves the repetition failure. */
      if (
        index < RESULT_SHAPE_BINDINGS.length - 1 &&
        !deadline.signal.aborted &&
        modelBoundaryDiagnostic(error)?.classification === "repetition_loop"
      ) {
        deadline.reportAttempt({
          outcome: "retrying",
          diagnostic,
          delayMs: 0,
          stoppedReason: null,
        });
        recoveryFailure = { error };
        index += 1;
        continue;
      }
      throw error;
    }
    if (
      declared === null &&
      index < RESULT_SHAPE_BINDINGS.length - 1 &&
      refusesBinding(call.binding, response)
    ) {
      const failure = modelBoundaryFailure({
        call,
        classification: "http_error",
        status: response.status,
        body: response.text,
      });
      deadline.reportAttempt({
        outcome: "retrying",
        diagnostic: modelBoundaryDiagnostic(failure) ?? null,
        delayMs: 0,
        stoppedReason: null,
      });
      recoveryFailure = { error: failure };
      index += 1;
      continue;
    }
    return readChatResultShape(modelReply(call, response));
  }
}

/** Backoff shares the request's deadline and cannot keep an aborted call alive. */
async function retryBackoff(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, 500);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/**
 * The shortest repeated stretch that proves a degenerate answer. The live
 * extraction loop repeated a ~24-character JSON fragment indefinitely, so
 * units up to 64 characters are checked; the shortest test needs 256
 * characters and the proportional minimum of sixteen repeats together keep
 * ordinary varied answers out while any real loop trips within a few hundred
 * characters of the stream.
 */
const REPEAT_MAX_PERIOD = 64;
const REPEAT_MIN_STRETCH = 256;
const REPEAT_MIN_REPEATS = 16;
/** Repetition is re-tested only after this much new answer text has arrived. */
const REPEAT_CHECK_STEP = 64;

function degenerateRepeat(value: string): boolean {
  for (let period = 1; period <= REPEAT_MAX_PERIOD; period++) {
    const stretch = Math.max(REPEAT_MIN_STRETCH, period * REPEAT_MIN_REPEATS);
    if (value.length < stretch) continue;
    const tail = value.slice(-stretch);
    let periodic = true;
    for (let i = period; i < tail.length; i++) {
      if (tail[i] !== tail[i - period]) {
        periodic = false;
        break;
      }
    }
    if (periodic) return true;
  }
  return false;
}

/** Whether a 4xx says the model will not honour the binding that was sent. */
function refusesBinding(binding: ResultShapeBinding, response: HttpResponse): boolean {
  if (response.status < 400 || response.status >= 500) return false;
  if (binding === "response_format") {
    return /response_format|json_schema|structured output/i.test(response.text);
  }
  if (binding === "forced_tool_call") {
    return /tool_choice|tools|function call/i.test(response.text);
  }
  return false;
}

/**
 * What each model declares, for this process's lifetime. `makeCompleteJson` is
 * rebuilt per attempt, so the cache cannot live in its closure. The promise is
 * cached rather than its result so that concurrent Stages share one lookup.
 */
const openrouterDeclarations = new Map<string, Promise<Set<string> | null>>();

/**
 * The `supported_parameters` an OpenRouter model declares, or `null` when the
 * declaration cannot be read — which is not the same as declaring no support.
 */
function openrouterDeclaredParameters(
  cfg: LlmConfig,
  deadline: RequestDeadline,
): Promise<Set<string> | null> {
  const cached = openrouterDeclarations.get(cfg.model);
  if (cached) return cached;
  const pending = fetchDeclaredParameters(cfg, deadline.signal);
  openrouterDeclarations.set(cfg.model, pending);
  return pending;
}

async function fetchDeclaredParameters(
  cfg: LlmConfig,
  signal: AbortSignal,
): Promise<Set<string> | null> {
  try {
    const response = await fetch(`https://openrouter.ai/api/v1/models/${cfg.model}/endpoints`, {
      headers: { authorization: `Bearer ${cfg.apiKey}` },
      signal,
    });
    if (!response.ok) return null;
    return readDeclaredParameters(await response.json());
  } catch {
    return null;
  }
}

function readDeclaredParameters(payload: unknown): Set<string> | null {
  if (typeof payload !== "object" || payload === null || !("data" in payload)) return null;
  const data = payload.data;
  if (typeof data !== "object" || data === null || !("endpoints" in data)) return null;
  if (!isUnknownArray(data.endpoints)) return null;
  const declared = new Set<string>();
  for (const endpoint of data.endpoints) {
    if (
      typeof endpoint !== "object" ||
      endpoint === null ||
      !("supported_parameters" in endpoint) ||
      !isUnknownArray(endpoint.supported_parameters)
    ) {
      continue;
    }
    for (const parameter of endpoint.supported_parameters) {
      if (typeof parameter === "string") declared.add(parameter);
    }
  }
  return declared.size > 0 ? declared : null;
}

/**
 * A supported request preference, otherwise the strongest declared binding.
 * `null` means there is no declaration to read, not that no binding is supported;
 * only unknown support permits the ordinary refusal step-down ladder.
 */
function declaredBinding(
  declared: Set<string> | null,
  preferred?: CompletionRequest["preferredBinding"],
): ResultShapeBinding | null {
  if (!declared) return null;
  if (preferred === "forced_tool_call" && declared.has("tools") && declared.has("tool_choice"))
    return "forced_tool_call";
  if (declared.has("structured_outputs") || declared.has("response_format")) {
    return "response_format";
  }
  if (declared.has("tools") && declared.has("tool_choice")) return "forced_tool_call";
  return "prompt_only";
}

async function openrouterComplete(
  cfg: LlmConfig,
  request: CompletionRequest,
  schema: JsonObject,
  deadline: RequestDeadline,
): Promise<unknown> {
  return openAiCompatibleComplete(
    "https://openrouter.ai/api/v1/chat/completions",
    { authorization: `Bearer ${cfg.apiKey}` },
    cfg,
    request,
    schema,
    declaredBinding(await openrouterDeclaredParameters(cfg, deadline), request.preferredBinding),
    deadline,
    true,
  );
}

/**
 * A model served locally by Ollama, through its OpenAI-compatible endpoint. No
 * key is needed for a local server, so the auth header is sent only when one is
 * configured (some deployments sit behind a proxy that wants it).
 */
function ollamaComplete(
  cfg: LlmConfig,
  request: CompletionRequest,
  schema: JsonObject,
  deadline: RequestDeadline,
): Promise<unknown> {
  const base = (cfg.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, "");
  return openAiCompatibleComplete(
    `${base}/v1/chat/completions`,
    cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
    cfg,
    request,
    schema,
    null,
    deadline,
    false,
  );
}

async function mockComplete(mockResultPath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(mockResultPath, "utf8"));
  } catch {
    return {
      version: 1,
      sourceId: "",
      sourceFileName: "",
      sourceUrl: null,
      processedAt: new Date().toISOString(),
      isTranscript: false,
      skipReason: "mock: no mock-result.json",
      summary: "",
      tasks: [],
      drafts: [],
    };
  }
}

function initialCall(cfg: LlmConfig): ModelCall {
  return modelCall(cfg, cfg.provider === "anthropic" ? "forced_tool_call" : "response_format");
}

async function withinRequestCeiling<T>(
  cfg: LlmConfig,
  retry: CompletionRequest["retry"],
  work: (deadline: RequestDeadline) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const expiresAt = Date.now() + REQUEST_TIMEOUT_MS;
  let call = initialCall(cfg);
  let attempt = 0;
  let terminalReported = false;
  const reportAttempt: RequestDeadline["reportAttempt"] = (event) => {
    if (!attempt || terminalReported) return;
    if (event.outcome !== "retrying") terminalReported = true;
    retry?.onAttempt({ ...event, attempt, binding: call.binding });
  };
  let observed: { status?: number; bodyBytes: number } = { bodyBytes: 0 };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const failure = modelBoundaryFailure({
        ...observed,
        call,
        classification: "request_timeout",
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      try {
        reportAttempt({
          outcome: "failed",
          diagnostic: modelBoundaryDiagnostic(failure) ?? null,
          delayMs: 0,
          stoppedReason: "The original request deadline expired.",
        });
        reject(failure);
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Model attempt observer failed."));
      }
    }, REQUEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      work({
        signal: controller.signal,
        timeRemaining: () => Math.max(0, expiresAt - Date.now()),
        reportAttempt,
        calling(next) {
          if (controller.signal.aborted)
            throw modelBoundaryFailure({
              call: next,
              classification: "request_timeout",
              timeoutMs: REQUEST_TIMEOUT_MS,
            });
          attempt += 1;
          terminalReported = false;
          call = next;
          observed = { bodyBytes: 0 };
        },
        observed(response) {
          observed = response;
        },
      }).then(
        (value) => {
          reportAttempt({
            outcome: "succeeded",
            diagnostic: null,
            delayMs: 0,
            stoppedReason: null,
          });
          return value;
        },
        (error: unknown) => {
          reportAttempt({
            outcome: "failed",
            diagnostic: modelBoundaryDiagnostic(error) ?? null,
            delayMs: 0,
            stoppedReason: "The attempt failed without further recovery.",
          });
          throw error;
        },
      ),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Build the provider call for the current config. Cheap to rebuild per attempt. */
export function makeCompleteJson(cfg: LlmConfig, mockResultPath: string): CompleteJson {
  return async (request) => {
    /* Per request, not per provider call: the shape belongs to the calling
       Module, not to this seam. */
    const schema = wireJsonSchema(request.schema);
    if (cfg.provider === "mock") return mockComplete(mockResultPath);
    return withinRequestCeiling(cfg, request.retry, async (deadline) => {
      switch (cfg.provider) {
        case "openai":
          return openaiComplete(cfg, request, schema, deadline);
        case "anthropic":
          return anthropicComplete(cfg, request, schema, deadline);
        case "openrouter":
          return openrouterComplete(cfg, request, schema, deadline);
        case "gemini":
          return geminiComplete(cfg, request, geminiWireSchema(request.schema), deadline);
        case "ollama":
          return ollamaComplete(cfg, request, schema, deadline);
        case "mock":
          return mockComplete(mockResultPath);
      }
    });
  };
}
