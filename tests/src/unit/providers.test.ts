import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ExtractionWireSchema,
  IDEA_STAGE_TIMEOUT_MS,
  type ModelBoundaryDiagnostic,
} from "@chief-of-staff-demo/shared";
import { makeCompleteJson, REQUEST_TIMEOUT_MS } from "../../../apps/server/src/llm/providers";
import { modelBoundaryDiagnostic } from "../../../apps/server/src/llm/failure";

interface Call {
  url: string;
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
  hang?: true;
  fail?: Error;
}

const calls: Call[] = [];
const responses: Reply[] = [];
/** Replies to the model-capability lookup, which is a different URL to a completion. */
const declarations: Reply[] = [];
const lookups: string[] = [];

it("gives the configured model latency headroom under one derived timeout contract", () => {
  expect(REQUEST_TIMEOUT_MS).toBeGreaterThan(186_000);
  expect(IDEA_STAGE_TIMEOUT_MS).toBe(REQUEST_TIMEOUT_MS + 5_000);
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
      return new Response(JSON.stringify(queued.body), {
        status: queued.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    calls.push({
      url,
      headers,
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
        string,
        unknown
      >,
    });
    const queued: Reply = responses.shift() ?? { status: 200, body: {} };
    if (queued.fail) throw queued.fail;
    if (queued.hang) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const aborted = new Error("The operation was aborted.");
          aborted.name = "AbortError";
          reject(aborted);
        });
      });
    }
    return new Response(queued.text ?? JSON.stringify(queued.body), {
      status: queued.status ?? 200,
      headers: { "content-type": "application/json" },
    });
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

describe("providers", () => {
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

  it("openrouter: happy path posts the same body shape as openai", async () => {
    responses.push({ status: 200, body: chatCompletion(JSON.stringify(RESULT)) });
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
  });

  /* An unreadable declaration is the only case that steps down, and it steps to
     the next binding in the ordering rather than to the bottom of it: a model
     that will not take a JSON Schema may still take a forced tool call. */
  it("openrouter: steps down one binding at a time when the declaration is unavailable", async () => {
    responses.push({ status: 400, body: { error: "response_format json_schema not supported" } });
    responses.push({ status: 200, body: toolCallCompletion(JSON.stringify(RESULT)) });
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
  });

  it("openrouter: reaches the prompt only after a tool call is refused too", async () => {
    responses.push({ status: 400, body: { error: "json_schema not supported" } });
    responses.push({ status: 400, body: { error: "tool_choice not supported" } });
    responses.push({ status: 200, body: chatCompletion(JSON.stringify(RESULT)) });
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
    expect(messages[0].content).toBe("S\n\nReply with raw JSON only.");
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
    responses.push({ status: 200, body: toolCallCompletion(JSON.stringify(RESULT)) });
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
    responses.push({ status: 200, body: chatCompletion(JSON.stringify(RESULT)) });
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

  /* Declaring no support is a decision, not a gap: asking is all that is left,
     and sending a binding the model has said it does not support would waste a
     call. */
  it("openrouter: asks in the prompt when the model declares neither binding", async () => {
    declarations.push(declaring("max_tokens", "temperature"));
    responses.push({ status: 200, body: chatCompletion(JSON.stringify(RESULT)) });
    const complete = makeCompleteJson(
      { provider: "openrouter", model: "some/plain-model", apiKey: "ork" },
      "/nonexistent/mock-result.json",
    );
    const parsed = await complete({ system: "S", user: "U", schema: ExtractionWireSchema });
    expect(parsed).toEqual(RESULT);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.response_format).toBeUndefined();
    expect(calls[0].body.tools).toBeUndefined();
    const messages = calls[0].body.messages as { role: string; content: string }[];
    expect(messages[0].content).toBe("S\n\nReply with raw JSON only.");
  });

  /* The Idea Engine runs 12 Stages against one model and Content Scout ranks
     then drafts, so a lookup per completion would be a lookup per Stage. What a
     model supports does not change under us mid-Run. */
  it("openrouter: looks a model's declaration up once and reuses it", async () => {
    declarations.push(declaring("tools", "tool_choice"));
    responses.push({ status: 200, body: toolCallCompletion(JSON.stringify(RESULT)) });
    responses.push({ status: 200, body: toolCallCompletion(JSON.stringify(RESULT)) });
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
      status: 200,
      body: chatCompletion(JSON.stringify({ markdown: "# Brand Profile" })),
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
    responses.push({ status: 200, body: undefined });
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
      status: 200,
      body: {
        error: {
          message: "Upstream error from Nvidia: Service temporarily overloaded",
          code: 502,
          metadata: { provider_name: "Nvidia" },
        },
      },
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
  it("classifies a reply with nothing in the binding's field, naming the field that held something", async () => {
    declarations.push(declaring("structured_outputs", "response_format"));
    responses.push({
      status: 200,
      body: {
        provider: "Nvidia",
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: null, reasoning: "thinking out loud" },
          },
        ],
      },
    });
    const failure = await failureOf(openrouter("some/reasoning-model"));
    expect(failure.classification).toBe("unusable_shape");
    expect(failure.binding).toBe("response_format");
    expect(failure.finishReason).toBe("stop");
    expect(failure.upstreamServer).toBe("Nvidia");
    expect(failure.topLevelKeys).toEqual(["provider", "choices"]);
    expect(failure.emptyFields).toContain("choices[0].message.content");
    expect(failure.populatedFields).toContain("choices[0].message.reasoning");
  });

  it("classifies a tool call that returned no tool_calls", async () => {
    declarations.push(declaring("tools", "tool_choice"));
    responses.push({
      status: 200,
      body: { choices: [{ finish_reason: "length", message: { content: "", tool_calls: [] } }] },
    });
    const failure = await failureOf(openrouter("some/truncating-model"));
    expect(failure.classification).toBe("unusable_shape");
    expect(failure.binding).toBe("forced_tool_call");
    expect(failure.finishReason).toBe("length");
    expect(failure.emptyFields).toEqual(
      expect.arrayContaining(["choices[0].message.content", "choices[0].message.tool_calls"]),
    );
  });

  it("classifies the seam's own ceiling firing as a timeout that names the model", async () => {
    vi.useFakeTimers();
    try {
      declarations.push(declaring("tools", "tool_choice"));
      responses.push({ hang: true });
      const pending = failureOf(openrouter("some/queued-model"));
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
      const failure = await pending;
      expect(failure.classification).toBe("request_timeout");
      expect(failure.timeoutMs).toBe(REQUEST_TIMEOUT_MS);
      expect(failure.model).toBe("some/queued-model");
      expect(failure.status).toBeNull();
      expect(failure.message).toContain("some/queued-model");
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

  it("classifies a 2xx body that is not JSON", async () => {
    declarations.push(declaring("tools", "tool_choice"));
    responses.push({ status: 200, text: "<html>gateway</html>" });
    const failure = await failureOf(openrouter("some/proxied-model"));
    expect(failure.classification).toBe("unparseable_body");
    expect(failure.bodyBytes).toBe(20);
    expect(failure.topLevelKeys).toEqual([]);
  });

  it("classifies an answer field that holds text which is not JSON", async () => {
    declarations.push(declaring("max_tokens"));
    responses.push({ status: 200, body: chatCompletion("Sure! Here are the tasks:") });
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
