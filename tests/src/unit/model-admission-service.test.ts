import { describe, expect, it } from "vitest";
import {
  AdmissionExpiredError,
  type AdmissionLease,
  ModelAdmissionService,
  OperationCancelledError,
  ProcessingDeadlineExceededError,
} from "../../../apps/server/src/llm/admission.js";

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("ModelAdmissionService", () => {
  it("enforces maxActiveAttempts concurrency cap deterministically", async () => {
    const admission = new ModelAdmissionService({ maxActiveAttempts: 2 });
    let currentlyActive = 0;
    let maxObservedActive = 0;

    const started = Array.from({ length: 5 }, () => createDeferred<void>());
    const deferreds = Array.from({ length: 5 }, () => createDeferred<void>());

    const runTask = async (index: number) => {
      const lease = await admission.acquire();
      currentlyActive++;
      maxObservedActive = Math.max(maxObservedActive, currentlyActive);
      started[index].resolve();
      await deferreds[index].promise;
      currentlyActive--;
      lease.release();
    };

    const tasks = deferreds.map((_, i) => runTask(i));

    // Wait for the first 2 tasks to actually be admitted and start
    await Promise.all([started[0].promise, started[1].promise]);

    expect(currentlyActive).toBe(2);
    expect(maxObservedActive).toBe(2);

    // Release task 0 -> task 2 enters
    deferreds[0].resolve();
    await started[2].promise;
    expect(currentlyActive).toBe(2);

    // Release task 1 -> task 3 enters
    deferreds[1].resolve();
    await started[3].promise;
    expect(currentlyActive).toBe(2);

    // Release task 2 -> task 4 enters
    deferreds[2].resolve();
    await started[4].promise;
    expect(currentlyActive).toBe(2);

    // Release remaining tasks
    deferreds[3].resolve();
    deferreds[4].resolve();
    await Promise.all(tasks);

    expect(currentlyActive).toBe(0);
    expect(maxObservedActive).toBe(2);
    expect(admission.stats().totalAdmitted).toBe(5);
  });

  it("admits FIFO within normal queue", async () => {
    const admission = new ModelAdmissionService({ maxActiveAttempts: 1 });
    const order: string[] = [];

    const blocker = await admission.acquire();

    const p1 = admission.acquire().then((l: AdmissionLease) => {
      order.push("N1");
      l.release();
    });
    const p2 = admission.acquire().then((l: AdmissionLease) => {
      order.push("N2");
      l.release();
    });
    const p3 = admission.acquire().then((l: AdmissionLease) => {
      order.push("N3");
      l.release();
    });

    blocker.release();
    await Promise.all([p1, p2, p3]);

    expect(order).toEqual(["N1", "N2", "N3"]);
  });

  it("prioritizes time-sensitive requests over normal requests", async () => {
    const admission = new ModelAdmissionService({ maxActiveAttempts: 1 });
    const order: string[] = [];

    const blocker = await admission.acquire();

    const pNormal = admission.acquire({ priority: "normal" }).then((l: AdmissionLease) => {
      order.push("normal");
      l.release();
    });
    const pUrgent = admission.acquire({ priority: "time-sensitive" }).then((l: AdmissionLease) => {
      order.push("time-sensitive");
      l.release();
    });

    blocker.release();
    await Promise.all([pNormal, pUrgent]);

    expect(order).toEqual(["time-sensitive", "normal"]);
  });

  it("prevents starvation: admits oldest normal request after 3 consecutive time-sensitive admissions", async () => {
    const admission = new ModelAdmissionService({
      maxActiveAttempts: 1,
      starvationThresholdConsecutive: 3,
    });
    const order: string[] = [];

    const blocker = await admission.acquire();

    const pNormal = admission.acquire({ priority: "normal" }).then((l: AdmissionLease) => {
      order.push("normal-1");
      l.release();
    });

    const pT1 = admission.acquire({ priority: "time-sensitive" }).then((l: AdmissionLease) => {
      order.push("T1");
      l.release();
    });
    const pT2 = admission.acquire({ priority: "time-sensitive" }).then((l: AdmissionLease) => {
      order.push("T2");
      l.release();
    });
    const pT3 = admission.acquire({ priority: "time-sensitive" }).then((l: AdmissionLease) => {
      order.push("T3");
      l.release();
    });
    const pT4 = admission.acquire({ priority: "time-sensitive" }).then((l: AdmissionLease) => {
      order.push("T4");
      l.release();
    });

    blocker.release();
    await Promise.all([pNormal, pT1, pT2, pT3, pT4]);

    expect(order).toEqual(["T1", "T2", "T3", "normal-1", "T4"]);
  });

  it("gives immediate next slot to an aged normal request (> threshold) ahead of time-sensitive", async () => {
    let now = 1000;
    const admission = new ModelAdmissionService({
      maxActiveAttempts: 1,
      agedNormalThresholdMs: 60_000,
      now: () => now,
    });
    const order: string[] = [];

    const blocker = await admission.acquire();

    const pNormal = admission.acquire({ priority: "normal" }).then((l: AdmissionLease) => {
      order.push("normal-aged");
      l.release();
    });

    // Advance simulated clock past 60s
    now += 65_000;

    const pUrgent = admission.acquire({ priority: "time-sensitive" }).then((l: AdmissionLease) => {
      order.push("time-sensitive");
      l.release();
    });

    blocker.release();
    await Promise.all([pNormal, pUrgent]);

    expect(order).toEqual(["normal-aged", "time-sensitive"]);
  });

  it("does not preempt active calls when a high-priority request arrives", async () => {
    const admission = new ModelAdmissionService({ maxActiveAttempts: 1 });
    let normalFinished = false;
    const normalDone = createDeferred<void>();

    const lease = await admission.acquire({ priority: "normal" });

    const pUrgent = admission.acquire({ priority: "time-sensitive" }).then((l: AdmissionLease) => {
      expect(normalFinished).toBe(true);
      l.release();
    });

    await Promise.resolve();
    normalFinished = true;
    lease.release();
    normalDone.resolve();

    await pUrgent;
  });

  it("releases slot during backoff and re-acquires after delay", async () => {
    const backoffDeferred = createDeferred<void>();
    const admission = new ModelAdmissionService({
      maxActiveAttempts: 1,
      sleep: () => backoffDeferred.promise,
    });
    const order: string[] = [];

    const lease1 = await admission.acquire();
    order.push("call-1-started");

    // Call 2 is queued waiting for slot
    const p2 = admission.acquire().then(async (lease2: AdmissionLease) => {
      order.push("call-2-started");
      lease2.release();
      order.push("call-2-finished");
    });

    // Call 1 initiates backoff: this releases its slot
    const pBackoff = lease1.backoff(100).then(() => {
      order.push("call-1-resumed");
      lease1.release();
    });

    // Yield so call 2 is admitted into the slot freed by call 1
    await Promise.resolve();
    await Promise.resolve();
    await p2;

    expect(order).toEqual(["call-1-started", "call-2-started", "call-2-finished"]);

    // Now resolve backoff: call 1 re-acquires slot
    backoffDeferred.resolve();
    await pBackoff;

    expect(order).toEqual([
      "call-1-started",
      "call-2-started",
      "call-2-finished",
      "call-1-resumed",
    ]);
  });

  it("expires request when queue age limit is exceeded", async () => {
    let now = 0;
    const admission = new ModelAdmissionService({
      maxActiveAttempts: 1,
      queueAgeLimitMs: 30_000,
      now: () => now,
    });

    const blocker = await admission.acquire();

    const pWaiting = admission.acquire({ operationId: "op_1" });

    // Advance simulated clock past 30s
    now += 35_000;

    blocker.release();

    await expect(pWaiting).rejects.toThrow(AdmissionExpiredError);
    expect(admission.stats().totalExpired).toBe(1);
  });

  it("rejects request when operation processing deadline is exceeded", async () => {
    let now = 0;
    const admission = new ModelAdmissionService({
      maxActiveAttempts: 1,
      processingDeadlineMs: 15_000,
      now: () => now,
    });

    const pCall = admission.acquire({
      operationId: "op_1",
      startedAt: 0,
    });
    const lease = await pCall;
    lease.release();

    // Advance simulated clock past 15s deadline
    now = 20_000;
    await expect(
      admission.acquire({
        operationId: "op_1",
        startedAt: 0,
      }),
    ).rejects.toThrow(ProcessingDeadlineExceededError);
  });

  it("cancels queued requests and aborts active lease when operation is cancelled", async () => {
    const admission = new ModelAdmissionService({ maxActiveAttempts: 1 });

    const lease1 = await admission.acquire({ operationId: "op_target" });
    let aborted = false;
    lease1.signal.addEventListener("abort", () => {
      aborted = true;
    });

    const pQueued = admission.acquire({ operationId: "op_target" });

    // Cancel operation
    admission.cancelOperation("op_target");

    expect(aborted).toBe(true);
    await expect(pQueued).rejects.toThrow(OperationCancelledError);

    lease1.release();
    expect(admission.stats().totalCancelled).toBeGreaterThan(0);
  });
});
