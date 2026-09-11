import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerApi } from "../../../apps/server/src/api/router.js";
import { openRuns, type Runs } from "../../../apps/server/src/runs.js";
import { ConfigStore } from "../../../apps/server/src/config.js";
import { ModelAdmissionService } from "../../../apps/server/src/llm/admission.js";
import { ModelBudgetLedger } from "../../../apps/server/src/llm/budget.js";
import { ModelTimelineStore } from "../../../apps/server/src/llm/timeline.js";
import type { OperationBudgetSnapshot } from "@chief-of-staff-demo/shared";

describe("model admission, budget, and cancellation API routes", () => {
  let app: FastifyInstance;
  let workspaceDir: string;
  let runs: Runs;
  let configStore: ConfigStore;
  let admission: ModelAdmissionService;
  let budgetLedger: ModelBudgetLedger;
  let timelineStore: ModelTimelineStore;

  beforeEach(async () => {
    workspaceDir = mkdtempSync(join(tmpdir(), "api-budget-test-"));
    runs = openRuns(workspaceDir);
    configStore = new ConfigStore(workspaceDir);
    admission = new ModelAdmissionService({ maxActiveAttempts: 2 });
    budgetLedger = new ModelBudgetLedger(workspaceDir);
    timelineStore = new ModelTimelineStore(workspaceDir);

    app = fastify();
    await registerApi(app, {
      runs,
      port: 4999,
      configStore,
      modules: [],
      people: {} as never,
      meetings: {} as never,
      meetingJoin: {} as never,
      peopleResolver: {} as never,
      onboarding: {} as never,
      contentProjects: {} as never,
      tasks: {} as never,
      actionItems: {} as never,
      taskLinking: {} as never,
      asanaLinking: {} as never,
      google: {
        state: () => ({ state: "unconfigured" }),
        invalidate: () => {},
        disconnect: () => {},
        verifySetup: async () => ({ state: "unconfigured" }),
        authUrl: () => ({ ok: false, state: "unconfigured" }),
        pickerToken: async () => ({ ok: false, state: "unconfigured" }),
        completeSignIn: async () => {},
      } as never,
      mockProviderAvailable: true,
      onConfigChanged: () => {},
      admission,
      budgetLedger,
      timelineStore,
    });
  });

  afterEach(async () => {
    await app.close();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("returns operation budget via GET /api/operations/:id/budget", async () => {
    const op = budgetLedger.getOrCreateOperationSnapshot("op_test_1", "run_1", "debrief");

    const res = await app.inject({
      method: "GET",
      url: `/api/operations/${encodeURIComponent(op.operationId)}/budget`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { budget: OperationBudgetSnapshot };
    expect(body.budget.operationId).toBe("op_test_1");
    expect(body.budget.allowedDollars).toBe(2.0);
    expect(body.budget.remainingDollars).toBe(2.0);
  });

  it("returns 404 for unknown operation budget", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/operations/unknown_op/budget",
    });

    expect(res.statusCode).toBe(404);
  });

  it("extends budget via POST /api/operations/:id/extend and rejects stale expectedVersion with 409", async () => {
    const op = budgetLedger.getOrCreateOperationSnapshot("op_extend_test", "run_2", "debrief");
    const v1 = op.version;

    // Successful extension
    const resSuccess = await app.inject({
      method: "POST",
      url: `/api/operations/${encodeURIComponent(op.operationId)}/extend`,
      payload: {
        addedDollars: 1.5,
        expectedVersion: v1,
        reason: "Owner requested deeper extraction analysis",
      },
    });

    expect(resSuccess.statusCode).toBe(200);
    const successBody = JSON.parse(resSuccess.body) as {
      ok: boolean;
      budget: OperationBudgetSnapshot;
    };
    expect(successBody.ok).toBe(true);
    expect(successBody.budget.allowedDollars).toBe(3.5);
    expect(successBody.budget.version).toBe(v1 + 1);

    // Stale version extension fails with 409 Conflict
    const resConflict = await app.inject({
      method: "POST",
      url: `/api/operations/${encodeURIComponent(op.operationId)}/extend`,
      payload: {
        addedDollars: 1.0,
        expectedVersion: v1, // Stale!
      },
    });

    expect(resConflict.statusCode).toBe(409);
  });

  it("cancels operation via POST /api/operations/:id/cancel", async () => {
    const op = budgetLedger.getOrCreateOperationSnapshot("op_cancel_test", "run_3", "debrief");
    expect(op.generation).toBe(1);

    const res = await app.inject({
      method: "POST",
      url: `/api/operations/${encodeURIComponent(op.operationId)}/cancel`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; cancelled: boolean };
    expect(body.ok).toBe(true);
    expect(body.cancelled).toBe(true);

    const opAfter = budgetLedger.getOperationSnapshot("op_cancel_test")!;
    expect(opAfter.status).toBe("cancelled");
    expect(opAfter.generation).toBe(2);
  });

  it("returns operation timeline entries via GET /api/operations/:id/timeline", async () => {
    timelineStore.record({
      attemptId: "att_1",
      operationId: "op_timeline_test",
      runId: "run_4",
      stage: "discovery",
      enqueuedAt: new Date().toISOString(),
      admittedAt: new Date().toISOString(),
      settledAt: new Date().toISOString(),
      queueWaitMs: 30,
      durationMs: 1200,
      provider: "mock",
      model: "mock",
      binding: "response_format",
      priority: "normal",
      outcome: "completed",
      tokens: { promptTokens: 500, completionTokens: 100, totalTokens: 600, estimated: false },
      cost: { dollars: 0, estimated: false, unverified: false },
      failureClassification: null,
      validationOutcome: "valid",
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/operations/op_timeline_test/timeline",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { timeline: unknown[] };
    expect(body.timeline).toHaveLength(1);
  });

  it("returns corpus load report via GET /api/telemetry/corpus-load-report", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/telemetry/corpus-load-report",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { report: { transcriptTokenDistribution: unknown } };
    expect(body.report).toBeDefined();
    expect(body.report.transcriptTokenDistribution).toBeDefined();
  });
});
