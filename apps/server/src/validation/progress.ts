/**
 * Content-free progress lines for the eval and campaign CLIs (#363).
 *
 * Whatever a run produced — summary text, action titles, owners, dates — never
 * reaches ordinary output. A line reports the shape of an answer (counts and
 * character length) and where the run is, so a log can be watched and pasted
 * without carrying a meeting's text.
 */

export interface ExtractionShapeCounts {
  summaryChars: number;
  decisions: number;
  actionItems: number;
  openQuestions: number;
  suggestedRecipients: number;
}

export function extractionShapeCounts(extraction: {
  summary: string;
  decisions: readonly unknown[];
  actionItems: readonly unknown[];
  openQuestions: readonly unknown[];
  suggestedRecipients: readonly unknown[];
}): ExtractionShapeCounts {
  return {
    summaryChars: extraction.summary.length,
    decisions: extraction.decisions.length,
    actionItems: extraction.actionItems.length,
    openQuestions: extraction.openQuestions.length,
    suggestedRecipients: extraction.suggestedRecipients.length,
  };
}

export function renderExtractionSummary(
  tag: string,
  ms: number,
  counts: ExtractionShapeCounts,
): string {
  return `${tag} OK ${ms}ms summary=${counts.summaryChars}ch decisions=${counts.decisions} actions=${counts.actionItems} questions=${counts.openQuestions} recipients=${counts.suggestedRecipients}`;
}

export interface SlotProgressInput {
  index: number;
  total: number;
  kind: string;
  model: string;
  arm: string;
  repetition: number;
  status: string;
  chargedAttempts: number;
  processingMs: number;
  costDollars: number;
}

/** One slot's line: position, model and outcome shape — never its case id. */
export function renderSlotProgress(input: SlotProgressInput): string {
  return `[${input.index + 1}/${input.total}] ${input.kind} ${input.model} ${input.arm} r${input.repetition} — ${input.status} attempts=${input.chargedAttempts} ${input.processingMs}ms $${input.costDollars.toFixed(4)}`;
}
