import { describe, expect, it } from "vitest";
import {
  SELECTION_THRESHOLDS,
  combineSelectionJudgments,
  type SelectionJudgment,
  type SelectionThresholds,
} from "../../../apps/server/src/modules/content-scout/selection-model.js";

/* The promotion gate lives in scripts/content-scout-selection-eval.mts; this
   spec pins the decision rule that gate and Run both share, so the recorded
   corpus metrics and the shipped behavior cannot drift apart silently. */

function judgments(
  entries: Record<string, [number, number, number]>,
): Record<string, SelectionJudgment> {
  return Object.fromEntries(
    Object.entries(entries).map(([id, [fit, substance, promotion]]) => [
      id,
      { fit, substance, promotion },
    ]),
  );
}

describe("the frozen decision rule the #503 gate records against", () => {
  it("keeps borderline inside the band symmetric around each cut", () => {
    const thresholds: SelectionThresholds = { ...SELECTION_THRESHOLDS };
    const half = thresholds.band / 2;
    /* Just inside the band on the positive side: fallback, not select. */
    expect(
      combineSelectionJudgments(
        { fit: thresholds.fitPass + half - 0.01, substance: 0.95, promotion: 0.05 },
        thresholds,
      ),
    ).toEqual({ branch: "fallback", reason: "borderline_judgment" });
    /* Just outside on the positive side: select. */
    expect(
      combineSelectionJudgments(
        { fit: thresholds.fitPass + half, substance: 0.95, promotion: 0.05 },
        thresholds,
      ),
    ).toEqual({ branch: "semantic", selected: true });
    /* Just outside on the negative side: semantic skip. */
    expect(
      combineSelectionJudgments(
        { fit: thresholds.fitPass - half, substance: 0.95, promotion: 0.05 },
        thresholds,
      ),
    ).toEqual({ branch: "semantic", selected: false });
  });

  it("demotes an otherwise-selected item when any judgment is borderline", () => {
    const thresholds = SELECTION_THRESHOLDS;
    const recorded = judgments({
      "sel-pass": [0.95, 0.95, 0.05],
      "sel-borderline-promo": [0.95, 0.95, thresholds.promoPass],
    });
    expect(combineSelectionJudgments(recorded["sel-pass"], thresholds)).toEqual({
      branch: "semantic",
      selected: true,
    });
    expect(combineSelectionJudgments(recorded["sel-borderline-promo"], thresholds)).toEqual({
      branch: "fallback",
      reason: "borderline_judgment",
    });
  });

  it("never selects through a promotion veto even with perfect fit and substance", () => {
    expect(
      combineSelectionJudgments(
        { fit: 1, substance: 1, promotion: SELECTION_THRESHOLDS.promoPass + 0.1 },
        SELECTION_THRESHOLDS,
      ),
    ).toEqual({ branch: "semantic", selected: false });
  });
});
