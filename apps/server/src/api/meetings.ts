import type { FastifyInstance } from "fastify";
import type { TranscriptRecord } from "@chief-of-staff-demo/shared";
import { findNearMatches, type MatchedMeeting } from "../meetings/matching.js";
import type { WorkspaceMeetings } from "../meetings/store.js";

export interface MeetingsApiContext {
  /** The Workspace's Meetings (ADR-0050); routes stay thin over the store. */
  meetings: WorkspaceMeetings;
  /** The catalogued Transcripts of one Meeting, for its page (issue #153). */
  transcriptsFor: (meetingId: string) => { id: string; title: string }[];
  /** First catalogued Transcript on a Meeting, for near-match scoring (issue #154). */
  transcriptForMeeting?: ((meetingId: string) => TranscriptRecord | null) | undefined;
  /** Move a Transcript's Meeting link; the merge route carries orphans across (issue #154). */
  attachTranscript?:
    ((transcriptId: string, meeting: MatchedMeeting) => Promise<unknown>) | undefined;
}

/**
 * The Meeting resource (ADR-0050).
 *
 * A Meeting is addressed by its own identity, never by its Calendar occurrence
 * key, because a Meeting created from a Transcript alone has no occurrence key
 * to be addressed by. `/api/meetings/overview` stays where it is: Fastify
 * prefers the static segment over the parameter, so the two do not collide.
 */
export function registerMeetingsApi(app: FastifyInstance, ctx: MeetingsApiContext): void {
  app.get("/api/meetings/list", async () => ctx.meetings.index());

  app.get("/api/meetings/:meetingId", async (request, reply) => {
    const { meetingId } = request.params as { meetingId: string };
    const meeting = ctx.meetings.get(meetingId);
    if (!meeting) {
      reply.code(404).send({ error: "meeting-not-found" });
      return;
    }
    return meeting;
  });

  /* The Transcripts the Catalog has matched to this Meeting (issue #153). */
  app.get("/api/meetings/:meetingId/transcripts", async (request) => {
    const { meetingId } = request.params as { meetingId: string };
    return { transcripts: ctx.transcriptsFor(meetingId) };
  });

  /* Nearest Meetings for a transcript-owned Meeting, for the merge UI (issue #154). */
  app.get("/api/meetings/:meetingId/near-matches", async (request, reply) => {
    const { meetingId } = request.params as { meetingId: string };
    const meeting = ctx.meetings.get(meetingId);
    if (!meeting) {
      reply.code(404).send({ error: "meeting-not-found" });
      return;
    }
    const transcript = ctx.transcriptForMeeting?.(meetingId) ?? null;
    if (!transcript) return { nearMatches: [] };
    const candidates = ctx.meetings.list().filter((candidate) => candidate.id !== meeting.id);
    return { nearMatches: findNearMatches(transcript, candidates) };
  });

  /*
   * Carry a transcript-owned Meeting's Transcripts across to the Calendar
   * Meeting they belong to, then forget the transcript-owned shell, so
   * exactly one Meeting remains (issue #154). The source must be
   * transcript-owned: a Calendar Meeting is never deleted by a merge.
   */
  app.post("/api/meetings/:meetingId/merge", async (request, reply) => {
    const { meetingId } = request.params as { meetingId: string };
    const { targetOccurrenceKey } = (request.body ?? {}) as { targetOccurrenceKey?: unknown };
    const source = ctx.meetings.get(meetingId);
    if (!source) {
      reply.code(404).send({ error: "meeting-not-found" });
      return;
    }
    if (source.occurrenceKey !== null) {
      reply.code(400).send({ error: "merge-source-has-occurrence" });
      return;
    }
    if (typeof targetOccurrenceKey !== "string" || targetOccurrenceKey === "") {
      reply.code(400).send({ error: "target-occurrence-key-required" });
      return;
    }
    const target = ctx.meetings.findByOccurrenceKey(targetOccurrenceKey);
    if (!target) {
      reply.code(404).send({ error: "target-meeting-not-found" });
      return;
    }
    if (!ctx.attachTranscript) {
      reply.code(500).send({ error: "merge-unavailable" });
      return;
    }
    const matched: MatchedMeeting = {
      id: target.id,
      occurrenceKey: target.occurrenceKey,
      calendarEventId: target.calendarEventId,
    };
    for (const transcript of ctx.transcriptsFor(source.id)) {
      await ctx.attachTranscript(transcript.id, matched);
    }
    ctx.meetings.remove(source.id);
    return ctx.meetings.get(target.id) ?? target;
  });
}
