import { describe, expect, it } from "vitest";
import type { Meeting, TranscriptRecord } from "@chief-of-staff-demo/shared";
import { decideAssociation } from "../../../apps/server/src/meetings/association";

/**
 * How a Transcript is placed on a Meeting (issue #356, ADR-0082). Only a
 * trusted occurrence link or a person's own confirmation places one
 * automatically; file names, titles, times and speakers are evidence offered
 * for review, and a lone weak match is a question rather than an answer.
 */
const START = "2026-06-18T15:00:00.000Z";
const NOW = "2026-06-18T18:00:00.000Z";

function meeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: "meeting_a",
    occurrenceKey: "evt_a::2026-06-18T15:00:00Z",
    calendarEventId: "evt_a",
    occurrenceId: "2026-06-18T15:00:00Z",
    title: "Internal planning",
    startAt: START,
    endAt: "2026-06-18T16:00:00.000Z",
    participants: [
      {
        email: "owner@example.com",
        displayName: "Owner",
        responseStatus: "accepted",
        organizer: true,
        self: true,
      },
    ],
    cancelled: false,
    ineligibleReason: null,
    createdAt: "2026-06-18T09:00:00.000Z",
    updatedAt: "2026-06-18T09:00:00.000Z",
    ...overrides,
  };
}

function transcript(overrides: Partial<TranscriptRecord> = {}): TranscriptRecord {
  return {
    id: "t_1",
    source: {
      sourceSystem: "drive",
      externalFileId: "file_t_1",
      fileName: "Internal planning 2026-06-18.txt",
      sourceUrl: null,
      checksum: "sum_t_1",
      observedRevision: 1,
      modifiedAt: null,
    },
    ingestedAt: "2026-06-18T17:00:00.000Z",
    extractorVersion: 1,
    normalizedText: "Nothing much was said.",
    meetingDate: "2026-06-18",
    occurrence: null,
    speakers: [],
    speakerIdentityMappings: [],
    roster: [],
    meetingId: null,
    association: null,
    ...overrides,
  };
}

describe("decideAssociation", () => {
  it("places a Transcript whose source supplied the Calendar occurrence", () => {
    const decision = decideAssociation(
      transcript({
        occurrence: { occurrenceKey: "evt_a::2026-06-18T15:00:00Z", calendarEventId: "evt_a" },
      }),
      [meeting()],
      NOW,
    );

    expect(decision.kind).toBe("attach");
    expect(decision.association.basis).toBe("trusted-occurrence");
    expect(decision.association.signals).toContain("trusted-occurrence");
  });

  it("offers a unique file-name match for review instead of placing it", () => {
    const decision = decideAssociation(transcript(), [meeting()], NOW);

    /* Uniqueness is not confidence: exactly one Meeting lines up with the
       file name and that is still only a question for the owner. */
    expect(decision.kind).toBe("review");
    expect(decision.association.basis).toBe("transcript-owned");
    expect(decision.association.candidateMeetingIds).toEqual(["meeting_a"]);
    expect(decision.association.signals).toContain("file-name-title");
  });

  it("keeps a placement a person already confirmed", () => {
    const confirmed = transcript({
      meetingId: "meeting_a",
      association: {
        basis: "owner-confirmed",
        signals: ["owner-confirmed"],
        candidateMeetingIds: [],
        recordedAt: "2026-06-18T17:30:00.000Z",
      },
    });

    const decision = decideAssociation(confirmed, [meeting()], NOW);

    expect(decision.kind).toBe("settled");
    expect(decision.association.basis).toBe("owner-confirmed");
    expect(decision.association.recordedAt).toBe("2026-06-18T17:30:00.000Z");
  });

  it("leaves a placement made before provenance was recorded visibly unknown", () => {
    const legacy = transcript({ meetingId: "meeting_a", association: null });

    const decision = decideAssociation(legacy, [meeting()], NOW);

    /* Current Calendar facts must not be read back onto it as confirmation:
       what placed it is not recorded, and saying so is the honest answer. */
    expect(decision.kind).toBe("settled");
    expect(decision.association.basis).toBe("legacy-unknown");
    expect(decision.association.signals).toEqual([]);
  });

  it("records every candidate when the signals point at more than one Meeting", () => {
    const other = meeting({
      id: "meeting_b",
      occurrenceKey: "evt_b::2026-06-18T15:30:00Z",
      calendarEventId: "evt_b",
      startAt: "2026-06-18T15:30:00.000Z",
    });

    const decision = decideAssociation(transcript(), [meeting(), other], NOW);

    expect(decision.kind).toBe("review");
    expect(decision.association.candidateMeetingIds).toEqual(["meeting_a", "meeting_b"]);
  });

  it("refuses a trusted occurrence no Meeting in the Workspace holds", () => {
    const decision = decideAssociation(
      transcript({
        occurrence: {
          occurrenceKey: "evt_missing::2026-06-18T15:00:00Z",
          calendarEventId: "evt_missing",
        },
      }),
      [meeting()],
      NOW,
    );

    expect(decision.kind).toBe("review");
    expect(decision.association.basis).toBe("transcript-owned");
  });
});
