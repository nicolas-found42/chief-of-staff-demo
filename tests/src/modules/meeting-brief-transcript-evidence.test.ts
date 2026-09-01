import { describe, expect, it } from "vitest";
import { selectTranscriptEvidence } from "../../../apps/server/src/modules/meeting-brief-generator/transcriptEvidence";

/**
 * #138's central discrimination, stated once: a confirmed link is evidence a
 * Brief may compose as fact; a similarity judgment is a suggestion until the
 * owner confirms it. #127 established that similarity is never promoted to
 * fact inside the Catalog — this is the same rule at the Brief's seam.
 */
describe("Meeting Brief transcript evidence selection (#138)", () => {
  it("admits confirmed links as evidence and holds unconfirmed similarity as suggestions", () => {
    const selection = selectTranscriptEvidence({
      links: [
        {
          transcriptId: "drive_linked_r1",
          via: "person",
          excerpt: "Alice agreed to own the migration plan.",
        },
      ],
      semantic: [
        {
          transcriptId: "drive_pending_r1",
          excerpt: "Someone mentioned a migration in another meeting.",
          score: 0.91,
          reviewState: "pending",
        },
        {
          transcriptId: "drive_confirmed_r1",
          excerpt: "We confirmed the migration date last week.",
          score: 0.62,
          reviewState: "confirmed",
        },
      ],
    });

    /* Confirmed link, and the semantic hit the owner confirmed — both are
       citable. The higher-scoring pending hit is not, and score does not buy
       its way in. */
    expect(selection.evidence.map((item) => item.transcriptId)).toEqual([
      "drive_linked_r1",
      "drive_confirmed_r1",
    ]);

    /* Still visible to the owner as something to review, carrying its
       citation — but structurally outside what composition can state. */
    expect(selection.suggestions.map((item) => item.transcriptId)).toEqual(["drive_pending_r1"]);
  });
});
