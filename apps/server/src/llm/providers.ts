import { readFile } from "node:fs/promises";
import type { ZodType, ZodTypeDef } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  type ProviderId,
  type ResultShapeBinding,
  DEFAULT_OLLAMA_BASE_URL,
  RESULT_SHAPE_BINDINGS,
} from "@chief-of-staff-demo/shared";
import {
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
   * The result shape this one call must return. Required, and deliberately so:
   * one Shell seam serves every Module, `strict: true` means the schema sent is
   * the schema obeyed, and a default here would hand a Module another Module's
   * shape without saying so. Every caller names its own.
   */
  schema: WireSchema;
}

export type CompleteJson = (request: CompletionRequest) => Promise<unknown>;

/** The ceiling on one model call. Exported so a test can drive it deterministically. */
export const REQUEST_TIMEOUT_MS = 120_000;

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
): Promise<HttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw modelBoundaryFailure({
        call,
        classification: "request_timeout",
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
    }
    throw modelBoundaryFailure({ call, classification: "transport_failure" });
  } finally {
    clearTimeout(timer);
  }
  return { status: response.status, text: await response.text() };
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
): Promise<unknown> {
  const call = modelCall(cfg, "response_format");
  const response = await postJson(
    call,
    "https://api.openai.com/v1/chat/completions",
    { authorization: `Bearer ${cfg.apiKey}` },
    {
      model: cfg.model,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "extraction_result", strict: true, schema },
      },
    },
  );
  return readChatResultShape(modelReply(call, response));
}

async function anthropicComplete(
  cfg: LlmConfig,
  request: CompletionRequest,
  schema: JsonObject,
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
  );
  return readToolUseInput(modelReply(call, response));
}

async function geminiComplete(
  cfg: LlmConfig,
  request: CompletionRequest,
  responseSchema: JsonObject,
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
  );
  return readGeminiResultShape(modelReply(call, response));
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
          binding === "prompt_only"
            ? `${request.system}\n\nReply with raw JSON only.`
            : request.system,
      },
      { role: "user", content: request.user },
    ],
  };
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
): Promise<unknown> {
  /* A declared binding is sent and its answer taken as final. An unknown one
     starts at the most deterministic binding and gives up one step at a time,
     because a model that refuses a JSON Schema may still honour a tool call. */
  let index = declared === null ? 0 : RESULT_SHAPE_BINDINGS.indexOf(declared);
  for (;;) {
    const call = modelCall(cfg, RESULT_SHAPE_BINDINGS[index] ?? "prompt_only");
    const response = await postJson(
      call,
      url,
      headers,
      chatCompletionBody(call.binding, cfg, request, schema),
    );
    if (
      declared === null &&
      index < RESULT_SHAPE_BINDINGS.length - 1 &&
      refusesBinding(call.binding, response)
    ) {
      index += 1;
      continue;
    }
    return readChatResultShape(modelReply(call, response));
  }
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
function openrouterDeclaredParameters(cfg: LlmConfig): Promise<Set<string> | null> {
  const cached = openrouterDeclarations.get(cfg.model);
  if (cached) return cached;
  const pending = fetchDeclaredParameters(cfg);
  openrouterDeclarations.set(cfg.model, pending);
  return pending;
}

async function fetchDeclaredParameters(cfg: LlmConfig): Promise<Set<string> | null> {
  try {
    const response = await fetch(`https://openrouter.ai/api/v1/models/${cfg.model}/endpoints`, {
      headers: { authorization: `Bearer ${cfg.apiKey}` },
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
 * The most deterministic Result Shape Binding a model declares support for, or
 * `null` when there is no declaration to read — which is not the same as
 * declaring no support, and is the only case allowed to step down.
 */
function declaredBinding(declared: Set<string> | null): ResultShapeBinding | null {
  if (!declared) return null;
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
): Promise<unknown> {
  return openAiCompatibleComplete(
    "https://openrouter.ai/api/v1/chat/completions",
    { authorization: `Bearer ${cfg.apiKey}` },
    cfg,
    request,
    schema,
    declaredBinding(await openrouterDeclaredParameters(cfg)),
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
): Promise<unknown> {
  const base = (cfg.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, "");
  return openAiCompatibleComplete(
    `${base}/v1/chat/completions`,
    cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
    cfg,
    request,
    schema,
    null,
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

/** Build the provider call for the current config. Cheap to rebuild per attempt. */
export function makeCompleteJson(cfg: LlmConfig, mockResultPath: string): CompleteJson {
  return async (request) => {
    /* Per request, not per provider call: the shape belongs to the calling
       Module, not to this seam. */
    const schema = wireJsonSchema(request.schema);
    switch (cfg.provider) {
      case "openai":
        return openaiComplete(cfg, request, schema);
      case "anthropic":
        return anthropicComplete(cfg, request, schema);
      case "openrouter":
        return openrouterComplete(cfg, request, schema);
      case "gemini":
        return geminiComplete(cfg, request, geminiWireSchema(request.schema));
      case "ollama":
        return ollamaComplete(cfg, request, schema);
      case "mock":
        return mockComplete(mockResultPath);
    }
  };
}
