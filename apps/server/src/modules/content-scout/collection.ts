import type { SourceCollectionAttemptReceipt, SourceTarget } from "@chief-of-staff-demo/shared";
import type { SourceAdapter, SourceCollectionResult } from "./ports.js";

/** Shared Daily Intake limits. Targets on one host are always serialized. */
const CONTENT_SCOUT_COLLECTION_GLOBAL_CONCURRENCY = 4;
const CONTENT_SCOUT_COLLECTION_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 500;

const RETRYABLE = new Set<SourceCollectionResult["outcome"]>([
  "rate_limit",
  "timeout",
  "internal_failure",
]);

export interface CollectedSourceTarget {
  target: SourceTarget;
  adapter: SourceAdapter;
  result: SourceCollectionResult;
  attempts: SourceCollectionAttemptReceipt[];
}

export interface CollectedSourceTargetProgress {
  targetId: string;
  result: SourceCollectionResult;
  attempts: SourceCollectionAttemptReceipt[];
}

function hostOf(target: SourceTarget): string {
  try {
    return new URL(target.url).hostname.toLowerCase();
  } catch {
    return `invalid:${target.id}`;
  }
}

function unavailableAdapter(target: SourceTarget): SourceAdapter {
  return {
    id: target.adapterId,
    state: "coming_later",
    version: "unavailable",
    supports: (candidate) => candidate.adapterId === target.adapterId,
    async collect() {
      throw new Error("Unavailable Source Adapters cannot collect.");
    },
  };
}

function failedResult(input: {
  target: SourceTarget;
  adapter: SourceAdapter;
  startedAt: string;
  finishedAt: string;
  outcome: "unsupported_capability" | "internal_failure";
  cause: string;
}): SourceCollectionResult {
  return {
    kind: "failed",
    outcome: input.outcome,
    items: [],
    checkpoint: null,
    diagnostic: {
      classification: input.outcome,
      route: input.target.url,
      status: null,
      contentType: null,
      parserStage: "adapter_boundary",
      responseHash: "",
      adapterVersion: input.adapter.version,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      retries: 0,
      affectedCapabilities: ["items"],
      causeChain: [input.cause],
    },
  };
}

async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await work(items[index]!);
    }
  });
  await Promise.all(workers);
}

export async function collectSourceTargets(input: {
  targets: SourceTarget[];
  adapters: SourceAdapter[];
  now: () => Date;
  sleep: (milliseconds: number) => Promise<void>;
  collectionStart: (target: SourceTarget, now: Date) => string;
  attemptCompleted?: (entry: CollectedSourceTarget) => void;
  previous?: CollectedSourceTargetProgress[];
  attemptOffsets?: Record<string, number>;
}): Promise<CollectedSourceTarget[]> {
  const work = input.targets.map((target, index) => ({
    target,
    adapter:
      input.adapters.find((candidate) => candidate.supports(target)) ?? unavailableAdapter(target),
    previous: input.previous?.find((entry) => entry.targetId === target.id),
    index,
  }));
  const byHost = new Map<string, typeof work>();
  for (const item of work) {
    const host = hostOf(item.target);
    const group = byHost.get(host) ?? [];
    group.push(item);
    byHost.set(host, group);
  }
  const collected: (CollectedSourceTarget & { index: number })[] = [];
  await mapLimit(
    [...byHost.values()],
    CONTENT_SCOUT_COLLECTION_GLOBAL_CONCURRENCY,
    async (group) => {
      for (const item of group) {
        const receipts: SourceCollectionAttemptReceipt[] = [...(item.previous?.attempts ?? [])];
        let result: SourceCollectionResult | null = item.previous?.result ?? null;
        if (
          result !== null &&
          (result.kind === "completed" ||
            !RETRYABLE.has(result.outcome) ||
            receipts.length >= CONTENT_SCOUT_COLLECTION_MAX_ATTEMPTS)
        ) {
          collected.push({
            target: item.target,
            adapter: item.adapter,
            result: {
              ...result,
              diagnostic: { ...result.diagnostic, retries: Math.max(0, receipts.length - 1) },
            },
            attempts: receipts,
            index: item.index,
          });
          continue;
        }
        const attemptBase = (input.attemptOffsets?.[item.target.id] ?? 0) - receipts.length;
        for (
          let cycleAttempt = receipts.length + 1;
          cycleAttempt <= CONTENT_SCOUT_COLLECTION_MAX_ATTEMPTS;
          cycleAttempt += 1
        ) {
          const attempt = attemptBase + cycleAttempt;
          const startedAt = input.now().toISOString();
          if (item.adapter.state === "coming_later") {
            result = failedResult({
              target: item.target,
              adapter: item.adapter,
              startedAt,
              finishedAt: input.now().toISOString(),
              outcome: "unsupported_capability",
              cause: "This Source Adapter has no approved collection route.",
            });
          } else {
            try {
              result = await item.adapter.collect({
                target: item.target,
                since: input.collectionStart(item.target, input.now()),
                until: input.now().toISOString(),
                checkpoint: item.target.checkpoint,
                conditional: item.target.conditional,
              });
            } catch (error) {
              result = failedResult({
                target: item.target,
                adapter: item.adapter,
                startedAt,
                finishedAt: input.now().toISOString(),
                outcome: "internal_failure",
                cause: error instanceof Error ? error.message : String(error),
              });
            }
          }
          const retry =
            result.kind === "failed" &&
            RETRYABLE.has(result.outcome) &&
            cycleAttempt < CONTENT_SCOUT_COLLECTION_MAX_ATTEMPTS;
          const backoffMs = retry
            ? Math.max(
                0,
                result.diagnostic.retryAfterMs ?? DEFAULT_BACKOFF_MS * 2 ** (cycleAttempt - 1),
              )
            : 0;
          receipts.push({
            targetId: item.target.id,
            adapterId: item.adapter.id,
            attempt,
            startedAt,
            finishedAt: input.now().toISOString(),
            outcome: result.outcome,
            checkpointBefore: item.target.checkpoint,
            checkpointAfter: result.kind === "completed" ? result.checkpoint : null,
            conditionalRequest: item.target.conditional,
            conditionalResponse: result.conditional ?? null,
            backoffMs,
          });
          input.attemptCompleted?.({
            target: item.target,
            adapter: item.adapter,
            result: {
              ...result,
              diagnostic: { ...result.diagnostic, retries: receipts.length - 1 },
            },
            attempts: [...receipts],
          });
          if (!retry) break;
          await input.sleep(backoffMs);
        }
        const final = result!;
        collected.push({
          target: item.target,
          adapter: item.adapter,
          result: {
            ...final,
            diagnostic: { ...final.diagnostic, retries: receipts.length - 1 },
          },
          attempts: receipts,
          index: item.index,
        });
      }
    },
  );
  return collected.sort((left, right) => left.index - right.index);
}
