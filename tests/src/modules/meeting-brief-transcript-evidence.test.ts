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
          relevance: 0.4,
          meetingDate: "2026-02-01",
        },
      ],
      semantic: [
        {
          transcriptId: "drive_pending_r1",
          excerpt: "Someone mentioned a migration in another meeting.",
          score: 0.91,
          meetingDate: "2026-02-10",
          reviewState: "pending",
        },
        {
          transcriptId: "drive_confirmed_r1",
          excerpt: "We confirmed the migration date last week.",
          score: 0.62,
          meetingDate: "2026-02-05",
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

/**
 * AC 3: retrieval ranks relationship strength, meeting relevance and recency,
 * and passes a *bounded* cited excerpt set into composition. The order is
 * lexicographic over those three keys in that priority, so a strong
 * relationship outranks a strong similarity score rather than competing with
 * it on one blended number.
 */
describe("Meeting Brief transcript evidence ranking (#138)", () => {
  it("ranks relationship strength over relevance over recency and bounds the set", () => {
    const selection = selectTranscriptEvidence(
      {
        links: [
          {
            transcriptId: "series_older",
            via: "meeting-series",
            excerpt: "Standing agenda from the previous series meeting.",
            relevance: 0.9,
            meetingDate: "2026-01-05",
          },
          {
            transcriptId: "person_weak",
            via: "person",
            excerpt: "Alice mentioned the timeline in passing.",
            relevance: 0.1,
            meetingDate: "2026-01-02",
          },
          {
            transcriptId: "org_recent",
            via: "organization",
            excerpt: "Acme confirmed the contract terms.",
            relevance: 0.5,
            meetingDate: "2026-02-20",
          },
          {
            transcriptId: "person_recent",
            via: "person",
            excerpt: "Alice owns the migration plan.",
            relevance: 0.1,
            meetingDate: "2026-03-01",
          },
        ],
        semantic: [
          {
            transcriptId: "semantic_confirmed",
            excerpt: "A confirmed similarity hit with a very high score.",
            score: 0.99,
            meetingDate: "2026-04-01",
            reviewState: "confirmed",
          },
        ],
      },
      { limit: 3 },
    );

    /* person(2) before organization(1) before meeting-series(0), and a
       confirmed similarity hit ranks below every confirmed link however high
       it scored. Within `person`, equal relevance breaks to the more recent
       meeting. The bound then cuts the tail — meeting-series and the
       semantic hit fall out, and neither can be cited. */
    expect(selection.evidence.map((item) => item.transcriptId)).toEqual([
      "person_recent",
      "person_weak",
      "org_recent",
    ]);
  });
});
