import type { FastifyInstance } from "fastify";
import type { WorkspaceMeetings } from "../meetings/store.js";

export interface MeetingsApiContext {
  /** The Workspace's Meetings (ADR-0050); routes stay thin over the store. */
  meetings: WorkspaceMeetings;
  /** The catalogued Transcripts of one Meeting, for its page (issue #153). */
  transcriptsFor: (meetingId: string) => { id: string; title: string }[];
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
}
