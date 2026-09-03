import { describe, expect, it } from "vitest";
import type { Meeting, TranscriptRecord } from "@chief-of-staff-demo/shared";
import {
  MEETING_MATCH_TOLERANCE_MS,
  findMatchingMeeting,
} from "../../../apps/server/src/meetings/matching";
/**
 * A Transcript finds its Meeting by file-name evidence plus corroboration
 * (issue #153): a bare title never links, an empty name never matches, and
 * ambiguity resolves to no match rather than a winner.
 */

describe("MEETING_MATCH_TOLERANCE_MS", () => {
  it("pins the stated one-day corroboration window", () => {
    expect(MEETING_MATCH_TOLERANCE_MS).toBe(24 * 60 * 60 * 1000);
  });
});
const START = "2026-06-18T15:00:00.000Z";

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
      {
        email: "bob@internal.example.com",
        displayName: "Bob",
        responseStatus: "accepted",
        organizer: false,
        self: false,
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
    ...overrides,
  };
}

describe("findMatchingMeeting", () => {
  it("matches on filename timestamp plus title", () => {
    const found = findMatchingMeeting(transcript(), [meeting()]);
    expect(found?.id).toBe("meeting_a");
  });

  it("never links on a title alone without corroboration", () => {
    const lone = transcript({
      source: {
        sourceSystem: "drive",
        externalFileId: "file_lone",
        fileName: "Internal planning notes.txt",
        sourceUrl: null,
        checksum: "sum_lone",
        observedRevision: 1,
        modifiedAt: null,
      },
      speakers: [],
    });
    expect(findMatchingMeeting(lone, [meeting()])).toBeNull();
  });

  it("links a title-only name with a speaker on the roster", () => {
    const withSpeaker = transcript({
      source: {
        sourceSystem: "drive",
        externalFileId: "file_spk",
        fileName: "Internal planning notes.txt",
        sourceUrl: null,
        checksum: "sum_spk",
        observedRevision: 1,
        modifiedAt: null,
      },
      speakers: ["bob"],
    });
    expect(findMatchingMeeting(withSpeaker, [meeting()])?.id).toBe("meeting_a");
  });

  it("links a title-only name with a modification time inside tolerance", () => {
    const withMtime = transcript({
      source: {
        sourceSystem: "drive",
        externalFileId: "file_mtime",
        fileName: "Internal planning notes.txt",
        sourceUrl: null,
        checksum: "sum_mtime",
        observedRevision: 1,
        modifiedAt: "2026-06-18T20:00:00.000Z",
      },
      speakers: [],
    });
    expect(findMatchingMeeting(withMtime, [meeting()])?.id).toBe("meeting_a");
  });

  it("never matches a name carrying neither title nor timestamp", () => {
    const empty = transcript({
      source: {
        sourceSystem: "drive",
        externalFileId: "file_empty",
        fileName: "12345.mp3",
        sourceUrl: null,
        checksum: "sum_empty",
        observedRevision: 1,
        modifiedAt: "2026-06-18T15:30:00.000Z",
      },
      speakers: ["Bob"],
    });
    expect(findMatchingMeeting(empty, [meeting()])).toBeNull();
  });

  it("returns no match when the timestamp sits outside tolerance", () => {
    const far = transcript({
      source: {
        sourceSystem: "drive",
        externalFileId: "file_far",
        fileName: "Internal planning 2026-06-10.txt",
        sourceUrl: null,
        checksum: "sum_far",
        observedRevision: 1,
        modifiedAt: null,
      },
      speakers: ["Bob"],
    });
    expect(findMatchingMeeting(far, [meeting()])).toBeNull();
  });

  it("returns no match when two meetings qualify rather than picking a winner", () => {
    const rivals = [
      meeting({ id: "meeting_a" }),
      meeting({
        id: "meeting_b",
        occurrenceKey: "evt_b::2026-06-18T15:00:00Z",
        calendarEventId: "evt_b",
      }),
    ];
    expect(findMatchingMeeting(transcript(), rivals)).toBeNull();
  });
});

/* The standing pass lives behind the Meeting join (issue #165); its behavior
   is covered through WorkspaceMeetingJoin in meeting-join.test.ts. */
