import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CAMPAIGN_BUDGET_DOLLARS_DEFAULT,
  DEBRIEF_OPERATION_BUDGET_DOLLARS_DEFAULT,
} from "@chief-of-staff-demo/shared";
import {
  BudgetExhaustedError,
  ModelBudgetLedger,
  ModelContextCapacityExceededError,
  UnknownModelPriceEvidenceError,
} from "../../../apps/server/src/llm/budget.js";
import {
  ExpectedVersionConflictError,
  WorkspaceIntegrityError,
} from "../../../apps/server/src/engine/commit.js";
import { createSourceLifecycleGrant } from "../../../apps/server/src/llm/grants.js";

describe("ModelBudgetLedger", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "budget-test-"));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("initializes with approved default campaign and operation budgets", () => {
    const ledger = new ModelBudgetLedger(workspaceDir);
    const campaign = ledger.getCampaignSnapshot();
    expect(campaign.allowedDollars).toBe(CAMPAIGN_BUDGET_DOLLARS_DEFAULT);
    expect(campaign.remainingDollars).toBe(100.0);
    expect(campaign.spentDollars).toBe(0.0);
    expect(campaign.reservedDollars).toBe(0.0);

    const op = ledger.getOrCreateOperationSnapshot("op_1", "run_1", "debrief");
    expect(op.allowedDollars).toBe(DEBRIEF_OPERATION_BUDGET_DOLLARS_DEFAULT);
    expect(op.remainingDollars).toBe(2.0);
    expect(op.spentDollars).toBe(0.0);
    expect(op.reservedDollars).toBe(0.0);
    expect(op.allowedInputTokens).toBe(4_000_000);
    expect(op.allowedOutputTokens).toBe(500_000);
    expect(op.generation).toBe(1);
    expect(op.status).toBe("active");
  });

  it("persists campaign and operation totals across restarts", () => {
    const ledger1 = new ModelBudgetLedger(workspaceDir);
    const op1 = ledger1.getOrCreateOperationSnapshot("op_persist", "run_persist", "debrief");

    // Reserve some budget
    const grant = createSourceLifecycleGrant({
      sourceId: "src_1",
      purpose: "meeting-debrief",
      model: "deepseek/deepseek-v4.1-flash",
    });

    const reservation = ledger1.reserve({
      operationId: op1.operationId,
      model: "deepseek/deepseek-v4.1-flash",
      system: "system prompt",
      user: "user prompt",
      grant,
    });

    ledger1.settle(reservation.reservationId, {
      provider: "openrouter",
      model: "deepseek/deepseek-v4.1-flash",
      binding: "response_format",
      inputTokens: 1000,
      outputTokens: 200,
      costUsd: 0.000196,
      systemFingerprint: null,
    });

    // Reopen ledger with a fresh instance on same directory
    const ledger2 = new ModelBudgetLedger(workspaceDir);
    const campaign2 = ledger2.getCampaignSnapshot();
    expect(campaign2.spentDollars).toBe(0.000196);
    expect(campaign2.remainingDollars).toBeCloseTo(100.0 - 0.000196, 6);

    const op2 = ledger2.getOperationSnapshot("op_persist")!;
    expect(op2.spentDollars).toBe(0.000196);
    expect(op2.dispatches).toBe(1);
  });

  it("rejects unknown model price evidence unless mock or free", () => {
    const ledger = new ModelBudgetLedger(workspaceDir);
    const op = ledger.getOrCreateOperationSnapshot("op_1", "run_1", "debrief");

    const grant = createSourceLifecycleGrant({
      sourceId: "src_1",
      purpose: "meeting-debrief",
      model: "unknown-vendor/unpriced-model-xyz",
    });

    expect(() =>
      ledger.reserve({
        operationId: op.operationId,
        model: "unknown-vendor/unpriced-model-xyz",
        system: "system",
        user: "user",
        grant,
      }),
    ).toThrow(UnknownModelPriceEvidenceError);
  });

  it("rejects dispatch when request exceeds model context capacity without truncating", () => {
    const ledger = new ModelBudgetLedger(workspaceDir);
    const op = ledger.getOrCreateOperationSnapshot("op_1", "run_1", "debrief");

    const grant = createSourceLifecycleGrant({
      sourceId: "src_1",
      purpose: "meeting-debrief",
      model: "upstage/solar-pro4", // 32,768 context tokens
    });

    // Generate very large prompt exceeding 32k context tokens
    const hugeUser = "x".repeat(100_000);

    expect(() =>
      ledger.reserve({
        operationId: op.operationId,
        model: "upstage/solar-pro4",
        system: "system",
        user: hugeUser,
        grant,
      }),
    ).toThrow(ModelContextCapacityExceededError);
  });

  it("rejects dispatch when source grant is missing or revoked", () => {
    const ledger = new ModelBudgetLedger(workspaceDir);
    const op = ledger.getOrCreateOperationSnapshot("op_1", "run_1", "debrief");

    expect(() =>
      ledger.reserve({
        operationId: op.operationId,
        model: "deepseek/deepseek-v4.1-flash",
        system: "system",
        user: "user",
        grant: null,
      }),
    ).toThrow(/grant/i);

    const revokedGrant = createSourceLifecycleGrant({
      sourceId: "src_1",
      purpose: "meeting-debrief",
      model: "deepseek/deepseek-v4.1-flash",
    });
    revokedGrant.revokedAt = new Date().toISOString();

    expect(() =>
      ledger.reserve({
        operationId: op.operationId,
        model: "deepseek/deepseek-v4.1-flash",
        system: "system",
        user: "user",
        grant: revokedGrant,
      }),
    ).toThrow(/revoked/i);
  });

  it("exhausts budget when requested dispatch exceeds remaining dollars or tokens", () => {
    const ledger = new ModelBudgetLedger(workspaceDir);
    // Create an operation with a tiny $0.0001 budget
    const op = ledger.getOrCreateOperationSnapshot("op_tiny", "run_1", "debrief", {
      allowedDollars: 0.0001,
    });

    const grant = createSourceLifecycleGrant({
      sourceId: "src_1",
      purpose: "meeting-debrief",
      model: "gpt-5.2",
    });

    expect(() =>
      ledger.reserve({
        operationId: op.operationId,
        model: "gpt-5.2",
        system: "system prompt",
        user: "user prompt",
        grant,
      }),
    ).toThrow(BudgetExhaustedError);
  });

  it("retains in-flight reservation when settlement occurs without usage (no silent refund)", () => {
    const ledger = new ModelBudgetLedger(workspaceDir);
    const op = ledger.getOrCreateOperationSnapshot("op_1", "run_1", "debrief");

    const grant = createSourceLifecycleGrant({
      sourceId: "src_1",
      purpose: "meeting-debrief",
      model: "deepseek/deepseek-v4.1-flash",
    });

    const res = ledger.reserve({
      operationId: op.operationId,
      model: "deepseek/deepseek-v4.1-flash",
      system: "system",
      user: "user",
      grant,
    });

    const reservedCost = res.estimate.estimatedCostDollars;
    expect(reservedCost).toBeGreaterThan(0);

    // Settle with no usage (e.g. disconnected or aborted call)
    ledger.settle(res.reservationId, null);

    const opAfter = ledger.getOperationSnapshot("op_1")!;
    // Spent dollars reflects the unverified reservation rather than freeing it
    expect(opAfter.spentDollars).toBe(reservedCost);
    expect(opAfter.remainingDollars).toBeCloseTo(2.0 - reservedCost, 6);
  });

  it("allows explicit owner extension with expected version and rejects stale version", () => {
    const ledger = new ModelBudgetLedger(workspaceDir);
    const op = ledger.getOrCreateOperationSnapshot("op_ext", "run_ext", "debrief");

    expect(op.allowedDollars).toBe(2.0);
    const v1 = op.version;

    // Extend by $1.50
    const extended = ledger.extendOperation("op_ext", {
      addedDollars: 1.5,
      expectedVersion: v1,
      reason: "Complex multi-speaker transcript",
    });

    expect(extended.allowedDollars).toBe(3.5);
    expect(extended.remainingDollars).toBe(3.5);
    expect(extended.extensions).toHaveLength(1);
    expect(extended.extensions[0].addedDollars).toBe(1.5);
    expect(extended.version).toBe(v1 + 1);

    // Trying to extend again with stale v1 throws ExpectedVersionConflictError
    expect(() =>
      ledger.extendOperation("op_ext", {
        addedDollars: 1.0,
        expectedVersion: v1,
      }),
    ).toThrow(ExpectedVersionConflictError);
  });

  it("fails closed on corrupt ledger JSON with WorkspaceIntegrityError", () => {
    const filePath = join(workspaceDir, "model-budget-ledger.json");
    writeFileSync(filePath, "{ corrupt json ...", "utf8");

    expect(() => new ModelBudgetLedger(workspaceDir)).toThrow(WorkspaceIntegrityError);
  });
});
