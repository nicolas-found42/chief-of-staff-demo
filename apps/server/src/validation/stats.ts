import {
  CAMPAIGN_SEMANTIC_CATEGORIES,
  CAMPAIGN_TERMINAL_STATUSES,
  CampaignReportSchema,
  type CampaignGoldenScore,
  type CampaignHumanJudgment,
  type CampaignManifest,
  type CampaignReport,
  type CampaignSemanticCategory,
  type CampaignSemanticCount,
  type ValidationSlotOutcome,
} from "@chief-of-staff-demo/shared";

/**
 * Campaign measurement (#363, MWR-021/022/056/057).
 *
 * Every denominator comes from the frozen plan and the recorded outcomes, so a
 * campaign cannot pass by shrinking what it counted: an unexecuted slot is a
 * recorded outcome, a zero-denominator category reports not-applicable rather
 * than perfect, and cost per success is undefined when nothing succeeded.
 */

/**
 * Nearest-rank percentile: the value at rank ceil(p * n) in ascending order.
 * The approved processing target is this rank over successful durations, not
 * an interpolated quantile.
 */
export function nearestRankPercentile(
  values: readonly number[],
  percentile: number,
): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(percentile * sorted.length)));
  return sorted[rank - 1]!;
}

type SemanticPairKey = keyof CampaignHumanJudgment["counts"];

const SEMANTIC_PAIRS: Record<CampaignSemanticCategory, [SemanticPairKey, SemanticPairKey]> = {
  "false-actions-per-produced-action": ["falseActions", "producedActions"],
  "missed-actions-per-expected-obligation": ["missedActions", "expectedObligations"],
  "wrong-responsibility-per-assertion": ["wrongResponsibility", "responsibilityAssertions"],
  "wrong-dates-per-interpreted-date": ["wrongDates", "interpretedDates"],
  "wrong-merges-per-merge-decision": ["wrongMerges", "mergeDecisions"],
  "false-decisions-per-produced-decision": ["falseDecisions", "producedDecisions"],
  "unsupported-handoff-details-per-assessed-detail": [
    "unsupportedHandoffDetails",
    "assessedDetails",
  ],
};

/**
 * The seven semantic categories, each with its own numerator and denominator.
 * Human judgments supply the counts; with none retained, every denominator is
 * zero and every category is not applicable.
 */
function semanticCounts(judgments: readonly CampaignHumanJudgment[]): CampaignSemanticCount[] {
  const totals = new Map<SemanticPairKey, number>();
  for (const judgment of judgments) {
    for (const key of Object.keys(judgment.counts) as SemanticPairKey[]) {
      totals.set(key, (totals.get(key) ?? 0) + judgment.counts[key]);
    }
  }
  return CAMPAIGN_SEMANTIC_CATEGORIES.map((category) => {
    const [numeratorKey, denominatorKey] = SEMANTIC_PAIRS[category];
    const numerator = totals.get(numeratorKey) ?? 0;
    const denominator = totals.get(denominatorKey) ?? 0;
    const applicable = denominator > 0;
    return {
      category,
      numerator,
      denominator,
      applicable,
      rate: applicable ? numerator / denominator : null,
    };
  });
}

export interface SummarizeCampaignInput {
  manifest: CampaignManifest;
  outcomes: readonly ValidationSlotOutcome[];
  goldenScores?: readonly CampaignGoldenScore[] | undefined;
  humanJudgments?: readonly CampaignHumanJudgment[] | undefined;
  generatedAt: string;
}

export function summarizeCampaign(input: SummarizeCampaignInput): CampaignReport {
  const { manifest } = input;
  const bySlotId = new Map(input.outcomes.map((outcome) => [outcome.slotId, outcome]));
  const statusCounts: Record<string, number> = {};
  for (const status of CAMPAIGN_TERMINAL_STATUSES) statusCounts[status] = 0;

  const rows = manifest.slots.map((slot, index) => {
    const outcome = bySlotId.get(slot.slotId);
    const status = outcome?.status ?? "missing";
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    return {
      index,
      slotId: slot.slotId,
      kind: slot.kind,
      model: slot.model,
      arm: slot.arm,
      repetition: slot.repetition,
      cold: slot.cold,
      status,
      reason:
        outcome?.reason ?? (outcome === undefined ? "No terminal outcome was recorded." : null),
      attempts: outcome?.attempts ?? 0,
      chargedAttempts: outcome?.chargedAttempts ?? 0,
      retries: outcome?.retries ?? 0,
      queueDelayMs: outcome?.queueDelayMs ?? 0,
      processingMs: outcome?.processingMs ?? 0,
      totalMs: outcome?.totalMs ?? 0,
      costDollars: outcome?.costDollars ?? 0,
      costEstimated: outcome?.costEstimated ?? false,
      costUnverified: outcome?.costUnverified ?? false,
    };
  });

  const successes = rows.filter((row) => row.status === "success");
  const successfulDurations = successes.map((row) => row.processingMs);
  const successfulQueueDelays = successes.map((row) => row.queueDelayMs);
  const totalDollars = rows.reduce((sum, row) => sum + row.costDollars, 0);
  const estimatedDollars = rows
    .filter((row) => row.costEstimated)
    .reduce((sum, row) => sum + row.costDollars, 0);
  const unverifiedDollars = rows
    .filter((row) => row.costUnverified)
    .reduce((sum, row) => sum + row.costDollars, 0);

  return CampaignReportSchema.parse({
    campaignId: manifest.campaignId,
    protocol: manifest.protocol,
    manifestDigest: manifest.digest,
    generatedAt: input.generatedAt,
    planned: manifest.slots.length,
    statusCounts,
    complete: rows.every((row) => row.status !== "missing") && statusCounts.interrupted === 0,
    missing: rows
      .filter((row) => row.status === "missing")
      .map((row) => ({ slotId: row.slotId, reason: row.reason ?? "" })),
    completion: {
      successes: successes.length,
      rate: rows.length === 0 ? 0 : successes.length / rows.length,
    },
    timing: {
      successfulSamples: successfulDurations.length,
      p95ProcessingMs: nearestRankPercentile(successfulDurations, 0.95),
      p95QueueDelayMs: nearestRankPercentile(successfulQueueDelays, 0.95),
    },
    cost: {
      totalDollars,
      estimatedDollars,
      unverifiedDollars,
      successfulCompletions: successes.length,
      perSuccessDollars: successes.length === 0 ? null : totalDollars / successes.length,
    },
    semantic: semanticCounts(input.humanJudgments ?? []),
    slots: rows,
    goldenScores: [...(input.goldenScores ?? [])],
    humanJudgments: [...(input.humanJudgments ?? [])],
  });
}

function renderDollars(value: number): string {
  return `$${value.toFixed(4)}`;
}

/**
 * The campaign summary as ordinary console output. It names slots by their
 * plan position and model, never by case id or produced content, so progress
 * can be watched and pasted without carrying a transcript's text.
 */
export function renderCampaignReport(report: CampaignReport): string {
  const lines: string[] = [];
  lines.push(
    `campaign ${report.campaignId} (${report.protocol}) — planned ${report.planned}, recorded ${
      report.planned - report.missing.length
    }`,
  );
  const counts = CAMPAIGN_TERMINAL_STATUSES.filter(
    (status) => (report.statusCounts[status] ?? 0) > 0,
  )
    .map((status) => `${status}=${report.statusCounts[status]}`)
    .join(" ");
  lines.push(`outcomes: ${counts || "none"}`);
  for (const row of report.slots) {
    if (row.status === "success") continue;
    lines.push(
      `  slot #${row.index} ${row.kind} ${row.model} r${row.repetition} — ${row.status}${
        row.reason === null ? "" : `: ${row.reason}`
      }`,
    );
  }
  lines.push(
    `completion: ${report.completion.successes}/${report.planned} (${(
      report.completion.rate * 100
    ).toFixed(1)}%)${report.complete ? "" : " — incomplete: missing or interrupted slots remain"}`,
  );
  lines.push(
    `processing p95: ${
      report.timing.p95ProcessingMs === null
        ? "not applicable"
        : `${report.timing.p95ProcessingMs}ms`
    } over ${report.timing.successfulSamples} successful slot(s); queue delay p95: ${
      report.timing.p95QueueDelayMs === null
        ? "not applicable"
        : `${report.timing.p95QueueDelayMs}ms`
    }`,
  );
  lines.push(
    `cost: ${renderDollars(report.cost.totalDollars)} total (${renderDollars(
      report.cost.estimatedDollars,
    )} estimated, ${renderDollars(report.cost.unverifiedDollars)} unverified); per success: ${
      report.cost.perSuccessDollars === null
        ? "undefined (no successful completion)"
        : renderDollars(report.cost.perSuccessDollars)
    }`,
  );
  for (const category of report.semantic) {
    lines.push(
      category.applicable
        ? `semantic ${category.category}: ${category.numerator}/${category.denominator} (${(
            (category.rate ?? 0) * 100
          ).toFixed(1)}%)`
        : `semantic ${category.category}: not applicable (no adjudicated denominator)`,
    );
  }
  lines.push(
    `golden scores: ${report.goldenScores.length}; blind human judgments: ${report.humanJudgments.length} (retained separately)`,
  );
  return `${lines.join("\n")}\n`;
}
