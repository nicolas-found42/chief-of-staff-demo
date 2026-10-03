import { describe, expect, it } from "vitest";
import {
  CONTENT_SCOUT_SELECTION_BUDGET,
  CONTENT_SCOUT_SELECTION_QUESTION_REVISION,
  SELECTION_THRESHOLDS,
  combineSelectionJudgments,
  type SelectionJudgment,
} from "../../../apps/server/src/modules/content-scout/selection-model.js";

function judgment(fit: number, substance: number, promotion: number): SelectionJudgment {
  return { fit, substance, promotion };
}

describe("combineSelectionJudgments", () => {
  it("selects when fit and substance pass and promotion is absent", () => {
    const outcome = combineSelectionJudgments(judgment(0.9, 0.85, 0.05), SELECTION_THRESHOLDS);
    expect(outcome).toEqual({ branch: "semantic", selected: true });
  });

  it("semantic-skips when fit is strongly negative", () => {
    const outcome = combineSelectionJudgments(judgment(0.1, 0.9, 0.05), SELECTION_THRESHOLDS);
    expect(outcome).toEqual({ branch: "semantic", selected: false });
  });

  it("semantic-skips when substance is strongly negative", () => {
    const outcome = combineSelectionJudgments(judgment(0.9, 0.2, 0.05), SELECTION_THRESHOLDS);
    expect(outcome).toEqual({ branch: "semantic", selected: false });
  });

  it("semantic-skips when promotion is strongly present (veto)", () => {
    const outcome = combineSelectionJudgments(judgment(0.9, 0.9, 0.95), SELECTION_THRESHOLDS);
    expect(outcome).toEqual({ branch: "semantic", selected: false });
  });

  it("falls back on a borderline fit judgment inside the frozen band", () => {
    const { fitPass } = SELECTION_THRESHOLDS;
    const borderline = fitPass; // exactly at the cut: inside the band, not clearly either side
    const outcome = combineSelectionJudgments(
      judgment(borderline, 0.9, 0.05),
      SELECTION_THRESHOLDS,
    );
    expect(outcome).toEqual({
      branch: "fallback",
      reason: "borderline_judgment",
    });
  });

  it("falls back when any judgment is missing or invalid", () => {
    expect(
      combineSelectionJudgments(
        { fit: Number.NaN, substance: 0.9, promotion: 0.1 },
        SELECTION_THRESHOLDS,
      ),
    ).toEqual({ branch: "fallback", reason: "invalid_judgment" });
    expect(
      combineSelectionJudgments({ fit: 0.9, substance: 1.5, promotion: 0.1 }, SELECTION_THRESHOLDS),
    ).toEqual({ branch: "fallback", reason: "invalid_judgment" });
  });

  it("treats the band symmetrically: strong-negative fit also avoids the fallback", () => {
    const { fitPass, band } = SELECTION_THRESHOLDS;
    const justBelowBand = fitPass - band / 2 - 0.01;
    expect(justBelowBand).toBeGreaterThanOrEqual(0);
    expect(
      combineSelectionJudgments(judgment(justBelowBand, 0.9, 0.05), SELECTION_THRESHOLDS),
    ).toEqual({ branch: "semantic", selected: false });
  });

  it("exposes the frozen operating constants the wire records", () => {
    expect(CONTENT_SCOUT_SELECTION_QUESTION_REVISION).toBeTypeOf("number");
    expect(CONTENT_SCOUT_SELECTION_BUDGET).toBeGreaterThan(0);
    expect(SELECTION_THRESHOLDS.fitPass).toBeGreaterThan(0);
    expect(SELECTION_THRESHOLDS.fitPass).toBeLessThan(1);
    expect(SELECTION_THRESHOLDS.band).toBeGreaterThan(0);
  });
});
