import type { Meeting, TranscriptRecord } from "@chief-of-staff-demo/shared";
import { meetingFileNameMeta } from "../text/meetingFileName.js";

/**
 * How far from a Meeting's start a name timestamp or a file modification may
 * sit and still corroborate a match (issue #153). Stated policy, not a tuned
 * threshold: a transcript is usually written down within a day of the meeting.
 */
export const MEETING_MATCH_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/** What the Catalog needs to attach a Transcript to its Meeting. */
export interface MatchedMeeting {
  id: string;
  occurrenceKey: string | null;
  calendarEventId: string | null;
}

function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleSignalsMatch(transcriptTitle: string, meetingTitle: string): boolean {
  const left = normalizeTitle(transcriptTitle);
  const right = normalizeTitle(meetingTitle);
  if (left === "" || right === "") return false;
  if (left === right) return true;
  // Containment counts only above a floor, so "Q4" alone never links a meeting.
  return Math.min(left.length, right.length) >= 4 && (left.includes(right) || right.includes(left));
}

function speakersMatch(transcript: TranscriptRecord, meeting: Meeting): boolean {
  const names = new Set(
    meeting.participants
      .map((participant) => (participant.displayName ?? "").toLowerCase().trim())
      .filter((name) => name !== ""),
  );
  return transcript.speakers.some((speaker) => names.has(speaker.toLowerCase().trim()));
}

function withinTolerance(at: string, startAt: string): boolean {
  const delta = Math.abs(Date.parse(at) - Date.parse(startAt));
  return Number.isFinite(delta) && delta <= MEETING_MATCH_TOLERANCE_MS;
}

/**
 * Which Meeting a Transcript belongs to (issue #153).
 *
 * The file name is the primary evidence: its title and, when present, its
 * timestamp. Speaker names and the file's modification time corroborate. The
 * rule is deliberately stated:
 *
 * - a name that carries neither title nor timestamp never produces a match;
 * - when the name carries a timestamp, that pins the window, and one
 *   corroborating signal (title, a speaker on the roster, or modification
 *   time) guards the guess;
 * - when the name carries only a title, that title plus one corroborating
 *   signal (a speaker on the roster, or modification time) is required —
 *   a title alone never links;
 * - zero qualifying meetings, or two, mean no match: ambiguity is not
 *   resolved by picking a winner.
 */
export function findMatchingMeeting(
  transcript: TranscriptRecord,
  meetings: Meeting[],
): MatchedMeeting | null {
  const meta = meetingFileNameMeta(transcript.source.fileName);
  if (meta.title === null && meta.timestamp === null) return null;

  const qualified = meetings.filter((meeting) => {
    const titleMatch = meta.title !== null && titleSignalsMatch(meta.title, meeting.title);
    const timeMatch = meta.timestamp !== null && withinTolerance(meta.timestamp, meeting.startAt);
    const speakers = speakersMatch(transcript, meeting);
    const modifiedAt = transcript.source.modifiedAt;
    const mtimeMatch = modifiedAt !== null && withinTolerance(modifiedAt, meeting.startAt);

    if (meta.timestamp !== null) {
      return timeMatch && (titleMatch || speakers || mtimeMatch);
    }
    return titleMatch && (speakers || mtimeMatch);
  });

  if (qualified.length !== 1) return null;
  const meeting = qualified[0]!;
  return {
    id: meeting.id,
    occurrenceKey: meeting.occurrenceKey,
    calendarEventId: meeting.calendarEventId,
  };
}

/**
 * Nearest Meetings for a Transcript that owns its Meeting (issue #154), for
 * the merge UI. Same signals as the match, scored rather than gated: title
 * outweighs a shared speaker, which outweighs a nearby modification time.
 * Never suggests the Meeting the Transcript already sits on; at most five.
 */
export function findNearMatches(transcript: TranscriptRecord, meetings: Meeting[]): Meeting[] {
  return meetings
    .filter((meeting) => meeting.id !== transcript.meetingId)
    .map((meeting) => ({ meeting, score: nearMatchScore(transcript, meeting) }))
    .filter((candidate) => candidate.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.meeting.startAt.localeCompare(right.meeting.startAt),
    )
    .slice(0, 5)
    .map((candidate) => candidate.meeting);
}

function nearMatchScore(transcript: TranscriptRecord, meeting: Meeting): number {
  const meta = meetingFileNameMeta(transcript.source.fileName);
  let score = 0;
  if (meta.title !== null && titleSignalsMatch(meta.title, meeting.title)) score += 3;
  if (speakersMatch(transcript, meeting)) score += 2;
  const modifiedAt = transcript.source.modifiedAt;
  if (modifiedAt !== null && withinTolerance(modifiedAt, meeting.startAt)) score += 1;
  return score;
}

/**
 * The standing pass that joins the Transcript Catalog to the Workspace's
 * Meetings (issue #153). It runs over every catalogued Transcript, so it
 * places the ones already in the Catalog, not only newly ingested ones; a
 * Transcript that already carries its Meeting is never re-matched.
 *
 * A Transcript nothing matches owns its Meeting instead (issue #154): the
 * `createMeeting` hook records it from the file name's title, the speaker
 * labels, and the modification time, keyed on the Transcript id so a re-run
 * returns the same record. Without the hook, unmatched Transcripts stay
 * unlinked, as before.
 */
export async function associateTranscriptsWithMeetings(args: {
  transcripts: TranscriptRecord[];
  meetings: Meeting[];
  attach: (transcriptId: string, meeting: MatchedMeeting) => Promise<unknown>;
  createMeeting?: (input: {
    transcriptId: string;
    title: string;
    speakers: string[];
    modifiedAt: string | null;
    meetingDate?: string | null;
  }) => Meeting | Promise<Meeting>;
  log?: (message: string) => void;
}): Promise<{ linked: number }> {
  let linked = 0;
  const meetings = [...args.meetings];
  for (const transcript of args.transcripts) {
    if (transcript.meetingId) continue;
    const meeting = findMatchingMeeting(transcript, meetings);
    if (meeting !== null) {
      await args.attach(transcript.id, meeting);
      linked += 1;
      args.log?.(`transcript ${transcript.id} matched Meeting ${meeting.id}`);
      continue;
    }
    if (!args.createMeeting) continue;
    const meta = meetingFileNameMeta(transcript.source.fileName);
    if (meta.title === null && meta.timestamp === null) continue;
    const created = await args.createMeeting({
      transcriptId: transcript.id,
      title: meta.title ?? transcript.source.fileName,
      speakers: transcript.speakers,
      modifiedAt: transcript.source.modifiedAt,
      meetingDate: transcript.meetingDate,
    });
    meetings.push(created);
    await args.attach(transcript.id, {
      id: created.id,
      occurrenceKey: created.occurrenceKey,
      calendarEventId: created.calendarEventId,
    });
    linked += 1;
    args.log?.(`transcript ${transcript.id} created Meeting ${created.id}`);
  }
  return { linked };
}
