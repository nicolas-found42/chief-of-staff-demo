/* oxlint-disable typescript/no-unnecessary-condition -- measurement reads persisted Run artifacts that may be legacy or partial */
import type {
  MeetingBriefDeliveryState,
  MeetingBriefErrorCount,
  MeetingBriefMeasurements,
  MeetingBriefRunResult,
  RunStatus,
} from "@chief-of-staff-demo/shared";
import { MEETING_BRIEF_MODULE_ID, RUN_STATUSES } from "@chief-of-staff-demo/shared";
import type { Runs } from "../../runs.js";

/**
 * Generation and delivery measurement (issue #362, MWR-050; ADR-0089).
 *
 * Derived on read from the Runs the Module already owns (ADR-0005): generation
 * counts and delivery counts are kept apart, and failures are counted by
 * stage and classified code. Nothing here carries evidence text, provider
 * payloads or source URLs — counts and codes only, which is what makes the
 * measurement safe to read in an ordinary log or dashboard.
 */

function zeroedStatuses(): Record<RunStatus, number> {
  return Object.fromEntries(RUN_STATUSES.map((status) => [status, 0])) as Record<RunStatus, number>;
}

function zeroedDeliveryStatuses(): Record<MeetingBriefDeliveryState["status"], number> {
  return {
    pending: 0,
    sent: 0,
    reconciled: 0,
    superseded: 0,
    skipped: 0,
    failed: 0,
  };
}

function countError(
  counts: Map<string, MeetingBriefErrorCount>,
  stage: string,
  code: string,
): void {
  const key = `${stage}:${code}`;
  const entry = counts.get(key);
  if (entry) {
    entry.count += 1;
    return;
  }
  counts.set(key, { stage, code, count: 1 });
}

/** One event detail field, read only when it is the string shape we expect. */
function stringDetail(event: { detail?: Record<string, unknown> }, key: string): string | null {
  const value = event.detail?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function buildMeetingBriefMeasurements(runs: Runs, now: Date): MeetingBriefMeasurements {
  const generation = {
    runs: 0,
    byStatus: zeroedStatuses(),
    completed: 0,
    failed: 0,
    skipped: 0,
    queued: 0,
  };
  const deliveryByStatus = zeroedDeliveryStatuses();
  const errorCounts = new Map<string, MeetingBriefErrorCount>();
  let briefs = 0;
  let attempts = 0;
  let ambiguous = 0;
  let unreadable = 0;

  for (const summary of runs.list({ module: MEETING_BRIEF_MODULE_ID }).runs) {
    generation.runs += 1;
    generation.byStatus[summary.status] += 1;
    if (summary.status === "failed") generation.failed += 1;
    if (summary.status === "skipped") generation.skipped += 1;
    const handle = runs.open(summary.id);
    const detail = runs.detail(summary.id);

    let delivery: MeetingBriefDeliveryState | null = null;
    const resultRaw = handle?.readArtifact("result.json") ?? null;
    if (resultRaw) {
      try {
        const result = JSON.parse(resultRaw) as MeetingBriefRunResult;
        if (result.meetingBrief) {
          generation.completed += 1;
          delivery = result.delivery ?? null;
        }
      } catch {
        // A corrupt result is a Run-level failure, counted by its status above.
      }
    }

    if (delivery) {
      briefs += 1;
      deliveryByStatus[delivery.status] += 1;
      attempts += typeof delivery.attempts === "number" ? delivery.attempts : 0;
    }

    // The timeline is append-only, so a delivery failure stays counted even
    // after a later retry succeeds. Only classified codes are counted.
    let classifiedDelivery = false;
    for (const event of detail?.events ?? []) {
      if (event.type === "brief_delivery_failed") {
        classifiedDelivery = true;
        const code = stringDetail(event, "errorCode") ?? "unclassified";
        countError(errorCounts, "deliver", code);
      } else if (event.type === "brief_reconciliation_refused") {
        const code = stringDetail(event, "errorCode");
        if (code === "reconciliation_ambiguous") ambiguous += 1;
        if (code === "reconciliation_unreadable") unreadable += 1;
      }
    }
    if (summary.status === "failed" && detail?.failedStage && !classifiedDelivery) {
      countError(errorCounts, detail.failedStage, "stage_failed");
    }
  }

  generation.queued = generation.byStatus.pending + generation.byStatus.running;

  return {
    generatedAt: now.toISOString(),
    generation,
    delivery: {
      briefs,
      byStatus: deliveryByStatus,
      attempts,
      reconciled: deliveryByStatus.reconciled,
      ambiguous,
      unreadable,
    },
    errors: [...errorCounts.values()].sort(
      (a, b) => a.stage.localeCompare(b.stage) || a.code.localeCompare(b.code),
    ),
  };
}
