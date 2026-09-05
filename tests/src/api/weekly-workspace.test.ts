import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { WorkspaceMeetings } from "../../../apps/server/src/meetings/store";
import { TaskStore } from "../../../apps/server/src/tasks/store";
import { WorkspaceTasks } from "../../../apps/server/src/tasks/tasks";
import { WorkspaceActionItems } from "../../../apps/server/src/tasks/action-items";
import { openRuns } from "../../../apps/server/src/runs";
import type { CompleteJson } from "../../../apps/server/src/llm/providers";
import { WeeklyWorkspace } from "../../../apps/server/src/meetings/weekly";
import type { WeeklyWorkspaceView } from "@chief-of-staff-demo/shared";

function setup(complete?: CompleteJson) {
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
    ...(complete ? { model: () => ({ provider, model: "deterministic", complete }) } : {}),
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
