import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod/v3";
import {
  makeCompleteJson,
  dossierFallbackComplete,
  type CompletionRequest,
  type ModelExecutionContext,
} from "../../../apps/server/src/llm/providers.js";
import { ModelAdmissionService } from "../../../apps/server/src/llm/admission.js";
import {
  BudgetExhaustedError,
  ModelBudgetLedger,
  ModelContextCapacityExceededError,
  StaleOperationGenerationError,
  UnknownModelPriceEvidenceError,
} from "../../../apps/server/src/llm/budget.js";
import { ModelTimelineStore } from "../../../apps/server/src/llm/timeline.js";
import { createSourceLifecycleGrant } from "../../../apps/server/src/llm/grants.js";

const SampleSchema = z.strictObject({
  result: z.string(),
});

describe("provider seam admission and budget integration", () => {
  let workspaceDir: string;
  let admission: ModelAdmissionService;
  let budgetLedger: ModelBudgetLedger;
  let timelineStore: ModelTimelineStore;
  let context: ModelExecutionContext;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "provider-admission-test-"));
    admission = new ModelAdmissionService({ maxActiveAttempts: 2 });
    budgetLedger = new ModelBudgetLedger(workspaceDir);
    timelineStore = new ModelTimelineStore(workspaceDir);
    context = { admission, budgetLedger, timelineStore };
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("enforces admission concurrency cap through makeCompleteJson", async () => {
    const complete = makeCompleteJson(
      { provider: "mock", model: "mock", apiKey: "" },
      join(workspaceDir, "mock-result.json"),
      context,
    );

    const grant = createSourceLifecycleGrant({
      sourceId: "src_1",
      purpose: "meeting-debrief",
      model: "mock",
    });

    const requests = Array.from({ length: 4 }, (_, i) => ({
      operationId: "op_concurrency",
      stage: `stage_${i}`,
      system: "system prompt",
      user: "user prompt",
      schema: SampleSchema,
      sourceGrant: grant,
    }));

    const results = await Promise.all(requests.map((req) => complete(req as CompletionRequest)));
    expect(results).toHaveLength(4);

    const timeline = timelineStore.getOperationTimeline("op_concurrency");
    expect(timeline).toHaveLength(4);
    expect(timeline.every((t) => t.outcome === "completed")).toBe(true);
  });

  it("rejects dispatch with unknown model price evidence before wire dispatch", async () => {
    const complete = makeCompleteJson(
      { provider: "openrouter", model: "nonexistent/unpriced-model-xyz", apiKey: "test" },
      join(workspaceDir, "mock-result.json"),
      context,
    );

    const grant = createSourceLifecycleGrant({
      sourceId: "src_1",
      purpose: "meeting-debrief",
      model: "nonexistent/unpriced-model-xyz",
    });

    await expect(
      complete({
        operationId: "op_unknown_price",
        system: "system",
        user: "user",
        schema: SampleSchema,
        sourceGrant: grant,
      }),
    ).rejects.toThrow(UnknownModelPriceEvidenceError);
  });

  it("rejects dispatch when request exceeds model context capacity without truncating", async () => {
    const complete = makeCompleteJson(
      { provider: "openrouter", model: "upstage/solar-pro4", apiKey: "test" },
      join(workspaceDir, "mock-result.json"),
      context,
    );

    const grant = createSourceLifecycleGrant({
      sourceId: "src_1",
      purpose: "meeting-debrief",
      model: "upstage/solar-pro4",
    });

    // Upstage solar-pro4 context is 32,768 tokens; 100k characters exceeds capacity
    const oversizedUser = "word ".repeat(25000);

    await expect(
      complete({
        operationId: "op_oversized",
        system: "system",
        user: oversizedUser,
        schema: SampleSchema,
        sourceGrant: grant,
      }),
    ).rejects.toThrow(ModelContextCapacityExceededError);
  });

  it("fences off late writes when operation is cancelled", async () => {
    const complete = makeCompleteJson(
      { provider: "mock", model: "mock", apiKey: "" },
      join(workspaceDir, "mock-result.json"),
      context,
    );

    const grant = createSourceLifecycleGrant({
      sourceId: "src_1",
      purpose: "meeting-debrief",
      model: "mock",
    });

    const op = budgetLedger.getOrCreateOperationSnapshot("op_fenced", "run_1", "debrief");
    const capturedGeneration = op.generation; // 1

    // Cancel operation -> generation becomes 2
    budgetLedger.cancelOperation("op_fenced");

    // Request with stale expectedGeneration 1 is rejected by fence before dispatching
    await expect(
      complete({
        operationId: "op_fenced",
        expectedGeneration: capturedGeneration,
        system: "system",
        user: "user",
        schema: SampleSchema,
        sourceGrant: grant,
      }),
    ).rejects.toThrow(StaleOperationGenerationError);
  });

  it("exhausts budget when cumulative spend reaches operation allowance", async () => {
    const complete = makeCompleteJson(
      { provider: "openrouter", model: "gpt-5.2", apiKey: "test" },
      join(workspaceDir, "mock-result.json"),
      context,
    );

    const grant = createSourceLifecycleGrant({
      sourceId: "src_1",
      purpose: "meeting-debrief",
      model: "gpt-5.2",
    });

    // Create an operation with very small budget
    budgetLedger.getOrCreateOperationSnapshot("op_tiny_budget", "run_1", "debrief", {
      allowedDollars: 0.0001,
    });

    await expect(
      complete({
        operationId: "op_tiny_budget",
        system: "system",
        user: "user",
        schema: SampleSchema,
        sourceGrant: grant,
      }),
    ).rejects.toThrow(BudgetExhaustedError);
  });

  /**
   * Spec #418 §5: dossier extraction's opt-in model escalation dispatches
   * through the exact same `makeCompleteJson` seam as every other call, so
   * unknown pricing, an absent source grant, budget exhaustion and a stale
   * generation prevent it before any wire dispatch — with no separate check
   * to keep in sync, and (since these all throw before dispatch) with no
   * fetch mocking required to observe it.
   */
  describe("dossier extraction model fallback preconditions (spec #418 T7)", () => {
    it("prevents dispatch on unknown fallback model pricing", async () => {
      const grant = createSourceLifecycleGrant({
        sourceId: "src_1",
        purpose: "meeting-debrief",
        model: "nonexistent/unpriced-fallback-xyz",
      });

      await expect(
        dossierFallbackComplete(
          { provider: "openrouter", model: "nonexistent/unpriced-fallback-xyz", apiKey: "test" },
          {
            operationId: "op_fallback_unpriced",
            system: "system",
            user: "user",
            schema: SampleSchema,
            sourceGrant: grant,
          },
          join(workspaceDir, "mock-result.json"),
          context,
        ),
      ).rejects.toThrow(UnknownModelPriceEvidenceError);
    });

    it("prevents dispatch with no source grant", async () => {
      await expect(
        dossierFallbackComplete(
          { provider: "openrouter", model: "gpt-5.2", apiKey: "test" },
          {
            operationId: "op_fallback_no_grant",
            system: "system",
            user: "user",
            schema: SampleSchema,
          },
          join(workspaceDir, "mock-result.json"),
          context,
        ),
      ).rejects.toThrow(/source grant/i);
    });

    it("prevents dispatch when the fallback's own operation budget is exhausted", async () => {
      const grant = createSourceLifecycleGrant({
        sourceId: "src_1",
        purpose: "meeting-debrief",
        model: "gpt-5.2",
      });
      budgetLedger.getOrCreateOperationSnapshot("op_fallback_tiny_budget", "run_1", "debrief", {
        allowedDollars: 0.0001,
      });

      await expect(
        dossierFallbackComplete(
          { provider: "openrouter", model: "gpt-5.2", apiKey: "test" },
          {
            operationId: "op_fallback_tiny_budget",
            system: "system",
            user: "user",
            schema: SampleSchema,
            sourceGrant: grant,
          },
          join(workspaceDir, "mock-result.json"),
          context,
        ),
      ).rejects.toThrow(BudgetExhaustedError);
    });

    it("prevents dispatch on a cancelled (stale-generation) operation", async () => {
      const grant = createSourceLifecycleGrant({
        sourceId: "src_1",
        purpose: "meeting-debrief",
        model: "mock",
      });
      const op = budgetLedger.getOrCreateOperationSnapshot(
        "op_fallback_fenced",
        "run_1",
        "debrief",
      );
      const capturedGeneration = op.generation;
      budgetLedger.cancelOperation("op_fallback_fenced");

      await expect(
        dossierFallbackComplete(
          { provider: "mock", model: "mock", apiKey: "" },
          {
            operationId: "op_fallback_fenced",
            expectedGeneration: capturedGeneration,
            system: "system",
            user: "user",
            schema: SampleSchema,
            sourceGrant: grant,
          },
          join(workspaceDir, "mock-result.json"),
          context,
        ),
      ).rejects.toThrow(StaleOperationGenerationError);
    });
  });
});
