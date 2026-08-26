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

function assertHttpOk(provider: string, status: number, text: string): void {
  if (status < 200 || status >= 300) {
    throw new Error(`${provider}: HTTP ${status}: ${text.slice(0, 300)}`);
  }
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
  const { status, text } = await postJson(
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
  assertHttpOk("openai", status, text);
  return JSON.parse(readChatCompletionContent(JSON.parse(text)));
}

async function anthropicComplete(
  cfg: LlmConfig,
  request: CompletionRequest,
  schema: JsonObject,
): Promise<unknown> {
  const { status, text } = await postJson(
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
  assertHttpOk("anthropic", status, text);
  return readToolUseInput(JSON.parse(text));
}

async function geminiComplete(
  cfg: LlmConfig,
  request: CompletionRequest,
  responseSchema: JsonObject,
): Promise<unknown> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  const { status, text } = await postJson(
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
  assertHttpOk("gemini", status, text);
  return JSON.parse(readGeminiText(JSON.parse(text)));
}

/**
 * OpenAI-shaped chat completion with a structured-output fallback, shared by
 * OpenRouter and Ollama: both front many models, and some of those models
 * reject `response_format` outright.
 */
async function openAiCompatibleComplete(
  label: string,
  url: string,
  headers: Record<string, string>,
  cfg: LlmConfig,
  request: CompletionRequest,
  schema: JsonObject,
): Promise<unknown> {
  const messages = [
    { role: "system", content: request.system },
    { role: "user", content: request.user },
  ];
  let response = await postJson(url, headers, {
    model: cfg.model,
    messages,
    response_format: {
      type: "json_schema",
      json_schema: { name: "extraction_result", strict: true, schema },
    },
  });
  const schemaRejected =
    response.status >= 400 &&
    response.status < 500 &&
    /response_format|json_schema/i.test(response.text);
  if (schemaRejected) {
    // Retry once without response_format and demand raw JSON in the prompt
    // instead.
    response = await postJson(url, headers, {
      model: cfg.model,
      messages: [
        { role: "system", content: `${request.system}\n\nReply with raw JSON only.` },
        { role: "user", content: request.user },
      ],
    });
  }
  assertHttpOk(label, response.status, response.text);
  return JSON.parse(readChatCompletionContent(JSON.parse(response.text)));
}

function openrouterComplete(
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
