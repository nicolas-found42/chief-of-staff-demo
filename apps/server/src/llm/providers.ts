import { readFile } from "node:fs/promises";
import type { ZodType, ZodTypeDef } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { type ProviderId, DEFAULT_OLLAMA_BASE_URL } from "@chief-of-staff-demo/shared";

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

/**
 * How a model is bound to the caller's result shape. Ordered most deterministic
 * first: `response_format` has the provider constrain decoding to the JSON
 * Schema, `forced_tool_call` constrains the arguments of a call the model is
 * required to make, and `prompt_only` merely asks. One Shell seam serves every
 * Module and every provider, so the binding follows what a model declares
 * support for, never which provider happens to front it.
 */
const RESULT_SHAPE_BINDINGS = ["response_format", "forced_tool_call", "prompt_only"] as const;
type ResultShapeBinding = (typeof RESULT_SHAPE_BINDINGS)[number];

const REQUEST_TIMEOUT_MS = 120_000;

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

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; text: string }> {
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
      throw new Error(`request timed out after ${REQUEST_TIMEOUT_MS}ms`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return { status: response.status, text: await response.text() };
}

/** The upstream failure a provider body can carry alongside a 2xx status. */
function upstreamErrorMessage(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return null;
  const error = payload.error;
  if (typeof error === "string") return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    const code =
      "code" in error && (typeof error.code === "number" || typeof error.code === "string")
        ? ` (code ${String(error.code)})`
        : "";
    return `${error.message}${code}`;
  }
  return null;
}

/**
 * The provider's parsed body, or the clearest available account of why there is
 * none. Providers answer HTTP 200 and carry the failure in the body, so a status
 * check alone reports a response-shape problem for a fault they named exactly.
 */
function parseProviderPayload(label: string, response: { status: number; text: string }): unknown {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${label}: HTTP ${response.status}: ${response.text.slice(0, 300)}`);
  }
  if (response.text.trim() === "") {
    throw new Error(
      `${label}: HTTP ${response.status} with an empty body (${response.text.length} bytes)`,
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(response.text);
  } catch (cause) {
    throw new Error(
      `${label}: HTTP ${response.status} body is not JSON (${response.text.length} bytes)`,
      { cause },
    );
  }
  const upstream = upstreamErrorMessage(payload);
  if (upstream) {
    throw new Error(`${label}: HTTP ${response.status} carried an upstream error: ${upstream}`);
  }
  return payload;
}

/** Read `choices[0].message.content` from an OpenAI-shaped chat completion. */
function readChatCompletionContent(payload: unknown): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "choices" in payload &&
    isUnknownArray(payload.choices) &&
    payload.choices.length > 0
  ) {
    const first = payload.choices[0];
    if (typeof first === "object" && first !== null && "message" in first) {
      const message = first.message;
      if (
        typeof message === "object" &&
        message !== null &&
        "content" in message &&
        typeof message.content === "string"
      ) {
        return message.content;
      }
    }
  }
  throw new Error("unexpected chat-completion response shape");
}

/** Read the forced tool call's arguments from an OpenAI-shaped chat completion. */
function readToolCallArguments(payload: unknown): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "choices" in payload &&
    isUnknownArray(payload.choices) &&
    payload.choices.length > 0
  ) {
    const first = payload.choices[0];
    if (typeof first === "object" && first !== null && "message" in first) {
      const message = first.message;
      if (
        typeof message === "object" &&
        message !== null &&
        "tool_calls" in message &&
        isUnknownArray(message.tool_calls) &&
        message.tool_calls.length > 0
      ) {
        const call = message.tool_calls[0];
        if (typeof call === "object" && call !== null && "function" in call) {
          const fn = call.function;
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
    }
  }
  throw new Error("forced tool call returned no tool_calls");
}

/** Read the result shape out of whichever field the binding put it in. */
function readResultShape(binding: ResultShapeBinding, payload: unknown): unknown {
  return JSON.parse(
    binding === "forced_tool_call"
      ? readToolCallArguments(payload)
      : readChatCompletionContent(payload),
  );
}

/** Read the first `tool_use` block's input from an Anthropic messages response. */
function readToolUseInput(payload: unknown): unknown {
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
  throw new Error("no tool_use block in response");
}

/** Read `candidates[0].content.parts[0].text` from a Gemini response. */
function readGeminiText(payload: unknown): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "candidates" in payload &&
    isUnknownArray(payload.candidates) &&
    payload.candidates.length > 0
  ) {
    const first = payload.candidates[0];
    if (typeof first === "object" && first !== null && "content" in first) {
      const content = first.content;
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
          typeof part.text === "string"
        ) {
          return part.text;
        }
      }
    }
  }
  throw new Error("no text part in response");
}

async function openaiComplete(
  cfg: LlmConfig,
  request: CompletionRequest,
  schema: JsonObject,
): Promise<unknown> {
  const response = await postJson(
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
  return JSON.parse(readChatCompletionContent(parseProviderPayload("openai", response)));
}

async function anthropicComplete(
  cfg: LlmConfig,
  request: CompletionRequest,
  schema: JsonObject,
): Promise<unknown> {
  const response = await postJson(
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
  return readToolUseInput(parseProviderPayload("anthropic", response));
}

async function geminiComplete(
  cfg: LlmConfig,
  request: CompletionRequest,
  responseSchema: JsonObject,
): Promise<unknown> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  const response = await postJson(
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
  return JSON.parse(readGeminiText(parseProviderPayload("gemini", response)));
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
  label: string,
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
    const binding = RESULT_SHAPE_BINDINGS[index] ?? "prompt_only";
    const response = await postJson(
      url,
      headers,
      chatCompletionBody(binding, cfg, request, schema),
    );
    if (
      declared === null &&
      index < RESULT_SHAPE_BINDINGS.length - 1 &&
      refusesBinding(binding, response)
    ) {
      index += 1;
      continue;
    }
    return readResultShape(binding, parseProviderPayload(label, response));
  }
}

/** Whether a 4xx says the model will not honour the binding that was sent. */
function refusesBinding(
  binding: ResultShapeBinding,
  response: { status: number; text: string },
): boolean {
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
    "openrouter",
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
    "ollama",
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
