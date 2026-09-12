import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v3";
import { ModelBudgetLedger } from "../../../apps/server/src/llm/budget.js";
import { ModelTimelineStore } from "../../../apps/server/src/llm/timeline.js";
import {
  makeCompleteJson,
  type CompletionRequest,
} from "../../../apps/server/src/llm/providers.js";
import { requestFingerprint } from "../../../apps/server/src/llm/measurement.js";

/**
 * The measurement harness at the shared model seam (issue #381, Step 0).
 *
 * A call names where it came from (`trace`), and the seam writes one durable
 * timeline entry per logical invocation carrying the purpose, the call site,
 * an opaque exact-request fingerprint, the wire attempt count and the usage
 * the provider reported — without pulling the call into the ADR-0087
 * operation budget, which is keyed by `operationId` and would refuse a model
 * it holds no price evidence for.
 */
const Shape = z.object({ answer: z.string() });

const responses: { status: number; body: unknown }[] = [];
let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "model-measurement-"));
  responses.length = 0;
  vi.stubGlobal("fetch", async () => {
    const queued = responses.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(queued.body), {
      status: queued.status,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(workspaceDir, { recursive: true, force: true });
});

function request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return { system: "S", user: "U", schema: Shape, ...overrides };
}

describe("exact-request fingerprint", () => {
  const cfg = { provider: "openai" as const, model: "gpt-test", apiKey: "secret" };

  it("is stable for an identical request and opaque about its content", () => {
    const a = requestFingerprint(cfg, request({ user: "Maya Chen designed Atlas" }));
    const b = requestFingerprint(cfg, request({ user: "Maya Chen designed Atlas" }));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain("Maya");
  });

  it("changes with every request dependency and never with the API key", () => {
    const base = requestFingerprint(cfg, request());
    expect(requestFingerprint({ ...cfg, apiKey: "other" }, request())).toBe(base);
    const variants = [
      requestFingerprint({ ...cfg, model: "gpt-other" }, request()),
      requestFingerprint({ ...cfg, provider: "openrouter" }, request()),
      requestFingerprint(cfg, request({ system: "S2" })),
      requestFingerprint(cfg, request({ user: "U2" })),
      requestFingerprint(cfg, request({ schema: z.object({ answer: z.number() }) })),
      requestFingerprint(cfg, request({ temperature: 0 })),
      requestFingerprint(cfg, request({ preferredBinding: "forced_tool_call" })),
      requestFingerprint(cfg, request({ compactWireNames: true })),
      requestFingerprint(cfg, request({ reasoningEffort: "high" })),
      requestFingerprint(cfg, request({ preferredMinThroughput: 50 })),
    ];
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });
});

describe("timeline attribution at the seam", () => {
  it("records a traced call durably by purpose and call site without a budget operation", async () => {
    const timelineStore = new ModelTimelineStore(workspaceDir);
    const budgetLedger = new ModelBudgetLedger(workspaceDir);
    const complete = makeCompleteJson(
      { provider: "mock", model: "mock", apiKey: "" },
      join(workspaceDir, "absent-mock-result.json"),
      { timelineStore, budgetLedger, purpose: "personResearch" },
    );
    await complete(
      request({ trace: { operationId: "op-research", callSite: "person-research:extraction" } }),
    );
    const [entry] = timelineStore.getOperationTimeline("op-research");
    expect(entry).toMatchObject({
      operationId: "op-research",
      stage: "person-research:extraction",
      purpose: "personResearch",
      callSite: "person-research:extraction",
      outcome: "completed",
      wireAttempts: 1,
    });
    expect(entry.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
    /* A trace is attribution, never admission: the budget ledger holds no
       operation for it, so an unpriced model is not refused dispatch. */
    expect(budgetLedger.getOperationSnapshot("op-research")).toBeNull();
  });

  it("records the wire's usage, cached input tokens and attempt count on a live call", async () => {
    const timelineStore = new ModelTimelineStore(workspaceDir);
    responses.push({
      status: 200,
      body: {
        choices: [{ message: { content: JSON.stringify({ answer: "ok" }) } }],
        usage: {
          prompt_tokens: 40,
          completion_tokens: 6,
          prompt_tokens_details: { cached_tokens: 32 },
        },
      },
    });
    const complete = makeCompleteJson(
      { provider: "openai", model: "gpt-test", apiKey: "oak" },
      "/nonexistent/mock-result.json",
      { timelineStore, purpose: "personResearch" },
    );
    await complete(
      request({ trace: { operationId: "op-live", callSite: "person-profile:claims" } }),
    );
    const [entry] = timelineStore.getOperationTimeline("op-live");
    expect(entry).toMatchObject({
      callSite: "person-profile:claims",
      outcome: "completed",
      wireAttempts: 1,
      cachedPromptTokens: 32,
      tokens: { promptTokens: 40, completionTokens: 6, estimated: false },
    });
  });

  it("records a failed invocation with its fingerprint and classification", async () => {
    const timelineStore = new ModelTimelineStore(workspaceDir);
    responses.push({ status: 500, body: { error: "upstream down" } });
    const complete = makeCompleteJson(
      { provider: "openai", model: "gpt-test", apiKey: "oak" },
      "/nonexistent/mock-result.json",
      { timelineStore, purpose: "personResearch" },
    );
    await expect(
      complete(
        request({ trace: { operationId: "op-fail", callSite: "person-research:planning" } }),
      ),
    ).rejects.toThrow();
    const [entry] = timelineStore.getOperationTimeline("op-fail");
    expect(entry).toMatchObject({
      callSite: "person-research:planning",
      outcome: "failed",
      wireAttempts: 1,
    });
    expect(entry.failureClassification).toBeTruthy();
    expect(entry.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("writes nothing to the timeline when a call carries neither an operation nor a trace", async () => {
    const timelineStore = new ModelTimelineStore(workspaceDir);
    const complete = makeCompleteJson(
      { provider: "mock", model: "mock", apiKey: "" },
      join(workspaceDir, "absent-mock-result.json"),
      { timelineStore, purpose: "personResearch" },
    );
    await complete(request());
    expect(timelineStore.getOperationTimeline("")).toEqual([]);
  });
});
