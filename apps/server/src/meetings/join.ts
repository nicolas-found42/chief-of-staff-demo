import type { Meeting, TranscriptRecord } from "@chief-of-staff-demo/shared";
import { meetingFileNameMeta } from "../text/meetingFileName.js";
import { findMatchingMeeting, findNearMatches, type MatchedMeeting } from "./matching.js";
import type { WorkspaceMeetings } from "./store.js";

/**
 * The Workspace Meeting join (issue #165, ADR-0050).
 *
 * One deep module owning match-plus-attach-plus-merge behind a single
 * interface. Callers never sequence Meeting file reads around it: every
 * method re-reads the Meetings and the Transcripts it needs, so the standing
 * pass, the single attach, and the orphan merge cannot go stale on each
 * other. The pure scorers stay in matching.ts as the internal seam; the
 * Catalog remains the sole write path for the Transcript side, reached
 * through the injected attach.
 *
 * The Meeting holds occurrence facts, participants, and person-supplied
 * state only, never Run state.
 */
export type MeetingJoinErrorCode =
  | "meeting-not-found"
  | "merge-source-has-occurrence"
  | "target-occurrence-key-required"
  | "target-meeting-not-found"
  | "unknown-transcript";

export class MeetingJoinError extends Error {
  readonly code: MeetingJoinErrorCode;

  constructor(code: MeetingJoinErrorCode) {
    super(code);
    this.name = "MeetingJoinError";
    this.code = code;
  }
}

export interface MeetingJoinDeps {
  meetings: WorkspaceMeetings;
  listTranscripts: () => TranscriptRecord[];
  attachMeeting: (transcriptId: string, matched: MatchedMeeting) => Promise<unknown>;
  log?: (message: string) => void;
}

export class WorkspaceMeetingJoin {
  constructor(private readonly deps: MeetingJoinDeps) {}

  /**
   * The standing pass joining the Transcript Catalog to the Workspace's
   * Meetings. It places every catalogued Transcript, not only newly ingested
   * ones; a Transcript that already carries its Meeting is never re-matched.
   * A Transcript nothing matches owns its Meeting instead, keyed on the
   * Transcript id so a re-run returns the same record.
   */
  async associateTranscripts(): Promise<{ linked: number }> {
    let linked = 0;
    const meetings = [...this.deps.meetings.list()];
    for (const transcript of this.deps.listTranscripts()) {
      if (transcript.meetingId) continue;
      const meeting = findMatchingMeeting(transcript, meetings);
      if (meeting !== null) {
        await this.attachRecord(transcript, meeting);
        linked += 1;
        this.deps.log?.(`transcript ${transcript.id} matched Meeting ${meeting.id}`);
        continue;
      }
      const meta = meetingFileNameMeta(transcript.source.fileName);
      if (meta.title === null && meta.timestamp === null) continue;
      const created = this.deps.meetings.createFromTranscript({
        transcriptId: transcript.id,
        title: meta.title ?? transcript.source.fileName,
        speakers: transcript.speakers,
        modifiedAt: transcript.source.modifiedAt,
        meetingDate: transcript.meetingDate,
      });
      meetings.push(created);
      await this.attachRecord(transcript, {
        id: created.id,
        occurrenceKey: created.occurrenceKey,
        calendarEventId: created.calendarEventId,
      });
      linked += 1;
      this.deps.log?.(`transcript ${transcript.id} created Meeting ${created.id}`);
    }
    return { linked };
  }

  /**
   * Attach one Transcript to its Meeting. Idempotent: a Transcript already
   * carrying this Meeting is left alone and reports no write.
   */
  async attachTranscript(
    transcriptId: string,
    matched: MatchedMeeting,
  ): Promise<{ attached: boolean }> {
    const record = this.deps.listTranscripts().find((candidate) => candidate.id === transcriptId);
    if (!record) throw new MeetingJoinError("unknown-transcript");
    return this.attachRecord(record, matched);
  }

  /** The catalogued Transcripts of one Meeting, for its page. */
  transcriptsForMeeting(meetingId: string): { id: string; title: string }[] {
    return this.deps
      .listTranscripts()
      .filter((transcript) => transcript.meetingId === meetingId)
      .map((transcript) => ({ id: transcript.id, title: transcript.source.fileName }));
  }

  /**
   * Nearest Meetings for a Transcript that owns its Meeting, for the merge
   * UI. Never suggests the Meeting the Transcript already sits on.
   */
  nearMatchesFor(meetingId: string): Meeting[] {
    const meeting = this.deps.meetings.get(meetingId);
    if (!meeting) throw new MeetingJoinError("meeting-not-found");
    const transcript =
      this.deps.listTranscripts().find((candidate) => candidate.meetingId === meetingId) ?? null;
    if (!transcript) return [];
    const candidates = this.deps.meetings.list().filter((candidate) => candidate.id !== meeting.id);
    return findNearMatches(transcript, candidates);
  }

  /**
   * Carry a transcript-owned Meeting's Transcripts across to the Calendar
   * Meeting they belong to, then forget the transcript-owned shell, so
   * exactly one Meeting remains. The source must be transcript-owned: a
   * Calendar Meeting is never deleted by a merge. The shell is removed only
   * after every Transcript has carried across, so a failed merge deletes no
   * Meeting data.
   */
  async mergeTranscriptShell(
    sourceMeetingId: string,
    targetOccurrenceKey: string,
  ): Promise<Meeting> {
    const source = this.deps.meetings.get(sourceMeetingId);
    if (!source) throw new MeetingJoinError("meeting-not-found");
    if (source.occurrenceKey !== null) throw new MeetingJoinError("merge-source-has-occurrence");
    if (targetOccurrenceKey === "") throw new MeetingJoinError("target-occurrence-key-required");
    const target = this.deps.meetings.findByOccurrenceKey(targetOccurrenceKey);
    if (!target) throw new MeetingJoinError("target-meeting-not-found");
    const matched: MatchedMeeting = {
      id: target.id,
      occurrenceKey: target.occurrenceKey,
      calendarEventId: target.calendarEventId,
    };
    for (const transcript of this.transcriptsForMeeting(source.id)) {
      await this.attachTranscript(transcript.id, matched);
    }
    this.deps.meetings.remove(source.id);
    return this.deps.meetings.get(target.id) ?? target;
  }

  private async attachRecord(
    transcript: TranscriptRecord,
    matched: MatchedMeeting,
  ): Promise<{ attached: boolean }> {
    if (transcript.meetingId === matched.id) return { attached: false };
    await this.deps.attachMeeting(transcript.id, matched);
    return { attached: true };
  }
}
