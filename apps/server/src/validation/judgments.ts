import {
  CampaignHumanJudgmentSchema,
  type CampaignHumanJudgment,
  type CampaignSlot,
  type MeetingDebriefExtraction,
} from "@chief-of-staff-demo/shared";

/**
 * Blind human judgments, kept apart from deterministic Golden scores
 * (#363, MWR-021/022).
 *
 * The harness prepares what an adjudicator sees and validates what is
 * retained; it never invents a judgment. A packet carries the meeting's own
 * identity, the produced output and the expectations — and deliberately
 * nothing that names the model or the arm, so the person judging cannot know
 * which extractor produced what.
 */

export class JudgmentConflictError extends Error {
  constructor(readonly judgmentId: string) {
    super(`Human judgment ${judgmentId} is already retained; judgments are never rewritten.`);
    this.name = "JudgmentConflictError";
  }
}

export interface BlindJudgmentPacket {
  caseId: string;
  repetition: number;
  produced: MeetingDebriefExtraction;
  expected: unknown;
}

export function buildBlindJudgmentPacket(input: {
  slot: CampaignSlot;
  produced: MeetingDebriefExtraction;
  expected: unknown;
}): BlindJudgmentPacket {
  return {
    caseId: input.slot.caseId,
    repetition: input.slot.repetition,
    produced: input.produced,
    expected: input.expected,
  };
}

export function recordHumanJudgment(
  existing: readonly CampaignHumanJudgment[],
  judgment: CampaignHumanJudgment,
): CampaignHumanJudgment[] {
  const parsed = CampaignHumanJudgmentSchema.parse(judgment);
  if (existing.some((record) => record.judgmentId === parsed.judgmentId)) {
    throw new JudgmentConflictError(parsed.judgmentId);
  }
  return [...existing, parsed];
}
