import { randomUUID } from "node:crypto";
import {
  type AdmissionOutcome,
  type ModelAdmissionConfig,
  type ModelAdmissionPriority,
  ModelAdmissionConfigSchema,
} from "@chief-of-staff-demo/shared";

export class AdmissionExpiredError extends Error {
  constructor(
    readonly queueWaitMs: number,
    readonly limitMs: number,
    message = `Admission queue wait exceeded limit: ${queueWaitMs}ms > ${limitMs}ms`,
  ) {
    super(message);
    this.name = "AdmissionExpiredError";
  }
}

export class ProcessingDeadlineExceededError extends Error {
  constructor(
    readonly elapsedMs: number,
    readonly deadlineMs: number,
    message = `Operation processing deadline exceeded: ${elapsedMs}ms > ${deadlineMs}ms`,
  ) {
    super(message);
    this.name = "ProcessingDeadlineExceededError";
  }
}

export class OperationCancelledError extends Error {
  constructor(
    readonly operationId?: string,
    message = operationId
      ? `Operation ${operationId} was cancelled`
      : "Admission request was cancelled",
  ) {
    super(message);
    this.name = "OperationCancelledError";
  }
}

export interface AdmissionLease {
  readonly leaseId: string;
  readonly operationId?: string | undefined;
  readonly enqueuedAt: number;
  readonly admittedAt: number;
  readonly queueWaitMs: number;
  readonly priority: ModelAdmissionPriority;
  readonly signal: AbortSignal;
  release: (outcome?: AdmissionOutcome) => void;
  backoff: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

export interface AdmissionRequestOptions {
  operationId?: string | undefined;
  priority?: ModelAdmissionPriority | undefined;
  signal?: AbortSignal | undefined;
  enqueuedAt?: number | undefined;
  startedAt?: number | undefined;
  queueAgeLimitMs?: number | undefined;
  processingDeadlineMs?: number | undefined;
  onWait?: ((waitInfo: { queueWaitMs: number; position: number }) => void) | undefined;
}

interface QueuedRequest {
  readonly id: string;
  readonly operationId?: string | undefined;
  readonly priority: ModelAdmissionPriority;
  readonly enqueuedAt: number;
  readonly startedAt?: number | undefined;
  readonly queueAgeLimitMs: number;
  readonly processingDeadlineMs: number;
  readonly signal?: AbortSignal | undefined;
  readonly onWait?: ((waitInfo: { queueWaitMs: number; position: number }) => void) | undefined;
  readonly resolve: (lease: AdmissionLease) => void;
  readonly reject: (error: unknown) => void;
}

export interface ModelAdmissionServiceDeps extends Partial<ModelAdmissionConfig> {
  now?: (() => number) | undefined;
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
}

/**
 * Shared, Shell-owned admission service for all model attempts (#346, MWR-023, MWR-024).
 * Enforces global concurrency, fair scheduling with time-sensitive priority,
 * starvation prevention, and queue/deadline expiry.
 */
export class ModelAdmissionService {
  private readonly config: ModelAdmissionConfig;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  private readonly timeSensitiveQueue: QueuedRequest[] = [];
  private readonly normalQueue: QueuedRequest[] = [];
  private readonly activeLeases = new Map<
    string,
    { operationId?: string | undefined; abortController: AbortController }
  >();

  private consecutiveTimeSensitive = 0;
  private totalAdmitted = 0;
  private totalExpired = 0;
  private totalCancelled = 0;

  constructor(deps: ModelAdmissionServiceDeps = {}) {
    const { now, sleep, ...configOverrides } = deps;
    this.config = ModelAdmissionConfigSchema.parse(configOverrides);
    this.now = now ?? (() => Date.now());
    this.sleep =
      sleep ??
      ((ms, signal) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, ms);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new OperationCancelledError(undefined));
            },
            { once: true },
          );
        }));
  }

  get maxActiveAttempts(): number {
    return this.config.maxActiveAttempts;
  }

  stats(): {
    activeCount: number;
    timeSensitiveQueueLength: number;
    normalQueueLength: number;
    totalAdmitted: number;
    totalExpired: number;
    totalCancelled: number;
  } {
    return {
      activeCount: this.activeLeases.size,
      timeSensitiveQueueLength: this.timeSensitiveQueue.length,
      normalQueueLength: this.normalQueue.length,
      totalAdmitted: this.totalAdmitted,
      totalExpired: this.totalExpired,
      totalCancelled: this.totalCancelled,
    };
  }

  async acquire(options: AdmissionRequestOptions = {}): Promise<AdmissionLease> {
    const now = this.now();
    const enqueuedAt = options.enqueuedAt ?? now;
    const queueAgeLimitMs = options.queueAgeLimitMs ?? this.config.queueAgeLimitMs;
    const processingDeadlineMs = options.processingDeadlineMs ?? this.config.processingDeadlineMs;

    if (options.signal?.aborted) {
      this.totalCancelled++;
      throw new OperationCancelledError(options.operationId);
    }

    if (options.startedAt !== undefined && now - options.startedAt > processingDeadlineMs) {
      this.totalExpired++;
      throw new ProcessingDeadlineExceededError(now - options.startedAt, processingDeadlineMs);
    }

    if (now - enqueuedAt > queueAgeLimitMs) {
      this.totalExpired++;
      throw new AdmissionExpiredError(now - enqueuedAt, queueAgeLimitMs);
    }

    return new Promise<AdmissionLease>((resolve, reject) => {
      const id = randomUUID();
      const request: QueuedRequest = {
        id,
        operationId: options.operationId,
        priority: options.priority ?? "normal",
        enqueuedAt,
        startedAt: options.startedAt,
        queueAgeLimitMs,
        processingDeadlineMs,
        signal: options.signal,
        onWait: options.onWait,
        resolve,
        reject,
      };

      if (options.signal) {
        options.signal.addEventListener(
          "abort",
          () => {
            this.removeQueuedRequest(id);
            this.totalCancelled++;
            reject(new OperationCancelledError(options.operationId));
          },
          { once: true },
        );
      }

      if (request.priority === "time-sensitive") {
        this.timeSensitiveQueue.push(request);
      } else {
        this.normalQueue.push(request);
      }

      this.pump();
    });
  }

  cancelOperation(operationId: string): void {
    // 1. Drain and reject queued requests for this operation
    const cancelQueue = (queue: QueuedRequest[]) => {
      for (let i = queue.length - 1; i >= 0; i--) {
        const req = queue[i]!;
        if (req.operationId === operationId) {
          queue.splice(i, 1);
          this.totalCancelled++;
          req.reject(new OperationCancelledError(operationId));
        }
      }
    };
    cancelQueue(this.timeSensitiveQueue);
    cancelQueue(this.normalQueue);

    // 2. Abort active leases for this operation
    for (const [, lease] of this.activeLeases) {
      if (lease.operationId === operationId) {
        lease.abortController.abort();
      }
    }

    this.pump();
  }

  private removeQueuedRequest(id: string): void {
    const remove = (queue: QueuedRequest[]) => {
      const index = queue.findIndex((r) => r.id === id);
      if (index !== -1) queue.splice(index, 1);
    };
    remove(this.timeSensitiveQueue);
    remove(this.normalQueue);
  }

  private pump(): void {
    while (this.activeLeases.size < this.config.maxActiveAttempts) {
      const next = this.selectNextRequest();
      if (!next) break;

      const now = this.now();
      const queueWaitMs = now - next.enqueuedAt;

      // Check expiry before granting
      if (next.signal?.aborted) {
        this.totalCancelled++;
        next.reject(new OperationCancelledError(next.operationId));
        continue;
      }

      if (queueWaitMs > next.queueAgeLimitMs) {
        this.totalExpired++;
        next.reject(new AdmissionExpiredError(queueWaitMs, next.queueAgeLimitMs));
        continue;
      }

      if (next.startedAt !== undefined && now - next.startedAt > next.processingDeadlineMs) {
        this.totalExpired++;
        next.reject(
          new ProcessingDeadlineExceededError(now - next.startedAt, next.processingDeadlineMs),
        );
        continue;
      }

      // Grant lease
      const leaseId = randomUUID();
      const abortController = new AbortController();
      if (next.signal) {
        next.signal.addEventListener("abort", () => abortController.abort(), { once: true });
      }

      this.activeLeases.set(leaseId, {
        operationId: next.operationId,
        abortController,
      });

      this.totalAdmitted++;

      let released = false;
      const lease: AdmissionLease = {
        leaseId,
        operationId: next.operationId,
        enqueuedAt: next.enqueuedAt,
        admittedAt: now,
        queueWaitMs,
        priority: next.priority,
        signal: abortController.signal,
        release: (_outcome?: AdmissionOutcome) => {
          if (released) return;
          released = true;
          this.activeLeases.delete(leaseId);
          this.pump();
        },
        backoff: async (delayMs: number, signal?: AbortSignal) => {
          if (released) return;
          // Release slot during backoff delay (#346: "backoff releases its slot")
          this.activeLeases.delete(leaseId);
          this.pump();

          try {
            const combinedSignal = signal ?? abortController.signal;
            await this.sleep(delayMs, combinedSignal);
          } finally {
            // Re-acquire slot before returning
            const freshLease = await this.acquire({
              operationId: next.operationId,
              priority: next.priority,
              signal: signal ?? abortController.signal,
              startedAt: next.startedAt,
              queueAgeLimitMs: next.queueAgeLimitMs,
              processingDeadlineMs: next.processingDeadlineMs,
            });
            // Update lease state to match fresh lease
            Object.assign(lease, {
              leaseId: freshLease.leaseId,
              admittedAt: freshLease.admittedAt,
              queueWaitMs: freshLease.queueWaitMs,
              release: freshLease.release,
              backoff: freshLease.backoff,
            });
          }
        },
      };

      next.resolve(lease);
    }
  }

  private selectNextRequest(): QueuedRequest | undefined {
    const now = this.now();

    // 1. Check for aged normal request (wait >= agedNormalThresholdMs)
    // "An aged normal request (60 seconds) takes the next available slot."
    const oldestNormal = this.normalQueue[0];
    if (oldestNormal && now - oldestNormal.enqueuedAt >= this.config.agedNormalThresholdMs) {
      this.consecutiveTimeSensitive = 0;
      return this.normalQueue.shift();
    }

    // 2. Starvation prevention: at most 3 time-sensitive admissions while normal work waits
    // before admitting oldest normal request.
    const hasNormalWaiting = this.normalQueue.length > 0;
    const hasTimeSensitiveWaiting = this.timeSensitiveQueue.length > 0;

    if (
      hasNormalWaiting &&
      hasTimeSensitiveWaiting &&
      this.consecutiveTimeSensitive >= this.config.starvationThresholdConsecutive
    ) {
      this.consecutiveTimeSensitive = 0;
      return this.normalQueue.shift();
    }

    // 3. Time-sensitive priority
    if (hasTimeSensitiveWaiting) {
      this.consecutiveTimeSensitive++;
      return this.timeSensitiveQueue.shift();
    }

    // 4. Normal FIFO
    if (hasNormalWaiting) {
      this.consecutiveTimeSensitive = 0;
      return this.normalQueue.shift();
    }

    return undefined;
  }
}
