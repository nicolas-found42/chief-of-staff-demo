import type { MeetingDebriefDetail, MeetingDebriefExtraction } from "@chief-of-staff-demo/shared";
import { describe, expect, it } from "vitest";
import { selectHomeActionItems } from "../../../apps/web/src/homeActionItems";

/**
 * The Meeting Wizard home lists the owner's or owner-unresolved action items
 * that are still open and not dismissed, including Debriefs not yet reviewed
 * (issue #159). Done/dismissed are the #158 read-model states: dismissed
 * never lists, local done lists only until a Google Task takes over, and a
 * Task-backed item follows the Task.
 */

const OWNER = "profile_owner";
const OTHER = "profile_other";

function extraction(
  titles: { title: string; ownerProfileId: string | null }[],
): MeetingDebriefExtraction {
  return {
    version: 1,
    summary: "summary",
    decisions: [],
    actionItems: titles.map((item) => ({
      title: item.title,
      owner: null,
      ownerMentionId: null,
      ownerProfileId: item.ownerProfileId,
      dueDate: null,
    })),
    openQuestions: [],
    effectivenessEvidence: "evidence",
    coachingAdvice: "advice",
    suggestedRecipients: [],
  };
}

function detail(
  runId: string,
  overrides: Partial<MeetingDebriefDetail> = {},
): MeetingDebriefDetail {
  return {
    runId,
    transcriptId: `transcript_${runId}`,
    meetingId: `meeting_${runId}`,
    status: "done",
    summary: null,
    skipReason: null,
    meetingDate: null,
    fileName: null,
    sourceUrl: null,
    linked: false,
    occurrence: null,
    roster: [],
    speakers: [],
    rosterStatus: "requires_confirmation",
    identity: { resolved: [], unresolved: [], organizations: [] },
    extraction: extraction([{ title: "default", ownerProfileId: null }]),
    reviewReadiness: "ready",
    review: null,
    ...overrides,
  };
}

describe("selectHomeActionItems", () => {
  it("lists the owner's and owner-unresolved items, including unreviewed Debriefs", () => {
    const details = [
      detail("reviewed", {
        extraction: extraction([
          { title: "mine", ownerProfileId: OWNER },
          { title: "unresolved", ownerProfileId: null },
          { title: "theirs", ownerProfileId: OTHER },
        ]),
        review: {
          state: "awaiting_review",
          approvedAt: null,
          roster: { status: "confirmed", confirmedAt: null, entries: [] },
          automaticRecipients: [],
          additionalRecipients: [],
          droppedActionItems: [],
          suggestedRecipients: [],
          completedActionItems: [],
          actionItemTasks: [],
          approvalBlockers: [],
          duplicateWarning: null,
        },
      }),
      detail("unreviewed", {
        review: null,
      }),
    ];
    const titles = selectHomeActionItems(details, OWNER).map((item) => item.title);
    expect(titles).toEqual(["mine", "unresolved", "default"]);
  });

  it("hides other-owned items when the owner is unconfirmed", () => {
    const details = [
      detail("run", {
        extraction: extraction([
          { title: "unresolved", ownerProfileId: null },
          { title: "resolved", ownerProfileId: OTHER },
        ]),
      }),
    ];
    expect(selectHomeActionItems(details, null).map((item) => item.title)).toEqual(["unresolved"]);
  });

  it("excludes dismissed and locally-done items", () => {
    const details = [
      detail("run", {
        extraction: extraction([
          { title: "keep", ownerProfileId: null },
          { title: "dismissed", ownerProfileId: null },
          { title: "done", ownerProfileId: null },
        ]),
        review: {
          state: "awaiting_review",
          approvedAt: null,
          roster: { status: "confirmed", confirmedAt: null, entries: [] },
          automaticRecipients: [],
          additionalRecipients: [],
          droppedActionItems: [1],
          suggestedRecipients: [],
          completedActionItems: [2],
          actionItemTasks: [],
          approvalBlockers: [],
          duplicateWarning: null,
        },
      }),
    ];
    expect(selectHomeActionItems(details, OWNER).map((item) => item.title)).toEqual(["keep"]);
  });

  it("follows the Google Task once one exists, locally-done fallback otherwise", () => {
    const details = [
      detail("run", {
        extraction: extraction([
          { title: "task-open-despite-local", ownerProfileId: null },
          { title: "task-done", ownerProfileId: null },
        ]),
        review: {
          state: "approved",
          approvedAt: null,
          roster: { status: "confirmed", confirmedAt: null, entries: [] },
          automaticRecipients: [],
          additionalRecipients: [],
          droppedActionItems: [],
          suggestedRecipients: [],
          completedActionItems: [0],
          actionItemTasks: [
            { index: 0, taskId: "task_0", completed: false },
            { index: 1, taskId: "task_1", completed: true },
          ],
          approvalBlockers: [],
          duplicateWarning: null,
        },
      }),
    ];
    expect(selectHomeActionItems(details, OWNER).map((item) => item.title)).toEqual([
      "task-open-despite-local",
    ]);
  });

  it("carries the Meeting each item came from", () => {
    const details = [detail("run", { meetingId: "meeting_7" })];
    const items = selectHomeActionItems(details, OWNER);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ runId: "run", meetingId: "meeting_7", index: 0 });
  });
});
