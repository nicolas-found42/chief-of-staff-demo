import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ModelBudgetLedger,
  StaleOperationGenerationError,
} from "../../../apps/server/src/llm/budget.js";
import { ModelAdmissionService } from "../../../apps/server/src/llm/admission.js";

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("cancellation generation fencing and settle-before-retry", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "fence-test-"));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("increments generation on cancellation and rejects late writes", () => {
    const ledger = new ModelBudgetLedger(workspaceDir);
    const op = ledger.getOrCreateOperationSnapshot("op_fence_1", "run_1", "debrief");
    expect(op.generation).toBe(1);

    // Caller captures generation 1 before network work
    const capturedGeneration = op.generation;
    expect(() => ledger.assertGeneration("op_fence_1", capturedGeneration)).not.toThrow();

    // Cancel operation -> bumps generation to 2
    ledger.cancelOperation("op_fence_1");
    const opAfter = ledger.getOperationSnapshot("op_fence_1")!;
    expect(opAfter.generation).toBe(2);
    expect(opAfter.status).toBe("cancelled");

    // Late write callback arrives with capturedGeneration = 1
    expect(() => ledger.assertGeneration("op_fence_1", capturedGeneration)).toThrow(
      StaleOperationGenerationError,
    );
  });

  it("settles active in-flight calls before retry is permitted", async () => {
    const admission = new ModelAdmissionService({ maxActiveAttempts: 2 });
    const ledger = new ModelBudgetLedger(workspaceDir);
    const op = ledger.getOrCreateOperationSnapshot("op_settle_1", "run_1", "debrief");

    const inFlightDeferred = createDeferred<void>();
    let inFlightSettled = false;

    // Simulate an in-flight network attempt
    const lease = await admission.acquire({ operationId: op.operationId });
    const attemptPromise = (async () => {
      try {
        await inFlightDeferred.promise;
      } finally {
        inFlightSettled = true;
        lease.release();
      }
    })();

    ledger.trackActiveAttempt(op.operationId, attemptPromise);
    expect(ledger.hasActiveAttempts(op.operationId)).toBe(true);

    // Request settle before retry
    const settlePromise = ledger.settleActiveAttempts(op.operationId);

    // Yield: settlePromise must still be pending because inFlightDeferred is unresolved
    await Promise.resolve();
    expect(inFlightSettled).toBe(false);

    // Resolve in-flight attempt
    inFlightDeferred.resolve();
    await settlePromise;

    expect(inFlightSettled).toBe(true);
    expect(ledger.hasActiveAttempts(op.operationId)).toBe(false);
  });
});
