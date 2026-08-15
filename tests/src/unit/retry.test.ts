import { describe, expect, it } from "vitest";
import { classifyHttpFailure } from "@chief-of-staff/agents";

describe("OpenRouter retry classification", () => {
  it("retries transient HTTP statuses", () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      const error = classifyHttpFailure(status, "generic failure", "m");
      expect(error.code).toBe("OPENROUTER_RATE_LIMIT");
      expect(error.retryable).toBe(true);
    }
  });

  it("retries provider-overloaded errors without a status", () => {
    const error = classifyHttpFailure(0, "the provider is overloaded, try again", "m");
    expect(error.code).toBe("OPENROUTER_RATE_LIMIT");
    expect(error.retryable).toBe(true);
  });

  it("does not retry authentication failures", () => {
    const error = classifyHttpFailure(401, "unauthorized", "m");
    expect(error.code).toBe("OPENROUTER_AUTH");
    expect(error.retryable).toBe(false);
  });

  it("does not retry invalid API keys", () => {
    const error = classifyHttpFailure(200, "invalid api key supplied", "m");
    expect(error.code).toBe("OPENROUTER_AUTH");
    expect(error.retryable).toBe(false);
  });

  it("does not retry credit failures", () => {
    const error = classifyHttpFailure(402, "insufficient credits", "m");
    expect(error.code).toBe("OPENROUTER_AUTH");
    expect(error.retryable).toBe(false);
  });

  it("does not retry model-not-found", () => {
    const error = classifyHttpFailure(404, "model not found", "m");
    expect(error.code).toBe("OPENROUTER_MODEL_UNAVAILABLE");
    expect(error.retryable).toBe(false);
  });

  it("does not retry invalid requests or schemas", () => {
    const request = classifyHttpFailure(400, "bad request", "m");
    expect(request.code).toBe("INVALID_STRUCTURED_OUTPUT");
    expect(request.retryable).toBe(false);
    const schema = classifyHttpFailure(422, "invalid schema", "m");
    expect(schema.code).toBe("INVALID_STRUCTURED_OUTPUT");
    expect(schema.retryable).toBe(false);
  });

  it("excludes the API key from error messages", () => {
    const error = classifyHttpFailure(401, "unauthorized", "m");
    expect(error.message).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(error.message).toContain("OPENROUTER_API_KEY");
  });
});
