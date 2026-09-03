import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Meeting, TranscriptRecord } from "@chief-of-staff-demo/shared";
import { WorkspaceMeetings } from "../../../apps/server/src/meetings/store";
import {
  MeetingJoinError,
  WorkspaceMeetingJoin,
  type MeetingJoinDeps,
} from "../../../apps/server/src/meetings/join";

/**
 * One deep module owns the Transcript ↔ Meeting join (issue #165): the
 * standing match-plus-attach pass, the idempotent single attach, and the
 * orphan merge all cross this interface, so no caller sequences Meeting file
 * reads around it.
 */
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

function harness(seed: { meetings: Meeting[]; transcripts: TranscriptRecord[] }) {
  const workspaceDir = mkdtempSync(join(tmpdir(), "cos-meeting-join-"));
  const meetings = new WorkspaceMeetings(workspaceDir);
  for (const seedMeeting of seed.meetings) {
    meetings.upsertFromCalendar({
      occurrenceKey: seedMeeting.occurrenceKey!,
      calendarEventId: seedMeeting.calendarEventId!,
      occurrenceId: seedMeeting.occurrenceId!,
      title: seedMeeting.title,
      startAt: seedMeeting.startAt,
      endAt: seedMeeting.endAt,
      participants: seedMeeting.participants,
      cancelled: seedMeeting.cancelled,
      ineligibleReason: seedMeeting.ineligibleReason,
    });
  }
  // The store owns Meeting ids; the calendar shell is found by occurrence key.
  const calendarId = meetings.findByOccurrenceKey("evt_a::2026-06-18T15:00:00Z")!.id;
  const transcripts = seed.transcripts.map((record) => ({
    ...record,
    meetingId: record.meetingId === "meeting_a" ? calendarId : record.meetingId,
  }));
  const attachMeeting = vi.fn(async (transcriptId: string, matched: { id: string }) => {
    const record = transcripts.find((candidate) => candidate.id === transcriptId);
    if (!record) throw new Error(`Unknown transcript: ${transcriptId}`);
    record.meetingId = matched.id;
    return record;
  });
  const deps: MeetingJoinDeps = {
    meetings,
    listTranscripts: () => transcripts.map((record) => ({ ...record })),
    attachMeeting,
  };
  return { join: new WorkspaceMeetingJoin(deps), meetings, calendarId, transcripts, attachMeeting };
}

describe("WorkspaceMeetingJoin.attachTranscript", () => {
  it("attaching the same Transcript twice writes once", async () => {
    const seeded = harness({ meetings: [meeting()], transcripts: [transcript()] });
    const matched = {
      id: seeded.calendarId,
      occurrenceKey: "evt_a::2026-06-18T15:00:00Z",
      calendarEventId: "evt_a",
    };
    await seeded.join.attachTranscript("t_1", matched);
    await seeded.join.attachTranscript("t_1", matched);
    expect(seeded.attachMeeting).toHaveBeenCalledTimes(1);
    expect(seeded.transcripts.find((record) => record.id === "t_1")?.meetingId).toBe(
      seeded.calendarId,
    );
  });
});

describe("WorkspaceMeetingJoin.mergeTranscriptShell", () => {
  it("a near-miss merge deletes no Meeting data", async () => {
    const seeded = harness({
      meetings: [meeting()],
      transcripts: [transcript({ id: "t_orphan" })],
    });
    // The Transcript owns its Meeting shell; the near-miss target is unknown.
    const source = seeded.meetings.createFromTranscript({
      transcriptId: "t_orphan",
      title: "Orphan sync",
      speakers: ["Owner", "Bob"],
      modifiedAt: "2026-06-19T15:00:00.000Z",
    });
    seeded.transcripts.find((record) => record.id === "t_orphan")!.meetingId = source.id;
    await expect(
      seeded.join.mergeTranscriptShell(source.id, "evt_missing::2026-06-19T15:00:00Z"),
    ).rejects.toMatchObject({ code: "target-meeting-not-found" });
    expect(seeded.meetings.get(source.id)).not.toBeNull();
    expect(seeded.meetings.get(seeded.calendarId)).not.toBeNull();
    expect(seeded.attachMeeting).not.toHaveBeenCalled();
    expect(seeded.transcripts.find((record) => record.id === "t_orphan")?.meetingId).toBe(
      source.id,
    );
  });

  it("carries the shell's Transcripts across, then forgets the shell", async () => {
    const seeded = harness({ meetings: [meeting()], transcripts: [] });
    const source = seeded.meetings.createFromTranscript({
      transcriptId: "t_orphan",
      title: "Orphan sync",
      speakers: ["Owner", "Bob"],
      modifiedAt: "2026-06-19T15:00:00.000Z",
    });
    seeded.transcripts.push(transcript({ id: "t_orphan", meetingId: source.id }));
    const merged = await seeded.join.mergeTranscriptShell(source.id, "evt_a::2026-06-18T15:00:00Z");
    expect(merged.id).toBe(seeded.calendarId);
    expect(seeded.meetings.get(source.id)).toBeNull();
    expect(seeded.meetings.get(seeded.calendarId)).not.toBeNull();
    expect(seeded.transcripts.find((record) => record.id === "t_orphan")?.meetingId).toBe(
      seeded.calendarId,
    );
  });
});

describe("WorkspaceMeetingJoin.associateTranscripts", () => {
  it("links the unmatched back-catalog and skips already-linked records", async () => {
    const seeded = harness({
      meetings: [meeting()],
      transcripts: [
        transcript({ id: "t_match" }),
        transcript({ id: "t_linked", meetingId: "meeting_a" }),
        transcript({
          id: "t_nomatch",
          source: {
            sourceSystem: "drive",
            externalFileId: "file_nomatch",
            fileName: "12345.mp3",
            sourceUrl: null,
            checksum: "sum_nomatch",
            observedRevision: 1,
            modifiedAt: null,
          },
        }),
      ],
    });
    const result = await seeded.join.associateTranscripts();
    expect(result).toEqual({ linked: 1 });
    expect(seeded.attachMeeting).toHaveBeenCalledTimes(1);
    expect(seeded.attachMeeting).toHaveBeenCalledWith(
      "t_match",
      expect.objectContaining({ id: seeded.calendarId }),
    );
  });
});

describe("MeetingJoinError", () => {
  it("carries its code", () => {
    expect(new MeetingJoinError("meeting-not-found").code).toBe("meeting-not-found");
  });
});
