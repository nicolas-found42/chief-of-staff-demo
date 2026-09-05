import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { WorkspaceMeetings } from "../../../apps/server/src/meetings/store";
import { TaskStore } from "../../../apps/server/src/tasks/store";
import { WorkspaceTasks } from "../../../apps/server/src/tasks/tasks";
import { WorkspaceActionItems } from "../../../apps/server/src/tasks/action-items";
import { openRuns, type RunHandle, type Runs } from "../../../apps/server/src/runs";
import type { CompleteJson } from "../../../apps/server/src/llm/providers";
import { WeeklyWorkspace } from "../../../apps/server/src/meetings/weekly";
import type { WeeklySummaryState, WeeklyWorkspaceView } from "@chief-of-staff-demo/shared";

/** A Gmail delivery double: one message per deliveryId, reconcilable like the real one. */
class FakeDelivery {
  readonly sent: Array<{ subject: string; text: string; deliveryId: string }> = [];
  /** Every parameter the caller passed, so a test can prove what it did not pass. */
  readonly params: Array<Record<string, unknown>> = [];
  fail = false;
  async send(params: { subject: string; text: string; html: string; deliveryId: string }) {
    if (this.fail) throw new Error("gmail refused");
    this.params.push({ ...params });
    this.sent.push({ subject: params.subject, text: params.text, deliveryId: params.deliveryId });
    return { messageId: `msg_${this.sent.length}`, recipient: "owner@example.com" };
  }
  async findByDeliveryId(deliveryId: string) {
    const index = this.sent.findIndex((message) => message.deliveryId === deliveryId);
    return index === -1 ? null : { messageId: `msg_${index + 1}`, recipient: "owner@example.com" };
  }
}

function setup(
  complete?: CompleteJson,
  delivery?: FakeDelivery,
  meetingIdForTranscript?: (transcriptId: string) => string | null,
) {
  const workspaceDir = mkdtempSync(join(tmpdir(), "cos-weekly-"));
  let instant = new Date("2026-09-03T14:00:00Z");
  let provider = "mock";
  const now = () => instant;
  const meetings = new WorkspaceMeetings(workspaceDir, now);
  const store = new TaskStore(workspaceDir);
  const tasks = new WorkspaceTasks({ store, now });
  const actionItems = new WorkspaceActionItems({ store, now });
  const runs = openRuns(workspaceDir);
  const weekly = new WeeklyWorkspace({
    workspaceDir,
    meetings,
    tasks,
    actionItems,
    runs,
    now,
    timezone: () => "America/New_York",
    ...(meetingIdForTranscript ? { meetingIdForTranscript } : {}),
    ...(complete ? { model: () => ({ provider, model: "deterministic", complete }) } : {}),
    ...(delivery
      ? { email: { deliver: delivery, enabled: () => true, ownerConfirmed: () => true } }
      : {}),
    log: () => {},
  });
  const app = fastify();
  weekly.registerRoutes(app);
  return {
    app,
    meetings,
    tasks,
    runs,
    weekly,
    workspaceDir,
    setProvider: (value: string) => {
      provider = value;
    },
    setNow: (value: string) => {
      instant = new Date(value);
    },
  };
}

/** A calendar occurrence, in the one shape every Weekly test needs it. */
function occurrence(title: string, startAt: string, endAt: string) {
  return {
    occurrenceKey: title,
    calendarEventId: title,
    occurrenceId: title,
    title,
    startAt,
    endAt,
    cancelled: false,
    participants: [],
    ineligibleReason: null,
  };
}

/**
 * One successful Meeting Brief Run for an occurrence, and the handle to revise
 * it. Revising rewrites `result.json` in place, which is what a regenerated
 * Brief looks like to the Weekly fingerprint: the same Run, new content.
 */
function briefRun(
  runs: Runs,
  externalId: string,
  summary = "Settle the release plan",
): { run: RunHandle; revise: (summary: string) => void } {
  const run = runs.create({
    module: "meeting-brief-generator",
    moduleVersion: 1,
    intake: "calendar",
    sourceUrl: null,
    externalId,
  });
  const revise = (text: string): void => {
    run.writeArtifact(
      "result.json",
      JSON.stringify({
        meetingBrief: {
          summary: text,
          conversationStarters: [],
          uncertainty: [],
          generatedAt: "2026-09-03T12:00:00Z",
        },
      }),
    );
  };
  revise(summary);
  run.finished({ status: "done" });
  return { run, revise };
}

describe("the canonical This week API", () => {
  it("summarizes only bounded successful source projections, never private evidence or Tasks", async () => {
    const requests: string[] = [];
    let fail = false;
    const { app, meetings, runs, tasks, setProvider } = setup(async (request) => {
      requests.push(request.user);
      if (fail) throw new Error("provider failure");
      return {
        text: "The pricing review will settle the release plan. Prepare the agreed launch questions.",
      };
    });
    const empty = await app.inject({ method: "GET", url: "/api/meetings/weekly" });
    expect(empty.json().summary.text).toBeNull();
    expect(requests).toEqual([]);
    meetings.upsertFromCalendar({
      occurrenceKey: "pricing",
      calendarEventId: "pricing",
      occurrenceId: "pricing",
      title: "Pricing review",
      startAt: "2026-09-04T14:00:00Z",
      endAt: "2026-09-04T15:00:00Z",
      cancelled: false,
      participants: [],
      ineligibleReason: null,
    });
    const good = runs.create({
      module: "meeting-brief-generator",
      moduleVersion: 1,
      intake: "calendar",
      sourceUrl: null,
      externalId: "pricing",
    });
    good.writeArtifact(
      "result.json",
      JSON.stringify({
        meetingBrief: {
          summary: "Settle the release plan",
          conversationStarters: ["Launch questions"],
          uncertainty: [],
          guests: [{ background: "PRIVATE_PROFILE_EVIDENCE" }],
          generatedAt: "2026-09-03T12:00:00Z",
        },
      }),
    );
    good.finished({ status: "done" });
    const failed = runs.create({
      module: "meeting-brief-generator",
      moduleVersion: 1,
      intake: "calendar",
      sourceUrl: null,
      externalId: "pricing",
    });
    failed.failed("compose", "FAILED_DIAGNOSTIC", "Retry");
    tasks.create({ title: "PRIVATE_TASK_CONTENT" });
    const response = await app.inject({ method: "GET", url: "/api/meetings/weekly" });
    expect(response.json().meetings[0]).toMatchObject({
      artifactStatus: "ready",
      sourceId: good.id,
    });
    expect(response.json().summary.text).toContain("pricing review");
    await app.inject({ method: "GET", url: "/api/meetings/weekly" });
    tasks.create({ title: "Another private Task" });
    await app.inject({ method: "GET", url: "/api/meetings/weekly" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("Settle the release plan");
    expect(requests[0]).not.toMatch(/PRIVATE_|FAILED_DIAGNOSTIC/);
    good.writeArtifact(
      "result.json",
      JSON.stringify({
        meetingBrief: {
          summary: "A revised release plan",
          conversationStarters: [],
          uncertainty: [],
          generatedAt: "2026-09-03T13:00:00Z",
        },
      }),
    );
    const stale = await app.inject({ method: "GET", url: "/api/meetings/weekly" });
    expect(stale.json().summary.state).toBe("stale");
    expect(requests).toHaveLength(1);
    fail = true;
    const replacement = await app.inject({
      method: "POST",
      url: "/api/meetings/weekly/regenerate",
    });
    expect(replacement.json().summary).toMatchObject({
      state: "failed",
      text: response.json().summary.text,
    });
    expect(requests).toHaveLength(2);
    await app.inject({ method: "GET", url: "/api/meetings/weekly" });
    expect(requests).toHaveLength(2);
    fail = false;
    setProvider("openrouter");
    const consentRequired = await app.inject({
      method: "POST",
      url: "/api/meetings/weekly/regenerate",
    });
    expect(consentRequired.json().summary.state).toBe("consent-required");
    expect(requests).toHaveLength(2);
    const consent = await app.inject({
      method: "POST",
      url: "/api/meetings/weekly/consent",
      payload: { provider: "openrouter", model: "deterministic" },
    });
    expect(consent.statusCode).toBe(200);
    const retry = await app.inject({ method: "POST", url: "/api/meetings/weekly/regenerate" });
    expect(retry.json().summary.state).toBe("ready");
    await app.close();
  });
  it("serves the whole deterministic week without ever spending a model call", async () => {
    const requests: string[] = [];
    const { app, meetings, tasks } = setup(async (request) => {
      requests.push(request.user);
      return { text: "Never asked for." };
    });
    meetings.upsertFromCalendar({
      occurrenceKey: "pricing",
      calendarEventId: "pricing",
      occurrenceId: "pricing",
      title: "Pricing review",
      startAt: "2026-09-04T14:00:00Z",
      endAt: "2026-09-04T15:00:00Z",
      cancelled: false,
      participants: [],
      ineligibleReason: null,
    });
    tasks.create({ title: "Overdue", dueDate: "2026-09-02" });

    const response = await app.inject({ method: "GET", url: "/api/meetings/weekly/deterministic" });

    expect(response.statusCode).toBe(200);
    const view = response.json<WeeklyWorkspaceView>();
    expect(view.meetings.map((meeting) => meeting.title)).toEqual(["Pricing review"]);
    expect(view.overdue.map((task) => task.title)).toEqual(["Overdue"]);
    expect(view.summary.state).toBe("empty");
    expect(requests).toEqual([]);
    await app.close();
  });
  it("covers Sunday through Saturday, classifies exact boundaries, and separates work", async () => {
    const { app, meetings, tasks } = setup();
    for (const [title, startAt, endAt, cancelled] of [
      ["Sunday", "2026-08-30T04:00:00Z", "2026-08-30T05:00:00Z", false],
      ["Ended now", "2026-09-03T13:00:00Z", "2026-09-03T14:00:00Z", false],
      ["Starts now", "2026-09-03T14:00:00Z", "2026-09-03T15:00:00Z", false],
      ["Saturday", "2026-09-06T03:00:00Z", "2026-09-06T03:30:00Z", false],
      ["Next Sunday", "2026-09-06T04:00:00Z", "2026-09-06T05:00:00Z", false],
      ["Cancelled", "2026-09-04T14:00:00Z", "2026-09-04T15:00:00Z", true],
    ] as const)
      meetings.upsertFromCalendar({
        occurrenceKey: title,
        calendarEventId: title,
        occurrenceId: title,
        title,
        startAt,
        endAt,
        cancelled,
        participants: [],
        ineligibleReason: null,
      });
    tasks.create({ title: "Overdue", dueDate: "2026-09-02" });
    tasks.create({ title: "Saturday work", dueDate: "2026-09-05" });
    const response = await app.inject({ method: "GET", url: "/api/meetings/weekly" });
    expect(response.statusCode).toBe(200);
    const view = response.json<WeeklyWorkspaceView>();
    expect(view.weekStart).toBe("2026-08-30");
    expect(view.weekEnd).toBe("2026-09-05");
    expect(view.meetings.map((meeting) => [meeting.title, meeting.group])).toEqual([
      ["Sunday", "completed"],
      ["Ended now", "completed"],
      ["Starts now", "in-progress"],
      ["Saturday", "upcoming"],
    ]);
    expect(view.meetings.every((meeting) => meeting.artifactStatus === "missing")).toBe(true);
    expect(view.overdue.map((task) => task.title)).toEqual(["Overdue"]);
    expect(view.dueThisWeek.map((task) => task.title)).toEqual(["Saturday work"]);
    await app.close();
  });
});

describe("the persisted Weekly Summary record", () => {
  it("stores the week, its source revisions, the fingerprint, the text, the time, the provider and the model", async () => {
    const { app, meetings, runs, workspaceDir } = setup(async () => ({
      text: "The pricing review settles the release plan.",
    }));
    const meeting = meetings.upsertFromCalendar(
      occurrence("Pricing review", "2026-09-04T14:00:00Z", "2026-09-04T15:00:00Z"),
    );
    const { run } = briefRun(runs, "Pricing review");

    const response = await app.inject({ method: "GET", url: "/api/meetings/weekly" });
    expect(response.json<WeeklyWorkspaceView>().summary.state).toBe("ready");

    const stored = JSON.parse(
      readFileSync(join(workspaceDir, "weekly", "2026-08-30.json"), "utf8"),
    ) as {
      week: string;
      fingerprint: string;
      sources: Array<{ meetingId: string; sourceId: string }>;
      summary: WeeklySummaryState;
    };
    expect(stored.week).toBe("2026-08-30");
    expect(stored.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    /* Source identity and revision: which Meeting, and which Run of it. */
    expect(stored.sources).toEqual([
      expect.objectContaining({ meetingId: meeting.id, sourceId: run.id }),
    ]);
    expect(stored.summary).toMatchObject({
      text: "The pricing review settles the release plan.",
      state: "ready",
      generatedAt: "2026-09-03T14:00:00.000Z",
      provider: "mock",
      model: "deterministic",
    });
    await app.close();
  });

  it("keeps the week and its sources on the record a failed generation writes", async () => {
    let fail = false;
    const { app, meetings, runs, workspaceDir } = setup(async () => {
      if (fail) throw new Error("provider failure");
      return { text: "The pricing review settles the release plan." };
    });
    meetings.upsertFromCalendar(
      occurrence("Pricing review", "2026-09-04T14:00:00Z", "2026-09-04T15:00:00Z"),
    );
    briefRun(runs, "Pricing review");
    await app.inject({ method: "GET", url: "/api/meetings/weekly" });

    fail = true;
    const failed = await app.inject({ method: "POST", url: "/api/meetings/weekly/regenerate" });
    expect(failed.json<WeeklyWorkspaceView>().summary.state).toBe("failed");

    const stored = JSON.parse(
      readFileSync(join(workspaceDir, "weekly", "2026-08-30.json"), "utf8"),
    ) as { week: string; sources: unknown[]; summary: WeeklySummaryState };
    expect(stored.week).toBe("2026-08-30");
    expect(stored.sources).toHaveLength(1);
    expect(stored.summary.text).toBe("The pricing review settles the release plan.");
    await app.close();
  });
});

describe("the fifteen-minute quiet period", () => {
  it("coalesces repeated source changes into one regeneration, fifteen minutes after the last", async () => {
    /* `briefRun` below writes take 1, so a revision is a change from there. */
    let revision = 1;
    const requests: string[] = [];
    const { app, meetings, runs, setNow } = setup(async (request) => {
      requests.push(request.user);
      return { text: `Revision ${requests.length} of the release plan is settled.` };
    });
    meetings.upsertFromCalendar(
      occurrence("Pricing review", "2026-09-04T14:00:00Z", "2026-09-04T15:00:00Z"),
    );
    const { revise: rewrite } = briefRun(runs, "Pricing review", "Settle the release plan, take 1");
    const revise = (): void => {
      revision += 1;
      rewrite(`Settle the release plan, take ${revision}`);
    };
    expect(
      (await app.inject({ method: "GET", url: "/api/meetings/weekly" })).json().summary.state,
    ).toBe("ready");
    expect(requests).toHaveLength(1);

    /* First change opens the window. */
    revise();
    setNow("2026-09-03T14:05:00Z");
    expect(
      (await app.inject({ method: "GET", url: "/api/meetings/weekly" })).json().summary.state,
    ).toBe("stale");

    /* A second change ten minutes in restarts it: the window runs from the latest change. */
    revise();
    setNow("2026-09-03T14:15:00Z");
    expect(
      (await app.inject({ method: "GET", url: "/api/meetings/weekly" })).json().summary.state,
    ).toBe("stale");

    /* Sixteen minutes after the first change, but only one after the last. */
    setNow("2026-09-03T14:21:00Z");
    expect(
      (await app.inject({ method: "GET", url: "/api/meetings/weekly" })).json().summary.state,
    ).toBe("stale");
    expect(requests).toHaveLength(1);

    /* Past fifteen minutes from the latest change: one regeneration for both. */
    setNow("2026-09-03T14:31:00Z");
    const regenerated = await app.inject({ method: "GET", url: "/api/meetings/weekly" });
    expect(regenerated.json<WeeklyWorkspaceView>().summary).toMatchObject({
      state: "ready",
      text: "Revision 2 of the release plan is settled.",
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("take 3");

    /* And the settled fingerprint stays settled. */
    setNow("2026-09-03T15:00:00Z");
    await app.inject({ method: "GET", url: "/api/meetings/weekly" });
    expect(requests).toHaveLength(2);
    await app.close();
  });
});

describe("the completed-Meeting Debrief projection", () => {
  it("carries only the bounded Debrief fields, never coaching, evidence or recipients", async () => {
    const requests: string[] = [];
    let meetingId: string | null = null;
    const { app, meetings, runs } = setup(
      async (request) => {
        requests.push(request.user);
        return { text: "The retro settled the rollout order." };
      },
      undefined,
      (transcriptId) => (transcriptId === "transcript-1" ? meetingId : null),
    );
    const meeting = meetings.upsertFromCalendar(
      occurrence("Retro", "2026-09-02T14:00:00Z", "2026-09-02T15:00:00Z"),
    );
    meetingId = meeting.id;
    const run = runs.create({
      module: "meeting-debrief",
      moduleVersion: 1,
      intake: "transcript",
      sourceUrl: null,
      externalId: null,
    });
    run.writeArtifact(
      "result.json",
      JSON.stringify({
        version: 1,
        transcriptId: "transcript-1",
        extractedAt: "2026-09-02T15:30:00Z",
        debrief: {
          version: 1,
          summary: "The team agreed the rollout order",
          decisions: [{ statement: "Ship the pricing page first", evidence: "Consensus at 12:04" }],
          actionItems: [
            {
              title: "Draft the rollout note",
              owner: "Alex",
              ownerMentionId: "PRIVATE_MENTION",
              ownerProfileId: "PRIVATE_PROFILE",
              dueDate: "2026-09-08",
            },
          ],
          openQuestions: [{ question: "Who signs off on pricing?", raisedBy: "Alex" }],
          effectivenessEvidence: "PRIVATE_COACHING_EVIDENCE",
          coachingAdvice: "PRIVATE_COACHING_ADVICE",
          suggestedRecipients: [{ name: "Jordan", email: "PRIVATE_RECIPIENT@example.com" }],
        },
      }),
    );
    run.finished({ status: "done" });

    const response = await app.inject({ method: "GET", url: "/api/meetings/weekly" });

    expect(response.json<WeeklyWorkspaceView>().meetings[0]).toMatchObject({
      group: "completed",
      artifactStatus: "ready",
      sourceId: run.id,
    });
    expect(requests).toHaveLength(1);
    const [sent] = JSON.parse(requests[0]) as Array<Record<string, unknown>>;
    expect(sent).toEqual({
      meetingId: meeting.id,
      title: "Retro",
      date: "2026-09-02T14:00:00Z",
      group: "completed",
      sourceId: run.id,
      summary: "The team agreed the rollout order",
      decisions: [{ statement: "Ship the pricing page first", evidence: "Consensus at 12:04" }],
      actionItems: [{ title: "Draft the rollout note", owner: "Alex", dueDate: "2026-09-08" }],
      openQuestions: [{ question: "Who signs off on pricing?", raisedBy: "Alex" }],
    });
    expect(requests[0]).not.toMatch(/PRIVATE_/);
    await app.close();
  });
});

describe("the Weekly Summary Result Shape", () => {
  it("rejects a Summary that breaks the four-sentence, one-paragraph bound", async () => {
    let overlong = false;
    const { app, meetings, runs } = setup(async () =>
      overlong
        ? {
            text: "One sentence. Two sentences. Three sentences. Four sentences. Five sentences, which is one more than the Result Shape allows.",
          }
        : { text: "The pricing review settles the release plan." },
    );
    meetings.upsertFromCalendar(
      occurrence("Pricing review", "2026-09-04T14:00:00Z", "2026-09-04T15:00:00Z"),
    );
    briefRun(runs, "Pricing review");
    const good = await app.inject({ method: "GET", url: "/api/meetings/weekly" });
    expect(good.json<WeeklyWorkspaceView>().summary.state).toBe("ready");

    overlong = true;
    const rejected = await app.inject({ method: "POST", url: "/api/meetings/weekly/regenerate" });

    expect(rejected.json<WeeklyWorkspaceView>().summary).toMatchObject({
      state: "failed",
      text: "The pricing review settles the release plan.",
    });
    await app.close();
  });

  it("rejects a Summary that runs past a hundred-odd words or breaks into paragraphs", async () => {
    const { app, meetings, runs } = setup(async () => ({
      text: `${"word ".repeat(130).trim()}.`,
    }));
    meetings.upsertFromCalendar(
      occurrence("Pricing review", "2026-09-04T14:00:00Z", "2026-09-04T15:00:00Z"),
    );
    briefRun(runs, "Pricing review");

    const response = await app.inject({ method: "GET", url: "/api/meetings/weekly" });

    expect(response.json<WeeklyWorkspaceView>().summary).toMatchObject({
      state: "failed",
      text: null,
    });
    await app.close();
  });

  it("rejects a Summary that breaks out of one paragraph", async () => {
    const { app, meetings, runs } = setup(async () => ({
      text: "The pricing review settles the release plan.\nAnd then a second paragraph.",
    }));
    meetings.upsertFromCalendar(
      occurrence("Pricing review", "2026-09-04T14:00:00Z", "2026-09-04T15:00:00Z"),
    );
    briefRun(runs, "Pricing review");

    const response = await app.inject({ method: "GET", url: "/api/meetings/weekly" });

    expect(response.json<WeeklyWorkspaceView>().summary).toMatchObject({
      state: "failed",
      text: null,
    });
    await app.close();
  });
});

describe("the Monday Weekly Briefing email", () => {
  it("sends once for the week, survives restart, and never sends twice for a later change", async () => {
    const delivery = new FakeDelivery();
    const { weekly, meetings, setNow } = setup(undefined, delivery);
    meetings.upsertFromCalendar({
      occurrenceKey: "kickoff",
      calendarEventId: "kickoff",
      occurrenceId: "kickoff",
      title: "Launch kickoff",
      startAt: "2026-09-04T14:00:00Z",
      endAt: "2026-09-04T15:00:00Z",
      cancelled: false,
      participants: [],
      ineligibleReason: null,
    });

    /* Not Monday: the schedule is a schedule, not a suggestion. */
    await weekly.sendWeeklyEmailIfDue();
    expect(delivery.sent).toEqual([]);

    setNow("2026-08-31T11:00:00Z");
    await weekly.sendWeeklyEmailIfDue();
    expect(delivery.sent).toHaveLength(1);
    expect(delivery.sent[0].subject).toBe("Weekly Briefing: week of 2026-08-30");
    expect(delivery.sent[0].text).toContain("Upcoming this week:");
    expect(delivery.sent[0].text).toContain("Launch kickoff");
    expect(delivery.sent[0].text).toContain("No Weekly Summary is available");

    /* A Meeting completing later in the week changes the tab, not the mailbox. */
    setNow("2026-09-05T11:00:00Z");
    await weekly.sendWeeklyEmailIfDue();
    expect(delivery.sent).toHaveLength(1);
  });

  it("records no success a failed send did not have, and retries into one message", async () => {
    const delivery = new FakeDelivery();
    const { weekly, meetings, setNow } = setup(undefined, delivery);
    meetings.upsertFromCalendar({
      occurrenceKey: "kickoff",
      calendarEventId: "kickoff",
      occurrenceId: "kickoff",
      title: "Launch kickoff",
      startAt: "2026-09-04T14:00:00Z",
      endAt: "2026-09-04T15:00:00Z",
      cancelled: false,
      participants: [],
      ineligibleReason: null,
    });
    setNow("2026-08-31T11:00:00Z");
    delivery.fail = true;

    await weekly.sendWeeklyEmailIfDue();
    expect(delivery.sent).toEqual([]);

    delivery.fail = false;
    await weekly.sendWeeklyEmailIfDue();
    expect(delivery.sent).toHaveLength(1);

    /* And an explicit re-send reconciles rather than duplicating. */
    await weekly.sendWeeklyEmailIfDue(true);
    expect(delivery.sent).toHaveLength(1);
  });

  it("hands the adapter no recipient at all, so only the owner can receive it", async () => {
    const delivery = new FakeDelivery();
    const { weekly, meetings, setNow } = setup(undefined, delivery);
    meetings.upsertFromCalendar(
      occurrence("Launch kickoff", "2026-09-04T14:00:00Z", "2026-09-04T15:00:00Z"),
    );
    setNow("2026-08-31T11:00:00Z");

    await weekly.sendWeeklyEmailIfDue();

    /* The Weekly path cannot address anybody: there is no field for it. The
       Gmail adapter resolves the recipient from the authenticated account, so
       the owner is the only address the message can carry. */
    expect(delivery.params).toHaveLength(1);
    expect(Object.keys(delivery.params[0]).sort()).toEqual([
      "deliveryId",
      "html",
      "subject",
      "text",
    ]);
    /* Nor can an address leak into the message by another route. */
    expect(JSON.stringify(delivery.params[0])).not.toContain("@");
  });

  it("carries the current Weekly Summary alongside the deterministic Upcoming list", async () => {
    const delivery = new FakeDelivery();
    const { weekly, meetings, runs, setNow } = setup(
      async () => ({ text: "The pricing review settles the release plan this week." }),
      delivery,
    );
    meetings.upsertFromCalendar(
      occurrence("Pricing review", "2026-09-04T14:00:00Z", "2026-09-04T15:00:00Z"),
    );
    briefRun(runs, "Pricing review");
    setNow("2026-08-31T11:00:00Z");

    await weekly.sendWeeklyEmailIfDue();

    expect(delivery.sent).toHaveLength(1);
    expect(delivery.sent[0].text).toContain(
      "The pricing review settles the release plan this week.",
    );
    expect(delivery.sent[0].text).not.toContain("No Weekly Summary is available");
    expect(delivery.sent[0].text).toContain("Upcoming this week:");
    expect(delivery.sent[0].text).toContain("Pricing review");
    expect(delivery.sent[0].text).toContain("Ready");
  });

  it("says a stale Summary is out of date rather than passing it off as current", async () => {
    const delivery = new FakeDelivery();
    /* `briefRun` below writes take 1, so a revision is a change from there. */
    let revision = 1;
    const { weekly, meetings, runs, setNow } = setup(
      async () => ({ text: "The pricing review settles the release plan this week." }),
      delivery,
    );
    meetings.upsertFromCalendar(
      occurrence("Pricing review", "2026-09-04T14:00:00Z", "2026-09-04T15:00:00Z"),
    );
    const { revise: rewrite } = briefRun(runs, "Pricing review", "Settle the release plan, take 1");
    const revise = (): void => {
      revision += 1;
      rewrite(`Settle the release plan, take ${revision}`);
    };
    setNow("2026-08-31T11:00:00Z");
    expect((await weekly.read()).summary.state).toBe("ready");

    /* A change inside the quiet period: the Summary the tab shows is the last
       good one, marked stale. The email has to say the same thing. */
    revise();
    setNow("2026-08-31T11:05:00Z");
    expect((await weekly.read()).summary.state).toBe("stale");

    await weekly.sendWeeklyEmailIfDue();

    expect(delivery.sent).toHaveLength(1);
    expect(delivery.sent[0].text).toContain(
      "The pricing review settles the release plan this week.",
    );
    expect(delivery.sent[0].text).toContain("This summary is out of date");
    /* And the deterministic Meeting list stands on its own either way. */
    expect(delivery.sent[0].text).toContain("Pricing review");
  });

  it("stays silent while the owner is unconfirmed", async () => {
    const delivery = new FakeDelivery();
    const workspaceDir = mkdtempSync(join(tmpdir(), "cos-weekly-owner-"));
    const store = new TaskStore(workspaceDir);
    const now = () => new Date("2026-08-31T11:00:00Z");
    const weekly = new WeeklyWorkspace({
      workspaceDir,
      meetings: new WorkspaceMeetings(workspaceDir, now),
      tasks: new WorkspaceTasks({ store, now }),
      actionItems: new WorkspaceActionItems({ store, now }),
      runs: openRuns(workspaceDir),
      now,
      timezone: () => "UTC",
      email: { deliver: delivery, enabled: () => true, ownerConfirmed: () => false },
    });

    await weekly.sendWeeklyEmailIfDue();

    expect(delivery.sent).toEqual([]);
  });
});
