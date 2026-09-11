import { debriefPreviewInput } from "../helpers/debrief-preview";
import { WorkspaceActionItems } from "../../../apps/server/src/tasks/action-items";
import { TaskStore } from "../../../apps/server/src/tasks/store";
import { materializationIndex } from "../../../apps/server/src/tasks/materialization";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MEETING_DEBRIEF_MODULE_ID,
  type IdentityDecision,
  type TranscriptMention,
  type TranscriptRecord,
} from "@chief-of-staff-demo/shared";
import { MeetingDebriefHost } from "../../../apps/server/src/modules/meeting-debrief/host";
import type {
  DebriefDraft,
  DebriefExtractInput,
  DebriefIdentityReview,
} from "../../../apps/server/src/modules/meeting-debrief/deps";
import { workspaceProfileDirectory } from "../../../apps/server/src/modules/meeting-debrief/profiles";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles";
import { openRuns, type Runs } from "../../../apps/server/src/runs";

const OWNER_EMAIL = "owner@example.com";

function makeRecord(): TranscriptRecord {
  return {
    id: "drive_outputsA_r1",
    source: {
      sourceSystem: "drive",
      externalFileId: "outputsA",
      fileName: "Weekly sync - 2026-08-17T13-00-00.000Z.md",
      sourceUrl: null,
      checksum: "deadbeef",
      observedRevision: 1,
      modifiedAt: null,
    },
    ingestedAt: "2026-08-31T12:00:00.000Z",
    extractorVersion: 1,
    normalizedText: "Alice: We decided to ship on Friday.\n",
    meetingDate: "2026-08-17",
    occurrence: {
      occurrenceKey: "evt_outputsA:2026-08-17T13:00:00.000Z",
      calendarEventId: "evt_outputsA",
    },
    speakers: ["Alice"],
    speakerIdentityMappings: [],
    meetingId: null,
    association: null,
    roster: [
      { displayName: "Owner", email: OWNER_EMAIL },
      { displayName: "Alice", email: "alice@example.com" },
    ],
  };
}

/* The Catalog's identity review: one mention, linked by an owner decision to
   the Workspace owner's Profile. That decision is the only thing that can put
   a Profile id on an action item — a model's guess never survives. */
const OWNER_MENTION_ID = "mention_owner";
let identityReview: DebriefIdentityReview = {
  mentions: [],
  decisions: [],
  organizations: [],
};

function ownerLinkedIdentity(profileId: string): DebriefIdentityReview {
  const mention: TranscriptMention = {
    id: OWNER_MENTION_ID,
    kind: "person",
    surfaceText: "Owner",
    normalizedForms: ["owner"],
    emails: [OWNER_EMAIL],
    profileUrls: [],
    verifiedHandles: {},
    externalContactIds: [],
    speakerCalendarEmail: OWNER_EMAIL,
    titles: [],
    roles: [],
    aliases: [],
    relationshipAssertions: [],
    rosterContext: [],
    organizationContext: null,
    attendeeStatus: "speaker",
    confidence: "high",
    minedAt: "2026-08-31T12:00:00.000Z",
    algorithmVersion: 1,
    provenance: {
      transcriptId: "drive_outputsA_r1",
      spanStart: 0,
      spanEnd: 5,
      quote: "Alice",
      timestamp: null,
      speakerLabel: "Alice",
      meetingDate: "2026-08-17",
    },
  };
  const decision: IdentityDecision = {
    id: "decision_owner",
    mentionId: OWNER_MENTION_ID,
    transcriptId: "drive_outputsA_r1",
    action: "confirm",
    outcome: "linked",
    profileId,
    profileRevision: 1,
    decidedBy: "owner",
    decidedAt: "2026-08-31T12:00:00.000Z",
    note: null,
    mappingAuthority: null,
  };
  return { mentions: [mention], decisions: [decision], organizations: [] };
}

function fakeExtraction(input: DebriefExtractInput) {
  return {
    version: 1 as const,
    summary: `Review of ${input.record.source.fileName}`,
    decisions: [{ statement: "Ship on Friday", evidence: null }],
    actionItems: [
      /* Confidently the owner's: the Catalog linked its mention to the
         owner's Profile. This one becomes a Task. */
      {
        title: "Send the release note",
        owner: "Owner",
        ownerMentionId: OWNER_MENTION_ID,
        ownerProfileId: null,
        dueDate: "2026-08-21",
      },
      /* Named, but the Catalog resolved nothing. An unresolved owner is not
         the Workspace owner, so it creates no Task. */
      {
        title: "Follow up with Alice",
        owner: "Alice",
        ownerMentionId: null,
        ownerProfileId: null,
        dueDate: null,
      },
    ],
    openQuestions: [],
    effectivenessEvidence: "Decisions were made crisply.",
    coachingAdvice: "Close open questions before the next sync.",
    suggestedRecipients: [] as Array<{ name: string; email: string | null }>,
  };
}

/**
 * Records what the Module asked the outward surface to do, in order. A fake at
 * the port, not a mock of an internal: the assertions are about what reached
 * the boundary, never about how the Module got there.
 */
function recordingOutputs(): {
  drafts: DebriefDraft[];
  /** Set to make the next Gmail write fail, the way a real one can. */
  failNext: boolean;
  createDraft: (d: DebriefDraft) => Promise<string>;
} {
  const drafts: DebriefDraft[] = [];
  const outputs = {
    drafts,
    failNext: false,
    createDraft: (draft: DebriefDraft) => {
      if (outputs.failNext) {
        outputs.failNext = false;
        return Promise.reject(new Error("Gmail refused the draft"));
      }
      drafts.push(draft);
      return Promise.resolve(`draft_${drafts.length}`);
    },
  };
  return outputs;
}

interface Harness {
  actionItems: WorkspaceActionItems;
  runs: Runs;
  host: MeetingDebriefHost;
  people: WorkspacePersonProfiles;
  catalog: Map<string, TranscriptRecord>;
  app: FastifyInstance;
  outputs: ReturnType<typeof recordingOutputs>;
}

let h: Harness;
let unavailableReview = false;
let revisedSummary: string | null = null;

beforeEach(() => {
  unavailableReview = false;
  revisedSummary = null;
  const workspaceDir = mkdtempSync(join(tmpdir(), "meeting-debrief-outputs-"));
  const runs = openRuns(workspaceDir);
  const actionItems = new WorkspaceActionItems({ store: new TaskStore(workspaceDir) });
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(workspaceDir),
    lifecycle: [],
  });
  const catalog = new Map<string, TranscriptRecord>();
  const outputs = recordingOutputs();
  identityReview = { mentions: [], decisions: [], organizations: [] };
  const host = new MeetingDebriefHost({
    materializeActionItems: (input) => {
      /* The coordinated materialization (#358) answers with the exact
         mappings each checked entry became; the publication's manifest
         records them and completion refuses to claim a count it cannot see. */
      const mapped = actionItems.materialize(input);
      return [...materializationIndex(mapped).values()].filter(
        (mapping) => mapping.debriefRunId === input.debriefRunId,
      );
    },
    readActionItems: (input) => {
      if (unavailableReview) throw new Error("Tasks reader unavailable");
      return actionItems.forExtraction(input);
    },
    runs,
    catalog: { getTranscript: (id) => catalog.get(id) ?? null },
    identity: { reviewFor: () => identityReview },
    extract: (input) =>
      Promise.resolve({
        ...fakeExtraction(input),
        ...(revisedSummary ? { summary: revisedSummary } : {}),
      }),
    profiles: workspaceProfileDirectory(people),
    ownerEmail: () => OWNER_EMAIL,
    outputs: { createDraft: outputs.createDraft },
    log: () => {},
  });
  const app = fastify({ logger: false });
  host.routes(app);
  h = { runs, host, people, catalog, app, outputs, actionItems };
});

function anchoredProfile(fullName: string, email: string): void {
  const { profile } = h.people.ensureCalendarAttendeeProfile({
    email: email.trim().toLowerCase(),
    provenance: "unit test — Calendar attendee",
  });
  h.people.correct(profile.id, { fullName });
}

async function startRun(record: TranscriptRecord): Promise<string> {
  h.catalog.set(record.id, record);
  await h.host.process(record);
  await h.host.idle();
  return h.runs.list({ module: MEETING_DEBRIEF_MODULE_ID }).runs[0].id;
}

describe("Meeting Debrief outward writes (#141)", () => {
  it("writes nothing outward until terminal approval, then creates exactly one Gmail draft", async () => {
    anchoredProfile("Owner", OWNER_EMAIL);
    anchoredProfile("Alice", "alice@example.com");
    const runId = await startRun(makeRecord());

    const roster = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/roster`,
      payload: {
        entries: [
          { email: OWNER_EMAIL, displayName: "Owner" },
          { email: "alice@example.com", displayName: "Alice" },
        ],
      },
    });
    expect(roster.statusCode).toBe(200);

    /* Extracted, reviewed, roster confirmed — everything short of approval.
       The outward surface has not been touched. */
    expect(h.outputs.drafts).toEqual([]);

    const approved = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/approve`,
      payload: await debriefPreviewInput(h.app, runId),
    });
    expect(approved.statusCode).toBe(200);
    await h.host.idle();

    /* Approval is the sole transition to outward writes, and it creates one
       draft — not one per recipient, and not one per approval attempt. */
    expect(h.outputs.drafts).toHaveLength(1);
  });
});

describe("Meeting Debrief approval outputs — Tasks and retry (#141)", () => {
  /** Roster-confirm helper: everything up to, but not including, approval. */
  async function readyToApprove(): Promise<string> {
    const { profile } = h.people.ensureCalendarAttendeeProfile({
      email: OWNER_EMAIL,
      provenance: "unit test — Calendar attendee",
    });
    h.people.correct(profile.id, { fullName: "Owner" });
    anchoredProfile("Alice", "alice@example.com");
    identityReview = ownerLinkedIdentity(profile.id);
    const runId = await startRun(makeRecord());
    const roster = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/roster`,
      payload: {
        entries: [
          { email: OWNER_EMAIL, displayName: "Owner" },
          { email: "alice@example.com", displayName: "Alice" },
        ],
      },
    });
    expect(roster.statusCode).toBe(200);
    return runId;
  }

  async function approve(runId: string): Promise<{ statusCode: number }> {
    return h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/approve`,
      payload: await debriefPreviewInput(h.app, runId),
    });
  }

  it("creates a Gmail draft and no Task at all", async () => {
    const runId = await readyToApprove();
    await approve(runId);
    await h.host.idle();

    /* Issue #182: the action is email-only. It used to create Google Tasks
       for the owner's own actions too, which made one button mean two
       unrelated things — accepted work now comes from the Action Item queue,
       which needs no Gmail. */
    expect(h.outputs.drafts).toHaveLength(1);
    /* The outward surface has no Task seam left to reach for (issue #199). */
    expect(h.outputs).not.toHaveProperty("createTask");
  });

  it("offers the created draft in Gmail, and never reports it as sent", async () => {
    const runId = await readyToApprove();
    await approve(runId);
    await h.host.idle();

    const served = await h.app.inject({ method: "GET", url: `/api/meeting-debrief/${runId}` });
    const review = served.json<{
      review: { draft: { draftId: string; url: string; recipientCount: number } | null };
    }>().review;
    expect(review.draft?.draftId).toBe("draft_1");
    expect(review.draft?.url).toContain("mail.google.com");
    /* One recipient: the roster's confirmed attendee other than the owner. */
    expect(review.draft?.recipientCount).toBe(1);
  });

  it("leaves review state untouched when Gmail refuses, and retries into one draft", async () => {
    const runId = await readyToApprove();
    const before = await h.app.inject({ method: "GET", url: `/api/meeting-debrief/${runId}` });
    const reviewBefore = before.json<{ review: { draft: unknown; review: unknown } }>().review;

    h.outputs.failNext = true;
    await approve(runId);
    await h.host.idle();

    /* Nothing reached Gmail, and nothing pretends it did. */
    expect(h.outputs.drafts).toHaveLength(0);
    const failed = await h.app.inject({ method: "GET", url: `/api/meeting-debrief/${runId}` });
    const reviewAfter = failed.json<{ review: { draft: unknown; review: unknown } }>().review;
    expect(reviewAfter.draft).toBeNull();
    expect(failed.json().review.state).toBe("extracted");
    /* The Action Item decisions the owner made are exactly as they were: a
       recipient problem is not allowed to touch accepted work (issue #182). */
    expect(reviewAfter.review).toEqual(reviewBefore.review);

    /* A refused Gmail write fails the Run rather than half-approving it, and
       the approval is not repeatable while it stands. */
    expect((await approve(runId)).statusCode).toBe(409);

    /* Retry, the way the Run list offers it: one draft, because the attempt
       that failed wrote no receipt to be counted twice. */
    await h.host.retryRun(runId);
    await h.host.idle();
    expect(h.outputs.drafts).toHaveLength(1);
    const served = await h.app.inject({ method: "GET", url: `/api/meeting-debrief/${runId}` });
    expect(
      served.json<{ review: { draft: { draftId: string } | null } }>().review.draft,
    ).toMatchObject({ draftId: "draft_1" });

    /* And there is nothing left to retry: the Run succeeded, so a second
       attempt cannot draft a second time. */
    await expect(h.host.retryRun(runId)).rejects.toThrow(/not retryable/);
    expect(h.outputs.drafts).toHaveLength(1);
  });

  it("drafts nothing twice when the action is repeated", async () => {
    const runId = await readyToApprove();
    await approve(runId);
    await h.host.idle();

    await approve(runId);
    await h.host.idle();

    expect(h.outputs.drafts).toHaveLength(1);
  });
});

describe("Meeting Debrief action-item lifecycle (#158)", () => {
  /** Roster-confirm helper: everything up to, but not including, approval. */
  async function readyToApprove(): Promise<string> {
    const { profile } = h.people.ensureCalendarAttendeeProfile({
      email: OWNER_EMAIL,
      provenance: "unit test — Calendar attendee",
    });
    h.people.correct(profile.id, { fullName: "Owner" });
    const alice = h.people.ensureCalendarAttendeeProfile({
      email: "alice@example.com",
      provenance: "unit test — Calendar attendee",
    });
    h.people.correct(alice.profile.id, { fullName: "Alice" });
    identityReview = ownerLinkedIdentity(profile.id);
    const runId = await startRun(makeRecord());
    const roster = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/roster`,
      payload: {
        entries: [
          { email: OWNER_EMAIL, displayName: "Owner" },
          { email: "alice@example.com", displayName: "Alice" },
        ],
      },
    });
    expect(roster.statusCode).toBe(200);
    return runId;
  }

  async function approve(runId: string): Promise<{ statusCode: number }> {
    return h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/approve`,
      payload: await debriefPreviewInput(h.app, runId),
    });
  }

  it("creates no Task at all when the whole Debrief is published (#182, #199)", async () => {
    const runId = await readyToApprove();

    expect((await approve(runId)).statusCode).toBe(200);
    await h.host.idle();

    /* Publication is the email draft and nothing else. Accepted work is a
       canonical Task, promoted from an Action Item one decision at a time —
       never a bulk write the whole Debrief performs on the owner's behalf,
       and no receipt of one is written either. */
    expect(h.outputs.drafts).toHaveLength(1);
    expect(h.runs.open(runId)!.readArtifact("tasks.json")).toBeNull();
  });

  it("offers no positional decision that could have excluded an item from one", async () => {
    const runId = await readyToApprove();

    for (const verb of ["drop", "done", "dismiss"]) {
      const response = await h.app.inject({
        method: "POST",
        url: `/api/meeting-debrief/${runId}/action-items/0/${verb}`,
      });
      expect(response.statusCode).toBe(404);
    }
  });
});

describe("preview-bound draft creation (#327)", () => {
  it("previews explicit selections without output and creates exactly the reviewed draft", async () => {
    anchoredProfile("Owner", OWNER_EMAIL);
    anchoredProfile("Alice", "alice@example.com");
    const runId = await startRun(makeRecord());
    await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/roster`,
      payload: { entries: [{ email: OWNER_EMAIL }, { email: "alice@example.com" }] },
    });
    const candidates = await h.app.inject({
      method: "GET",
      url: `/api/meeting-debrief/${runId}/email`,
    });
    expect(candidates.statusCode).toBe(200);
    const options = candidates.json().candidates as { id: string; title: string }[];
    const selected = options.find((candidate) => candidate.title === "Follow up with Alice")!;
    const response = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/preview`,
      payload: { selectedIds: [selected.id] },
    });
    expect(response.statusCode).toBe(200);
    const preview = response.json();
    expect(preview.body).toContain("Follow up with Alice — Alice");
    expect(preview.body).not.toContain("Send the release note");
    expect(preview.body).not.toContain("Close open questions before the next sync");
    expect(h.outputs.drafts).toEqual([]);
    const creation = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/approve`,
      payload: { selectedIds: [selected.id], revision: preview.revision },
    });
    expect(creation.statusCode).toBe(200);
    await h.host.idle();
    expect(h.outputs.drafts).toEqual([
      { subject: preview.subject, body: preview.body, to: preview.to },
    ]);
  });
});

describe("canonical email inclusion (#327)", () => {
  it("uses stable canonical decisions for defaults and labels omitted proposals as earlier", async () => {
    const runId = await startRun(makeRecord());
    const items = h.actionItems.list({ debriefRunId: runId });
    h.actionItems.dismiss(items[0].id);
    const response = await h.app.inject({
      method: "GET",
      url: `/api/meeting-debrief/${runId}/email`,
    });
    expect(response.statusCode).toBe(200);
    const options = response.json();
    expect(options.unavailableReview).toBe(false);
    expect(options.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: items[0].id,
          reviewState: "dismissed",
          includedByDefault: false,
          earlier: false,
        }),
        expect.objectContaining({
          id: items[1].id,
          reviewState: "pending",
          includedByDefault: true,
          earlier: false,
        }),
      ]),
    );
  });
});

describe("preview concurrency (#327)", () => {
  it("requires a preview and refuses changed recipients without producing output", async () => {
    anchoredProfile("Owner", OWNER_EMAIL);
    anchoredProfile("Alice", "alice@example.com");
    const runId = await startRun(makeRecord());
    const roster = (entries: { email: string }[]) =>
      h.app.inject({
        method: "POST",
        url: `/api/meeting-debrief/${runId}/roster`,
        payload: { entries },
      });
    await roster([{ email: OWNER_EMAIL }, { email: "alice@example.com" }]);
    expect(
      (await h.app.inject({ method: "POST", url: `/api/meeting-debrief/${runId}/approve` }))
        .statusCode,
    ).toBe(409);
    const preview = (
      await h.app.inject({
        method: "POST",
        url: `/api/meeting-debrief/${runId}/preview`,
        payload: { selectedIds: [] },
      })
    ).json();
    await roster([{ email: "alice@example.com" }]);
    const created = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/approve`,
      payload: { selectedIds: [], revision: preview.revision },
    });
    expect(created.statusCode).toBe(409);
    expect(created.json().error).toBe("stale-preview");
    expect(h.outputs.drafts).toEqual([]);
  });
});

describe("historical email candidates (#327)", () => {
  it("retains an omitted earlier proposal for explicit inclusion using its original wording", async () => {
    const runId = await startRun(makeRecord());
    h.actionItems.materialize({
      debriefRunId: runId,
      transcriptId: makeRecord().id,
      meetingId: null,
      actionItems: [
        {
          title: "Earlier release commitment",
          owner: "Alice",
          ownerProfileId: null,
          ownerMentionId: null,
          dueDate: "2026-08-20",
        },
      ],
    });
    const options = (
      await h.app.inject({ method: "GET", url: `/api/meeting-debrief/${runId}/email` })
    ).json<import("@chief-of-staff-demo/shared").MeetingDebriefEmailOptions>();
    const earlier = options.candidates.find(
      (candidate: { title: string }) => candidate.title === "Earlier release commitment",
    );
    expect(earlier).toMatchObject({
      earlier: true,
      includedByDefault: false,
      owner: "Alice",
      dueDate: "2026-08-20",
    });
    const preview = await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/preview`,
      payload: { selectedIds: [earlier!.id] },
    });
    expect(preview.json().body).toContain("Earlier release commitment — Alice (due 2026-08-20)");
    expect(h.outputs.drafts).toEqual([]);
  });
});

describe("explicit email choices and concurrent commands (#327)", () => {
  async function ready() {
    anchoredProfile("Owner", OWNER_EMAIL);
    anchoredProfile("Alice", "alice@example.com");
    const runId = await startRun(makeRecord());
    await h.app.inject({
      method: "POST",
      url: `/api/meeting-debrief/${runId}/roster`,
      payload: { entries: [{ email: OWNER_EMAIL }, { email: "alice@example.com" }] },
    });
    return runId;
  }
  it("discloses unavailable review without interpreting it as dismissed, then honors explicit inclusion", async () => {
    const runId = await ready();
    unavailableReview = true;
    const options = (
      await h.app.inject({ method: "GET", url: `/api/meeting-debrief/${runId}/email` })
    ).json<import("@chief-of-staff-demo/shared").MeetingDebriefEmailOptions>();
    expect(options.unavailableReview).toBe(true);
    expect(options.candidates.every((candidate) => candidate.reviewState === "unavailable")).toBe(
      true,
    );
    const selectedIds = [options.candidates[1].id];
    const preview = (
      await h.app.inject({
        method: "POST",
        url: `/api/meeting-debrief/${runId}/preview`,
        payload: { selectedIds },
      })
    ).json<import("@chief-of-staff-demo/shared").MeetingDebriefEmailPreview>();
    expect(preview.unavailableReview).toBe(true);
    expect(preview.body).toContain("Follow up with Alice");
    expect(preview.body).not.toContain("Send the release note");
    expect(
      (
        await h.app.inject({
          method: "POST",
          url: `/api/meeting-debrief/${runId}/approve`,
          payload: { selectedIds, revision: preview.revision },
        })
      ).statusCode,
    ).toBe(200);
    await h.host.idle();
    expect(h.outputs.drafts).toEqual([
      { subject: preview.subject, body: preview.body, to: preview.to },
    ]);
  });
  it("rejects a preview after regeneration and preserves explicit compatible choices for the replacement", async () => {
    const runId = await ready();
    const input = await debriefPreviewInput(h.app, runId);
    revisedSummary = "The updated meeting summary.";
    expect(
      (
        await h.app.inject({
          method: "POST",
          url: `/api/meeting-debrief/${runId}/regenerate`,
          payload: { field: "summary" },
        })
      ).statusCode,
    ).toBe(200);
    await h.host.idle();
    expect(
      (
        await h.app.inject({
          method: "POST",
          url: `/api/meeting-debrief/${runId}/approve`,
          payload: input,
        })
      ).statusCode,
    ).toBe(409);
    expect(h.outputs.drafts).toEqual([]);
    const replacement = (
      await h.app.inject({
        method: "POST",
        url: `/api/meeting-debrief/${runId}/preview`,
        payload: { selectedIds: input.selectedIds },
      })
    ).json<import("@chief-of-staff-demo/shared").MeetingDebriefEmailPreview>();
    expect(replacement.selectedIds).toEqual(input.selectedIds);
    expect(replacement.body).toContain("The updated meeting summary.");
    expect(replacement.revision).not.toBe(input.revision);
  });
  it("reserves one creation when two final submissions arrive together", async () => {
    const runId = await ready();
    const payload = await debriefPreviewInput(h.app, runId);
    const responses = await Promise.all(
      [0, 1].map(() =>
        h.app.inject({ method: "POST", url: `/api/meeting-debrief/${runId}/approve`, payload }),
      ),
    );
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    await h.host.idle();
    expect(h.outputs.drafts).toHaveLength(1);
  });
});
