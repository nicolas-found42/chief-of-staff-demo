import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify from "fastify";
import type {
  TranscriptRecord,
  MeetingWorkspaceView,
  MeetingHistoryView,
} from "@chief-of-staff-demo/shared";
import { afterEach, expect, test, vi } from "vitest";
import { WorkspaceMeetings } from "../../../apps/server/src/meetings/store";
import { MeetingRead } from "../../../apps/server/src/meetings/read";
import { openRuns } from "../../../apps/server/src/runs";
import { TaskStore } from "../../../apps/server/src/tasks/store";
import { WorkspaceActionItems } from "../../../apps/server/src/tasks/action-items";

type GoogleReadState = "unconfigured" | "disconnected" | "connected" | "expired";
type IntakeVerdict =
  | "provider-required"
  | "google-required"
  | "folder-required"
  | "polling-required"
  | "consent-required"
  | "intake-running"
  | "waiting-for-transcript"
  | "intake-failed"
  | "intake-paused"
  | "ready";
interface TranscriptIntakeFacts {
  providerReady: boolean;
  googleState: GoogleReadState;
  folderSelected: boolean;
  pollingEnabled: boolean;
  consentGranted: boolean;
  backfill: "idle" | "running" | "paused";
  failed: number;
  transcriptCount: number;
}
interface IntakeReadiness {
  verdict: IntakeVerdict;
  nextAction: { label: string; href: string } | null;
}
const READY_INTAKE: TranscriptIntakeFacts = {
  providerReady: true,
  googleState: "connected",
  folderSelected: true,
  pollingEnabled: true,
  consentGranted: true,
  backfill: "idle",
  failed: 0,
  transcriptCount: 1,
};
const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup(
  now = "2026-09-09T16:00:00Z",
  timezone = "America/New_York",
  intake: TranscriptIntakeFacts = { ...READY_INTAKE },
) {
  const dir = mkdtempSync(join(tmpdir(), "meeting-read-"));
  dirs.push(dir);
  const meetings = new WorkspaceMeetings(dir);
  const runs = openRuns(dir);
  const actionItems = new WorkspaceActionItems({ store: new TaskStore(dir) });
  const transcripts: TranscriptRecord[] = [];
  const deps = {
    meetings,
    runs,
    actionItems,
    transcripts: () => transcripts,
    now: () => new Date(now),
    timezone: () => timezone,
    transcriptIntake: () => intake,
  };
  const read = new MeetingRead(deps);
  const app = fastify();
  read.registerRoutes(app);
  return { app, meetings, runs, actionItems, transcripts, dir, intake };
}

test("globally empty Meeting history exposes the first unmet Transcript Intake action", async () => {
  const { app } = setup("2026-09-09T16:00:00Z", "America/New_York", {
    ...READY_INTAKE,
    providerReady: false,
    folderSelected: false,
    pollingEnabled: false,
    consentGranted: false,
  });

  const view = (await app.inject("/api/meetings/workspace")).json<{
    historyBeginsAt: string | null;
    today: unknown[];
    recent: unknown[];
    upcoming: unknown[];
    intakeReadiness: IntakeReadiness;
  }>();
  expect(view).toMatchObject({
    historyBeginsAt: null,
    today: [],
    recent: [],
    upcoming: [],
    intakeReadiness: {
      verdict: "provider-required",
      nextAction: { label: "Configure a model provider", href: "/onboarding?goal=meetings" },
    },
  });
  expect(JSON.stringify(view)).not.toMatch(/upload|secret|credential/i);
  await app.close();
});

test.each([
  [{ providerReady: false }, "provider-required", "/onboarding?goal=meetings"],
  [{ googleState: "disconnected" as const }, "google-required", "/onboarding?goal=meetings"],
  [{ folderSelected: false }, "folder-required", "/settings#drive-folder"],
  [{ pollingEnabled: false }, "polling-required", "/settings#drive-polling"],
  [{ consentGranted: false }, "consent-required", "/settings#transcript-consent"],
] satisfies [Partial<TranscriptIntakeFacts>, IntakeVerdict, string][])(
  "Meeting reads give %s the first unmet Transcript Intake action",
  async (facts, verdict, href) => {
    const { app } = setup("2026-09-09T16:00:00Z", "America/New_York", {
      ...READY_INTAKE,
      ...facts,
    });
    const response = await app.inject("/api/meetings/workspace");
    const readiness = response.json<{ intakeReadiness: IntakeReadiness }>().intakeReadiness;
    expect(readiness).toMatchObject({ verdict, nextAction: { href } });
    await app.close();
  },
);

test("configured intake waits for a Drive transcript and offers the existing sync control", async () => {
  const { app } = setup("2026-09-09T16:00:00Z", "America/New_York", {
    ...READY_INTAKE,
    transcriptCount: 0,
  });
  const response = await app.inject("/api/meetings/workspace");
  expect(response.json<{ intakeReadiness: IntakeReadiness }>().intakeReadiness).toEqual({
    verdict: "waiting-for-transcript",
    nextAction: { label: "Sync now", href: "/settings#transcript-sync" },
  });
  expect(response.body).not.toMatch(/upload/i);
  await app.close();
});

test.each([0, 3])(
  "a paused backfill stays paused with %i catalogued transcripts",
  async (transcriptCount) => {
    const { app } = setup("2026-09-09T16:00:00Z", "America/New_York", {
      ...READY_INTAKE,
      backfill: "paused",
      transcriptCount,
    });

    const response = await app.inject("/api/meetings/workspace");

    expect(response.json<{ intakeReadiness: IntakeReadiness }>().intakeReadiness).toEqual({
      verdict: "intake-paused",
      nextAction: null,
    });
    await app.close();
  },
);

test("a populated Meeting missing its Transcript gets the same action in overview and detail", async () => {
  const { app, meetings } = setup("2026-09-09T16:00:00Z", "America/New_York", {
    ...READY_INTAKE,
    pollingEnabled: false,
  });
  const meeting = meetings.upsertFromCalendar({
    occurrenceKey: "missing-transcript",
    calendarEventId: "missing-transcript",
    occurrenceId: "missing-transcript",
    title: "Calendar-only planning",
    startAt: "2026-09-09T14:00:00.000Z",
    endAt: "2026-09-09T15:00:00.000Z",
    participants: [],
    cancelled: false,
    ineligibleReason: null,
  });

  const workspace = (await app.inject("/api/meetings/workspace")).json<{
    intakeReadiness: IntakeReadiness;
    today: { id: string; debrief: { status: string; nextAction: IntakeReadiness["nextAction"] } }[];
  }>();
  const detail = (await app.inject(`/api/meetings/${meeting.id}/read`)).json<{
    intakeReadiness: IntakeReadiness;
    meeting: { debrief: { status: string; nextAction: IntakeReadiness["nextAction"] } };
  }>();
  const action = {
    label: "Enable Drive polling",
    href: "/settings#drive-polling",
  };
  expect(workspace.intakeReadiness).toEqual({
    verdict: "polling-required",
    nextAction: action,
  });
  expect(workspace.today[0].debrief).toMatchObject({ status: "no-transcript", nextAction: action });
  expect(detail.intakeReadiness).toEqual(workspace.intakeReadiness);
  expect(detail.meeting.debrief).toMatchObject({ status: "no-transcript", nextAction: action });
  await app.close();
});
test("History reads retained Meetings across weeks with inclusive Workspace dates and participant search", async () => {
  const { app, meetings } = setup();
  meetings.upsertFromCalendar({
    occurrenceKey: "one",
    calendarEventId: "one",
    occurrenceId: "one",
    title: "Earlier conversation",
    startAt: "2026-09-02T03:30:00Z",
    endAt: "2026-09-02T04:00:00Z",
    participants: [
      {
        email: "alice@example.com",
        displayName: "Alice",
        organizer: false,
        self: false,
        responseStatus: "accepted",
      },
    ],
    cancelled: false,
    ineligibleReason: null,
  });
  const response = await app.inject(
    "/api/meetings/history?search=ALICE&from=2026-09-01&to=2026-09-01",
  );
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    total: 1,
    page: 1,
    pageSize: 25,
    meetings: [{ title: "Earlier conversation", localDate: "2026-09-01" }],
  });
  expect((await app.inject("/api/meetings/history?from=2026-09-03&to=2026-09-01")).statusCode).toBe(
    400,
  );
  await app.close();
});
test("overview retains recent successful Debriefs after a later failure and counts all proposals by source Meeting", async () => {
  const { app, meetings, runs, actionItems, transcripts } = setup();
  const old = meetings.createFromTranscript({
    transcriptId: "old",
    title: "Last week",
    speakers: ["Alice"],
    modifiedAt: null,
    meetingDate: "2026-09-02",
  });
  transcripts.push({
    id: "old",
    meetingId: old.id,
    association: null,
    meetingDate: "2026-09-02",
    source: {
      sourceSystem: "drive",
      externalFileId: "old",
      fileName: "Last week",
      sourceUrl: null,
      checksum: "old",
      observedRevision: 1,
      modifiedAt: null,
    },
    ingestedAt: "2026-09-02T12:00:00Z",
    extractorVersion: 1,
    normalizedText: "Alice: Ship the plan.",
    occurrence: null,
    speakers: ["Alice"],
    speakerIdentityMappings: [],
    roster: [],
  });
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-09T14:00:00Z"));
  const successful = runs.create({
    module: "meeting-debrief",
    moduleVersion: 1,
    intake: "test",
    sourceUrl: null,
    externalId: "old",
  });
  successful.writeArtifact(
    "result.json",
    JSON.stringify({
      transcriptId: "old",
      debrief: { summary: "Agreed to ship the revised plan." },
    }),
  );
  successful.finished({ status: "done" });
  vi.setSystemTime(new Date("2026-09-09T14:01:00Z"));
  const failed = runs.create({
    module: "meeting-debrief",
    moduleVersion: 1,
    intake: "test",
    sourceUrl: null,
    externalId: "old",
  });
  failed.failed("extract", "secret credential", "stack trace");
  actionItems.materialize({
    debriefRunId: successful.id,
    transcriptId: "old",
    meetingId: old.id,
    actionItems: Array.from({ length: 47 }, (_, n) => ({
      title: `Proposal ${n}`,
      owner: null,
      dueDate: "2026-09-03",
      ownerProfileId: null,
      ownerMentionId: null,
    })),
  });
  const response = await app.inject("/api/meetings/workspace");
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    today: [],
    recent: [
      {
        id: old.id,
        debrief: {
          status: "ready",
          runId: successful.id,
          latestAttempt: "failed",
          summary: "Agreed to ship the revised plan.",
        },
        pendingCount: 47,
      },
    ],
    proposals: {
      total: 47,
      meetingCount: 1,
      missingSourceCount: 0,
      groups: [{ meetingId: old.id, count: 47 }],
    },
  });
  expect(response.json<MeetingWorkspaceView>().proposals!.groups[0].items).toHaveLength(3);
  expect(response.body).not.toContain("secret credential");
  await app.close();
});

test("transcript timestamps remain timed while date-only Meetings keep their stated day even in UTC+14", async () => {
  const { app, meetings } = setup("2026-09-09T12:00:00Z", "Pacific/Kiritimati");
  meetings.createFromTranscript({
    transcriptId: "date",
    title: "Date only",
    speakers: [],
    modifiedAt: null,
    meetingDate: "2026-09-02",
  });
  meetings.createFromTranscript({
    transcriptId: "timed",
    title: "Timestamp known",
    speakers: [],
    modifiedAt: null,
    nameTimestamp: "2026-09-02T13:00:00Z",
  });
  const result = (await app.inject("/api/meetings/history")).json<MeetingHistoryView>();
  expect(result.meetings.find((m: { title: string }) => m.title === "Date only")).toMatchObject({
    localDate: "2026-09-02",
    dateOnly: true,
  });
  expect(
    result.meetings.find((m: { title: string }) => m.title === "Timestamp known"),
  ).toMatchObject({ localDate: "2026-09-03", dateOnly: false });
  await app.close();
});

test("History pagination is deterministic, excludes cancellation by default, and never duplicates occurrence revisions", async () => {
  const { app, meetings } = setup();
  for (let n = 0; n < 27; n++) {
    const occurrence = {
      occurrenceKey: `tie-${n}`,
      calendarEventId: `tie-${n}`,
      occurrenceId: "same",
      title: `Meeting ${n}`,
      startAt: "2026-09-01T12:00:00Z",
      endAt: "2026-09-01T13:00:00Z",
      participants: [],
      cancelled: n === 26,
      ineligibleReason: null,
    };
    meetings.upsertFromCalendar(occurrence);
    meetings.upsertFromCalendar(occurrence);
  }
  const first = (await app.inject("/api/meetings/history")).json<MeetingHistoryView>();
  const second = (await app.inject("/api/meetings/history?page=2")).json<MeetingHistoryView>();
  expect(first).toMatchObject({ total: 26, page: 1, pageSize: 25 });
  expect(second.meetings).toHaveLength(1);
  expect(new Set([...first.meetings, ...second.meetings].map((m) => m.id)).size).toBe(26);
  expect(
    (await app.inject("/api/meetings/history?includeCancelled=true")).json<MeetingHistoryView>()
      .total,
  ).toBe(27);
  expect((await app.inject("/api/meetings/history?search=absent")).json()).toMatchObject({
    total: 0,
    retainedTotal: 27,
  });
  expect((await app.inject("/api/meetings/history?page=999")).json<MeetingHistoryView>().page).toBe(
    2,
  );
  expect((await app.inject("/api/meetings/history?from=2026-02-30")).statusCode).toBe(400);
  await app.close();
});

test("Workspace midnight and DST use calendar days; exact start and end select the right group", async () => {
  const { app, meetings } = setup("2026-03-08T07:00:00Z", "America/New_York");
  const event = (key: string, startAt: string, endAt: string) =>
    meetings.upsertFromCalendar({
      occurrenceKey: key,
      calendarEventId: key,
      occurrenceId: key,
      title: key,
      startAt,
      endAt,
      participants: [],
      cancelled: false,
      ineligibleReason: null,
    });
  event("ends now", "2026-03-08T06:00:00Z", "2026-03-08T07:00:00Z");
  event("starts now", "2026-03-08T07:00:00Z", "2026-03-08T08:00:00Z");
  event("previous day", "2026-03-08T04:30:00Z", "2026-03-08T04:45:00Z");
  event("seventh local day", "2026-03-16T03:30:00Z", "2026-03-16T04:00:00Z");
  event("eighth local day", "2026-03-16T04:00:00Z", "2026-03-16T05:00:00Z");
  const view = (await app.inject("/api/meetings/workspace")).json<MeetingWorkspaceView>();
  expect(view).toMatchObject({
    localToday: "2026-03-08",
    upcomingFrom: "2026-03-09",
    upcomingTo: "2026-03-15",
  });
  expect(view.today.map((m: { title: string; group: string }) => [m.title, m.group])).toEqual([
    ["ends now", "completed"],
    ["starts now", "in-progress"],
  ]);
  expect(view.upcoming.map((m: { title: string }) => m.title)).toEqual(["seventh local day"]);
  await app.close();
});

test("failed attempts requiring Google reconnection offer the remedy rather than an unusable retry", async () => {
  const { app, meetings, runs } = setup();
  meetings.upsertFromCalendar({
    occurrenceKey: "future",
    calendarEventId: "future",
    occurrenceId: "future",
    title: "Future",
    startAt: "2026-09-09T19:00:00Z",
    endAt: "2026-09-09T20:00:00Z",
    participants: [],
    cancelled: false,
    ineligibleReason: null,
  });
  const run = runs.create({
    module: "meeting-brief-generator",
    moduleVersion: 1,
    intake: "test",
    sourceUrl: null,
    externalId: "future",
  });
  run.failed("snapshot", "raw private secret", "internal details", { connectionState: "expired" });
  const result = (await app.inject("/api/meetings/workspace")).json<MeetingWorkspaceView>();
  expect(result.today[0].brief).toMatchObject({
    status: "failed",
    retryRunId: null,
    remedy: "/settings",
    explanation: "Reconnect Google in Settings before retrying this Brief.",
  });
  await app.close();
});

test("unreadable proposal data is labelled unavailable while Meeting artifacts remain readable", async () => {
  const { app, meetings, runs, dir } = setup();
  meetings.upsertFromCalendar({
    occurrenceKey: "ready",
    calendarEventId: "ready",
    occurrenceId: "ready",
    title: "Ready Meeting",
    startAt: "2026-09-09T19:00:00Z",
    endAt: "2026-09-09T20:00:00Z",
    participants: [],
    cancelled: false,
    ineligibleReason: null,
  });
  const run = runs.create({
    module: "meeting-brief-generator",
    moduleVersion: 1,
    intake: "test",
    sourceUrl: null,
    externalId: "ready",
  });
  run.writeArtifact(
    "result.json",
    JSON.stringify({ meetingBrief: { summary: "Prepared for the decision." } }),
  );
  run.finished({ status: "done" });
  mkdirSync(join(dir, "tasks"), { recursive: true });
  writeFileSync(join(dir, "tasks", "action-items.json"), "unreadable");
  const view = (await app.inject("/api/meetings/workspace")).json<MeetingWorkspaceView>();
  expect(view.today[0]).toMatchObject({
    pendingCount: null,
    brief: { status: "ready", summary: "Prepared for the decision." },
  });
  expect(view.proposals).toBeNull();
  expect(view.partial).toContain(
    "Action Item counts unavailable; other meeting data is still shown.",
  );
  await app.close();
});

test("a later failed retry on an older Brief attempt remains visible beside the newer successful artifact", async () => {
  const { app, meetings, runs } = setup();
  meetings.upsertFromCalendar({
    occurrenceKey: "retry",
    calendarEventId: "retry",
    occurrenceId: "retry",
    title: "Retry history",
    startAt: "2026-09-09T19:00:00Z",
    endAt: "2026-09-09T20:00:00Z",
    participants: [],
    cancelled: false,
    ineligibleReason: null,
  });
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-09T12:00:00Z"));
  const older = runs.create({
    module: "meeting-brief-generator",
    moduleVersion: 1,
    intake: "test",
    sourceUrl: null,
    externalId: "retry",
  });
  older.failed("compose", "first failure", "first failure");
  vi.setSystemTime(new Date("2026-09-09T13:00:00Z"));
  const successful = runs.create({
    module: "meeting-brief-generator",
    moduleVersion: 1,
    intake: "test",
    sourceUrl: null,
    externalId: "retry",
  });
  successful.writeArtifact(
    "result.json",
    JSON.stringify({ meetingBrief: { summary: "The retained plan." } }),
  );
  successful.finished({ status: "done" });
  vi.setSystemTime(new Date("2026-09-09T14:00:00Z"));
  older.reopen("compose", "owner requested retry");
  older.failed("compose", "later failure", "later failure");
  const view = (await app.inject("/api/meetings/workspace")).json<MeetingWorkspaceView>();
  expect(view.today[0].brief).toMatchObject({
    runId: successful.id,
    status: "ready",
    latestAttempt: "failed",
    summary: "The retained plan.",
  });
  await app.close();
});

test("source-Meeting proposal groups put the later conversation first within the same day", async () => {
  const { app, meetings, actionItems } = setup();
  for (const [transcriptId, title, timestamp] of [
    ["aaa", "Morning", "2026-09-01T13:00:00Z"],
    ["zzz", "Afternoon", "2026-09-01T19:00:00Z"],
  ]) {
    const meeting = meetings.createFromTranscript({
      transcriptId,
      title,
      nameTimestamp: timestamp,
      speakers: [],
      modifiedAt: null,
    });
    actionItems.materialize({
      debriefRunId: transcriptId,
      transcriptId,
      meetingId: meeting.id,
      actionItems: [
        {
          title: `Follow up ${title}`,
          owner: null,
          ownerMentionId: null,
          ownerProfileId: null,
          dueDate: null,
        },
      ],
    });
  }
  const view = (await app.inject("/api/meetings/workspace")).json<MeetingWorkspaceView>();
  expect(view.proposals?.groups.map((group) => group.title)).toEqual(["Afternoon", "Morning"]);
  await app.close();
});

test("a readable Brief distinguishes failed email delivery from failed preparation", async () => {
  const { app, meetings, runs } = setup();
  meetings.upsertFromCalendar({
    occurrenceKey: "delivery",
    calendarEventId: "delivery",
    occurrenceId: "delivery",
    title: "Prepared Meeting",
    startAt: "2026-09-09T19:00:00Z",
    endAt: "2026-09-09T20:00:00Z",
    participants: [],
    cancelled: false,
    ineligibleReason: null,
  });
  const run = runs.create({
    module: "meeting-brief-generator",
    moduleVersion: 1,
    intake: "test",
    sourceUrl: null,
    externalId: "delivery",
  });
  run.writeArtifact(
    "result.json",
    JSON.stringify({
      meetingBrief: { summary: "The full Brief is ready." },
      delivery: { status: "failed" },
    }),
  );
  run.failed("deliver", "provider unavailable", "private diagnostic");
  const view = (await app.inject("/api/meetings/workspace")).json<MeetingWorkspaceView>();
  expect(view.today[0].brief).toMatchObject({
    status: "ready",
    explanation: "Brief ready. Email delivery failed; the Brief remains readable.",
  });
  await app.close();
});
