import type {
  Meeting,
  TranscriptAssociation,
  TranscriptAssociationSignal,
  TranscriptRecord,
} from "@chief-of-staff-demo/shared";
import { meetingFileNameMeta } from "../text/meetingFileName.js";
import {
  MEETING_MATCH_TOLERANCE_MS,
  MEETING_NAME_TIME_TOLERANCE_MS,
  rosterOf,
  signalsFor,
  type MatchedMeeting,
} from "./matching.js";
import { meetingTimeAnchor } from "./timeAnchor.js";

/**
 * Where a Transcript belongs, and on what evidence (#356, ADR-0082).
 *
 * The rule the whole module exists to hold: a file name, a title, a time and
 * a speaker are *evidence*, and evidence is offered to the owner rather than
 * acted on. Only the source supplying the Calendar occurrence, or a person
 * saying so, places a Transcript on a Calendar Meeting. Uniqueness is not
 * confidence — a single Meeting lining up with a file name is exactly the
 * case where a wrong owner and a wrong deadline look most convincing.
 *
 * Everything observed is recorded either way, so a placement can be read back
 * later and a refusal can be reviewed rather than guessed at again.
 */
export type AssociationDecision =
  /** Place it: the evidence is trusted. */
  | { kind: "attach"; meeting: MatchedMeeting; association: TranscriptAssociation }
  /** Leave it on a Meeting of its own; the candidates are for the owner. */
  | { kind: "review"; association: TranscriptAssociation }
  /** Already placed by something that outranks a fresh guess. */
  | { kind: "settled"; association: TranscriptAssociation };

/**
 * The association a Transcript should hold now. Pure: it reads the record and
 * the Workspace's Meetings and decides nothing about writing.
 */
export function decideAssociation(
  transcript: TranscriptRecord,
  meetings: Meeting[],
  now: string,
): AssociationDecision {
  const held = transcript.association;
  /* A Meeting a Transcript owns is the outcome of failing to place it, not a
     placement: Calendar arrives late, so it is looked at again. Sitting on a
     Calendar Meeting is a placement, whoever or whatever made it. */
  const onCalendar =
    transcript.meetingId !== null &&
    (meetings.find((meeting) => meeting.id === transcript.meetingId)?.occurrenceKey ?? null) !==
      null;
  if (onCalendar && held !== null && held.basis !== "transcript-owned") {
    return { kind: "settled", association: held };
  }
  /* Placed before provenance was recorded. It stays unknown: reading current
     Calendar facts back onto it would manufacture a confirmation nobody made. */
  if (onCalendar && held === null) {
    return {
      kind: "settled",
      association: {
        basis: "legacy-unknown",
        signals: [],
        candidateMeetingIds: [],
        recordedAt: transcript.ingestedAt,
      },
    };
  }

  const candidates = candidateMeetings(transcript, meetings);
  const trusted =
    transcript.occurrence !== null
      ? (meetings.find(
          (meeting) => meeting.occurrenceKey === transcript.occurrence?.occurrenceKey,
        ) ?? null)
      : null;
  if (trusted !== null) {
    return {
      kind: "attach",
      meeting: {
        id: trusted.id,
        occurrenceKey: trusted.occurrenceKey,
        calendarEventId: trusted.calendarEventId,
        timeAnchor: meetingTimeAnchor(trusted),
        roster: rosterOf(trusted),
      },
      association: {
        basis: "trusted-occurrence",
        signals: ["trusted-occurrence", ...candidates.signals],
        candidateMeetingIds: candidates.ids,
        recordedAt: now,
      },
    };
  }
  return {
    kind: "review",
    association: {
      basis: "transcript-owned",
      signals: candidates.signals,
      candidateMeetingIds: candidates.ids,
      recordedAt: now,
    },
  };
}

/**
 * Calendar Meetings any signal points at, and the signals that pointed. Not a
 * ranking and not a winner: the owner reads this, and a list of one is still
 * a list.
 */
function candidateMeetings(
  transcript: TranscriptRecord,
  meetings: Meeting[],
): { ids: string[]; signals: TranscriptAssociationSignal[] } {
  const meta = meetingFileNameMeta(transcript.source.fileName);
  const ids: string[] = [];
  const signals = new Set<TranscriptAssociationSignal>();
  for (const meeting of meetings) {
    if (meeting.occurrenceKey === null) continue;
    const observed = signalsFor(transcript, meeting, meta, {
      nameTimeToleranceMs: MEETING_NAME_TIME_TOLERANCE_MS,
      toleranceMs: MEETING_MATCH_TOLERANCE_MS,
    });
    if (observed.length === 0) continue;
    ids.push(meeting.id);
    for (const signal of observed) signals.add(signal);
  }
  return { ids, signals: [...signals] };
}
