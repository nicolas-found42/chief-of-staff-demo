import type { FastifyInstance } from "fastify";
import type { MeetingDebriefExtraction, TranscriptRecord } from "@chief-of-staff-demo/shared";
import type { WorkspaceMeetings } from "./store.js";
import type { Runs } from "../runs.js";
import type { MeetingDebriefTestRuntime } from "../modules/meeting-debrief/testRuntime.js";
import type { MeetingBriefTestRuntime } from "../modules/meeting-brief-generator/testRuntime.js";

/** Synthetic acceptance fixture, registered only in the hermetic application. */
export function registerMeetingReadTestRoutes(
  app: FastifyInstance,
  deps: {
    meetings: WorkspaceMeetings;
    runs: Runs;
    brief: MeetingBriefTestRuntime;
    debrief: MeetingDebriefTestRuntime;
  },
) {
  app.post("/api/test/meetings/overview-fixture", async () => {
    deps.brief.setNow(new Date("2026-09-09T14:00:00Z"));
    const today = deps.meetings.upsertFromCalendar({
      occurrenceKey: "overview-today",
      calendarEventId: "overview-today",
      occurrenceId: "2026-09-09T19:00:00Z",
      title: "Today's planning",
      startAt: "2026-09-09T19:00:00Z",
      endAt: "2026-09-09T20:00:00Z",
      participants: [
        {
          email: "owner@example.com",
          displayName: "Owner",
          self: true,
          organizer: true,
          responseStatus: "accepted",
        },
        {
          email: "alice@example.com",
          displayName: "Alice",
          self: false,
          organizer: false,
          responseStatus: "accepted",
        },
      ],
      cancelled: false,
      ineligibleReason: null,
    });
    const failed = deps.runs.create({
      module: "meeting-brief-generator",
      moduleVersion: 1,
      intake: "test",
      sourceUrl: null,
      externalId: today.occurrenceKey,
    });
    failed.failed("snapshot", "synthetic private failure detail", "synthetic private diagnostic");
    const recent: { id: string; runId: string; transcriptId: string }[] = [];
    for (let n = 1; n <= 5; n++) {
      const transcriptId = `overview-history-${n}`;
      const date = `2026-09-0${n}`;
      const meeting = deps.meetings.createFromTranscript({
        transcriptId,
        title: `September ${n} planning`,
        meetingDate: date,
        speakers: ["Alice", "Bob"],
        modifiedAt: null,
      });
      const transcript: TranscriptRecord = {
        id: transcriptId,
        meetingId: meeting.id,
        association: null,
        source: {
          sourceSystem: "drive",
          externalFileId: transcriptId,
          fileName: `${meeting.title}.txt`,
          sourceUrl: null,
          checksum: transcriptId,
          observedRevision: 1,
          modifiedAt: null,
        },
        ingestedAt: `${date}T12:00:00Z`,
        extractorVersion: 1,
        normalizedText:
          "Alice: We agreed to ship the reviewed plan.\nBob: I will follow up tomorrow.",
        meetingDate: date,
        occurrence: null,
        speakers: ["Alice", "Bob"],
        speakerIdentityMappings: [],
        roster: [],
      };
      const extraction: MeetingDebriefExtraction = {
        version: 1,
        summary: `We agreed on the September ${n} plan.`,
        decisions: Array.from({ length: n === 5 ? 8 : 1 }, (_, i) => ({
          statement: `Proceed with plan ${n}, decision ${i + 1}.`,
          evidence: `The participants agreed on decision ${i + 1}.`,
        })),
        actionItems: Array.from({ length: n === 5 ? 11 : 9 }, (_, item) => ({
          title: `Follow up tomorrow ${n}-${item}`,
          owner: item % 2 ? "Bob" : null,
          ownerMentionId: n === 4 && item % 2 ? "overview-bob" : null,
          ownerProfileId: null,
          dueDate: item % 2 ? "2026-09-06" : null,
        })),
        openQuestions: [],
        effectivenessEvidence: "The plan was explicitly agreed.",
        coachingAdvice: "Confirm the follow-up.",
        suggestedRecipients: [],
      };
      const runId = await deps.debrief.seed({
        transcript,
        extraction,
        ...(n === 4
          ? {
              identity: {
                mentions: [
                  {
                    id: "overview-bob",
                    kind: "person",
                    surfaceText: "Bob",
                    normalizedForms: ["bob"],
                    emails: [],
                    profileUrls: [],
                    verifiedHandles: {},
                    externalContactIds: [],
                    speakerCalendarEmail: null,
                    titles: [],
                    roles: [],
                    aliases: [],
                    relationshipAssertions: [],
                    rosterContext: [],
                    organizationContext: null,
                    attendeeStatus: "speaker",
                    confidence: "high",
                    provenance: {
                      transcriptId,
                      spanStart: 48,
                      spanEnd: 82,
                      quote: "Bob: I will follow up tomorrow.",
                      timestamp: "00:15",
                      speakerLabel: "Bob",
                      meetingDate: date,
                    },
                    minedAt: `${date}T12:00:00Z`,
                    algorithmVersion: 1,
                  },
                ],
              },
            }
          : {}),
      });
      recent.push({ id: meeting.id, runId, transcriptId });
    }
    return { todayId: today.id, briefRunId: failed.id, recent };
  });
  app.post("/api/test/meetings/history-fixture", async () => {
    deps.brief.setNow(new Date("2026-09-09T14:00:00Z"));
    const meetings = [];
    for (let n = 0; n < 28; n++) {
      const input = {
        occurrenceKey: `history-${n}`,
        calendarEventId: `history-${n}`,
        occurrenceId: "2026-09-01T15:00:00Z",
        title: `History session ${String(n).padStart(2, "0")}`,
        startAt: "2026-09-01T15:00:00Z",
        endAt: "2026-09-01T16:00:00Z",
        participants: [
          {
            email: "alex@example.com",
            displayName: "Alex",
            self: false,
            organizer: false,
            responseStatus: "accepted" as const,
          },
        ],
        cancelled: n === 27,
        ineligibleReason: null,
      };
      deps.meetings.upsertFromCalendar(input);
      meetings.push(deps.meetings.upsertFromCalendar(input));
    }
    return { meetings };
  });
  app.post("/api/test/meetings/failed-brief", async (request) => {
    const { occurrenceKey } = request.body as { occurrenceKey: string };
    const run = deps.runs.create({
      module: "meeting-brief-generator",
      moduleVersion: 1,
      intake: "test",
      sourceUrl: null,
      externalId: occurrenceKey,
    });
    run.failed("compose", "synthetic private failure", "synthetic private diagnostic");
    return { runId: run.id };
  });
  app.post("/api/test/meetings/failed-debrief", async (request) => {
    const { transcriptId } = request.body as { transcriptId: string };
    const run = deps.runs.create({
      module: "meeting-debrief",
      moduleVersion: 1,
      intake: "test",
      sourceUrl: null,
      externalId: transcriptId,
    });
    run.failed("extract", "synthetic private failure", "synthetic private diagnostic");
    return { runId: run.id };
  });
}
